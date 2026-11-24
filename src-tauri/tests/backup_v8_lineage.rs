//! UX-04：同一 Schema 血统的 v8 备份 → v9 的端到端恢复。
//!
//! 证据边界：数据库由**正式迁移链**建到 v8（不是改 user_version 冒充），
//! manifest 被改写成历史 snake_case 形状并去掉时区/高水位/总计。
//! 数据是构造的——因此它证明「迁移链 + 恢复链路 + 旧字段兼容」，
//! **不证明**某台旧机器上真实导出的备份可用。两者分开记录。

mod common;

use std::fs;
use std::io::{Read, Write};
use std::path::Path;

use minidesk::backup::{create, restore, zip_read};
use minidesk::store::environment::Environment;
use minidesk::store::highwater::{HighWater, YearWatermark};
use minidesk::store::migrations;

fn sha_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
}

/// 造一个 v8 库：2 客户、3 订单（完成 / 进行中 / 取消）、阶段、3 条事件、
/// 2 张附件（真文件）、工作设置。
fn seed_v8(root: &Path) -> Environment {
    let env = Environment::open_with(root, &migrations::production(), 8, Some(common::tz()))
        .unwrap();
    let conn = env.open_db().unwrap();
    let now = "2026-11-10T02:00:00+08:00";

    conn.execute_batch(&format!(
        r#"
-- 订单与阶段互相引用（当前阶段指向阶段行），种子阶段先关外键，插完再开。
PRAGMA foreign_keys = OFF;
INSERT INTO clients (id, display_name, contact, note, revision, created_at, updated_at)
VALUES ('c1','林小满','wx: lin','老客户',2,'2026-09-01T00:00:00+08:00','{now}'),
       ('c2','周迟',NULL,NULL,0,'2026-09-02T00:00:00+08:00','{now}');
INSERT INTO orders (id, code, title, client_id, amount_cents, status, stage_template_id,
                    current_stage_id, queue_position, planned_start_date, planned_delivery_date,
                    started_at, completed_at, cancelled_at, revision, created_at, updated_at, source)
VALUES ('o1','AF-2026-0007','双人插画','c1',180000,'complete',
        (SELECT id FROM stage_templates WHERE is_default = 1),'s3',0,'2026-10-01','2026-10-20',
        '2026-10-01T10:00:00+08:00','2026-10-20T18:00:00+08:00',NULL,4,'2026-09-20T09:00:00+08:00','{now}','米画师'),
       ('o2','AF-2026-0011','封面绘制','c1',90000,'active',
        (SELECT id FROM stage_templates WHERE is_default = 1),'s2',1,'2026-11-01','2026-11-30',
        NULL,NULL,NULL,2,'2026-10-25T09:00:00+08:00','{now}',NULL),
       ('o3','AF-2025-0003','旧年委托','c2',50000,'cancelled',
        (SELECT id FROM stage_templates WHERE is_default = 1),'s1',2,NULL,NULL,
        NULL,NULL,'2025-12-15T09:00:00+08:00',1,'2025-12-01T09:00:00+08:00','{now}',NULL);
INSERT INTO order_stages (order_id, stage_id, title, position)
VALUES ('o1','s1','草稿',0), ('o1','s2','线稿',1), ('o1','s3','上色',2),
       ('o2','s1','草稿',0), ('o2','s2','线稿',1),
       ('o3','s1','草稿',0);
INSERT INTO order_events (order_id, kind, to_status, occurred_at, request_id)
VALUES ('o1','created','active','2026-09-20T09:00:00+08:00','r1'),
       ('o1','completed','complete','2026-10-20T18:00:00+08:00','r2'),
       ('o2','rescheduled',NULL,'2026-10-30T09:00:00+08:00','r3');
PRAGMA foreign_keys = ON;
"#
    ))
    .unwrap();

    // 附件：rel_path 必须带 attachments/ 前缀，与包内条目一一对应。
    let gen = env.active_generation().to_string();
    let dir = env.layout().attachments_dir(&gen);
    fs::create_dir_all(dir.join("originals")).unwrap();
    fs::create_dir_all(dir.join("thumbs")).unwrap();
    let a1 = b"fake-png-original-1";
    let a2 = b"fake-jpeg-original-2";
    fs::write(dir.join("originals/af1.png"), a1).unwrap();
    fs::write(dir.join("thumbs/af1.png"), b"thumb1").unwrap();
    fs::write(dir.join("originals/af2.jpg"), a2).unwrap();
    fs::write(dir.join("thumbs/af2.jpg"), b"thumb2").unwrap();
    conn.execute(
        "INSERT INTO attachments (id, order_id, original_name, rel_path, thumb_rel_path, mime_type,
                                 byte_size, sha256, state, created_at)
         VALUES ('a1','o1','af1.png','attachments/originals/af1.png','attachments/thumbs/af1.png','image/png',?,?,'ok',?),
                ('a2','o1','af2.jpg','attachments/originals/af2.jpg','attachments/thumbs/af2.jpg','image/jpeg',?,?,'ok',?)",
        rusqlite::params![a1.len() as i64, sha_hex(a1), now, a2.len() as i64, sha_hex(a2), now],
    )
    .unwrap();

    minidesk::store::settings::set_working_timezone(&conn, "Asia/Shanghai", now).unwrap();
    drop(conn);
    env
}

/// 只重写 manifest：保留包内所有条目（含附件），改成历史 snake_case 形状。
fn rewrite_manifest_to_legacy(zip_path: &Path) {
    let mut archive = zip::ZipArchive::new(fs::File::open(zip_path).unwrap()).unwrap();
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).unwrap();
        let name = entry.name().unwrap().to_string();
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).unwrap();
        entries.push((name, buf));
    }
    drop(archive);

    let idx = entries.iter().position(|(n, _)| n == "manifest.json").unwrap();
    let modern: serde_json::Value = serde_json::from_slice(&entries[idx].1).unwrap();
    let get = |k: &str| modern.get(k).cloned().unwrap_or(serde_json::Value::Null);
    let legacy = serde_json::json!({
        "format": get("format"),
        "format_version": get("formatVersion"),
        "app_version": get("appVersion"),
        "schema_version": get("schemaVersion"),
        "created_at": get("createdAt"),
        "files": get("files"),
    });
    entries[idx].1 = serde_json::to_vec(&legacy).unwrap();

    let mut writer = zip::ZipWriter::new(fs::File::create(zip_path).unwrap());
    for (name, bytes) in entries {
        let opts: zip::write::FileOptions<()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        writer.start_file(name, opts).unwrap();
        writer.write_all(&bytes).unwrap();
    }
    writer.finish().unwrap();
}

fn counts(env: &Environment) -> (i64, i64, i64, i64) {
    let conn = env.open_db().unwrap();
    let q = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
    (
        q("SELECT COUNT(*) FROM orders"),
        q("SELECT COUNT(*) FROM clients"),
        q("SELECT COUNT(*) FROM order_events"),
        q("SELECT COUNT(*) FROM attachments"),
    )
}

#[test]
fn constructed_v8_backup_restores_end_to_end() {
    let dir = tempfile::tempdir().unwrap();
    let env = seed_v8(&dir.path().join("src"));
    let hw = HighWater::open(&env.layout().highwater_db()).unwrap();
    hw.merge(&[
        YearWatermark { year: 2026, last_allocated: 11 },
        YearWatermark { year: 2025, last_allocated: 3 },
    ])
    .unwrap();

    let zip = dir.path().join("v8.zip");
    create::create(&env, &hw, &zip).unwrap();

    let modern = zip_read::inspect(&zip).unwrap();
    assert_eq!(modern.manifest.schema_version, 8, "必须是 v8 库打的包");
    assert!(!modern.manifest.number_high_water.is_empty());
    rewrite_manifest_to_legacy(&zip);

    let report = zip_read::inspect(&zip).unwrap();
    assert!(report.manifest.working_timezone.is_none());
    assert!(report.manifest.number_high_water.is_empty());
    assert_eq!(report.manifest.total_files, report.manifest.files.len());

    let dst = common::open(&dir.path().join("dst"));
    let dst_hw = HighWater::open(&dst.layout().highwater_db()).unwrap();
    let restored = restore::restore(&dst, &dst_hw, &zip, &migrations::production()).unwrap();

    // 恢复会切到新代际，且旧句柄还握着单实例锁：先释放再重新打开。
    drop(dst);
    let after = common::open(&dir.path().join("dst"));
    let conn = after.open_db().unwrap();
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(version, migrations::APP_SCHEMA_VERSION);
    assert_eq!(counts(&after), (3, 2, 3, 2));
    assert_eq!(restored.summary.orders, 3);

    let (title, status, client, delivery): (String, String, String, String) = conn
        .query_row(
            "SELECT o.title, o.status, o.client_id, o2.planned_delivery_date
             FROM orders o JOIN orders o2 ON o2.id = 'o2' WHERE o.code = 'AF-2026-0007'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!((title.as_str(), status.as_str(), client.as_str()), ("双人插画", "complete", "c1"));
    assert_eq!(delivery, "2026-11-30", "历史日期必须原样保留");

    let archived: Option<String> = conn
        .query_row("SELECT archived_at FROM orders_visible WHERE id='o1'", [], |r| r.get(0))
        .unwrap();
    assert!(archived.is_none(), "v9 新列在视图里可读");

    let gen_dir = after.layout().attachments_dir(&after.active_generation());
    for (rel, want) in [
        ("originals/af1.png", sha_hex(b"fake-png-original-1")),
        ("originals/af2.jpg", sha_hex(b"fake-jpeg-original-2")),
    ] {
        let got = sha_hex(&fs::read(gen_dir.join(rel)).unwrap());
        assert_eq!(got, want, "{rel} 哈希不一致");
    }
    assert_eq!(restored.summary.attachments, 2);

    assert_eq!(dst_hw.peek(2026).unwrap(), Some(11), "高水位按库内编号重建");
    assert_eq!(dst_hw.peek(2025).unwrap(), Some(3));

    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
    assert_eq!(integrity, "ok");

    assert!(
        restored.warnings.iter().any(|w| w.contains("工作时区")),
        "{:?}",
        restored.warnings
    );
    assert_eq!(
        minidesk::store::settings::working_timezone(&conn).unwrap().name(),
        minidesk::store::timezone::system_timezone().name()
    );
}

#[test]
fn failed_restore_leaves_existing_data_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let dst = common::open(&dir.path().join("dst"));
    {
        let mut conn = dst.open_db().unwrap();
        common::insert_order(&mut conn, "AF-2026-0900", "现有订单");
    }
    let before = counts(&dst);
    let bad = dir.path().join("bad.zip");
    fs::write(&bad, b"not a zip").unwrap();
    let hw = HighWater::open(&dst.layout().highwater_db()).unwrap();
    let err = restore::restore(&dst, &hw, &bad, &migrations::production()).expect_err("必须失败");
    assert!(err.code == "ZIP" || err.code == "SCHEMA", "{}", err.code);
    assert_eq!(counts(&dst), before, "失败不得改动现有数据");
}
