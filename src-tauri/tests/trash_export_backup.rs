//! Step 5 回归：回收站数据的导出口径、摘要统计与备份完整性。
//!
//! 三件事必须同时成立，缺一条都算失败：
//! 1. 业务 CSV 默认看不见回收站，但显式勾选后能导出并标注「已删除 · 原状态」；
//! 2. `DataSummary` 把总数与回收站分开报，不混成一个数；
//! 3. 完整备份**不裁剪**回收站——订单、客户、历史事件、附件关联都要能在恢复后还在。

mod common;

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use minidesk::backup::{create, manifest, restore};
use minidesk::domain::clients::{self, CreateClientInput};
use minidesk::domain::export;
use minidesk::domain::lifecycle;
use minidesk::domain::orders::{self, ClientChoice, CreateOrderInput, UpdateDetailsInput};
use minidesk::store::environment::Environment;
use minidesk::store::highwater::HighWater;
use minidesk::store::migrations;

fn highwater(env: &Environment) -> HighWater {
    HighWater::open(&env.layout().highwater_db()).unwrap()
}

fn text_of(bytes: &[u8]) -> String {
    assert!(bytes.starts_with(export::BOM.as_bytes()), "CSV 必须带 BOM");
    String::from_utf8_lossy(&bytes[export::BOM.len()..]).to_string()
}

fn trash_order(conn: &rusqlite::Connection, id: &str) {
    conn.execute(
        "UPDATE orders SET deleted_at = '2026-11-20T12:00:00+08:00', deleted_batch = 'b-1'
         WHERE id = ?1",
        [id],
    )
    .unwrap();
}

fn trash_client(conn: &rusqlite::Connection, id: &str) {
    conn.execute(
        "UPDATE clients SET deleted_at = '2026-11-20T12:00:00+08:00', deleted_batch = 'b-1'
         WHERE id = ?1",
        [id],
    )
    .unwrap();
}

/// 一单有效 + 一单进回收站，挂在同一个客户下。
struct Seeded {
    live_code: String,
    gone_code: String,
    gone_id: String,
    client_id: String,
}

fn seed_with_trash(env: &Environment) -> Seeded {
    let mut conn = env.open_db().unwrap();
    let hw = highwater(env);

    let client = clients::create(
        &conn,
        CreateClientInput {
            display_name: "回收站客户".into(),
            contact: Some("微信 xxx".into()),
            note: Some("备注不进 CSV".into()),
        },
    )
    .unwrap();

    let mut mk = |title: &str| -> String {
        let view = orders::create_order(
            &mut conn,
            &hw,
            common::tz(),
            CreateOrderInput {
                title: title.into(),
                client: ClientChoice::Existing {
                    client_id: client.id.clone(),
                },
                ..Default::default()
            },
        )
        .unwrap();
        view.id
    };

    let live_id = mk("有效订单");
    let gone_id = mk("将删除的订单");

    // 让回收站订单带上可验证的历史：开始制作 + 改期。
    let started = orders::load(&conn, &gone_id).unwrap();
    let started = lifecycle::start_work(&mut conn, common::lifecycle_input(&started)).unwrap();
    orders::update_details(
        &mut conn,
        UpdateDetailsInput {
            order_id: started.id.clone(),
            expected_revision: started.revision,
            title: started.title.clone(),
            client_id: started.client_id.clone(),
            commission_type: started.commission_type.clone(),
            source: started.source.clone(),
            amount_cents: Some(88_800),
            planned_start_date: started.planned_start_date.clone(),
            planned_delivery_date: Some("2026-12-24".into()),
            note: started.note.clone(),
            change_source: Some("order_details".into()),
            reason: Some("客户推迟".into()),
        },
    )
    .unwrap();

    let code_of = |id: &str| -> String {
        conn.query_row("SELECT code FROM orders WHERE id = ?1", [id], |r| r.get(0))
            .unwrap()
    };

    let live_code = code_of(&live_id);
    let gone_code = code_of(&gone_id);

    trash_order(&conn, &gone_id);
    // 客户整批删除：与协议一致（客户与其订单同批进出）。
    trash_client(&conn, &client.id);

    Seeded {
        live_code,
        gone_code,
        gone_id,
        client_id: client.id,
    }
}

#[test]
fn csv_hides_trashed_by_default_and_labels_them_when_included() {
    let ctx = common::Ctx::new();
    let s = seed_with_trash(&ctx.env);
    let conn = ctx.env.open_db().unwrap();

    let rows = export::collect_orders(&conn, &[], false).unwrap();
    assert_eq!(rows.len(), 1, "默认导出不含回收站订单");
    assert_eq!(rows[0].code, s.live_code);
    assert!(!rows[0].deleted);

    let body = text_of(&export::orders_csv(&conn, &rows, "全部订单").unwrap());
    assert!(body.contains(&s.live_code));
    assert!(!body.contains(&s.gone_code), "回收站订单不得出现在默认 CSV");
    assert!(!body.contains("已删除"), "默认口径下没有已删除行");

    // 全量分支：允许包含，但必须标注，且原始状态不被改写。
    let all = export::collect_orders(&conn, &[], true).unwrap();
    assert_eq!(all.len(), 2);
    let gone = all.iter().find(|r| r.code == s.gone_code).expect("应含回收站订单");
    assert!(gone.deleted);
    assert_eq!(gone.status, "active", "原始 status 不因删除而改写");

    let body = text_of(&export::orders_csv(&conn, &all, "全部订单（含回收站）").unwrap());
    assert!(body.contains(&s.gone_code));
    assert!(body.contains("已删除 · 活动"), "已删除行要标注原状态");
    // 有效行仍是普通状态文案，不被带偏。
    let live_line = body
        .lines()
        .find(|l| l.contains(&s.live_code))
        .expect("有效行应在 CSV 里");
    assert!(!live_line.contains("已删除"), "有效行不能标成已删除：{live_line}");
    // 隐私口径不变。
    assert!(!body.contains("微信 xxx"));
    assert!(!body.contains("备注不进 CSV"));
}

#[test]
fn data_summary_separates_total_from_trashed() {
    let ctx = common::Ctx::new();
    let s = seed_with_trash(&ctx.env);
    let conn = ctx.env.open_db().unwrap();

    let summary = manifest::summarize(&conn).unwrap();
    assert_eq!(summary.orders, 2, "总数含回收站");
    assert_eq!(summary.trashed_orders, 1, "回收站订单单列");
    assert_eq!(summary.active_orders, 2, "active 是原始状态口径，含已删除");
    assert_eq!(summary.clients, 1);
    assert_eq!(summary.trashed_clients, 1);
    assert!(summary.events >= 3, "历史事件要计入备份摘要");
    let _ = s;
}

#[test]
fn backup_manifest_keeps_v1_shape() {
    let ctx = common::Ctx::new();
    seed_with_trash(&ctx.env);
    let dir = tempfile::tempdir().unwrap();
    let zip = dir.path().join("v1.zip");
    let hw = highwater(&ctx.env);
    create::create(&ctx.env, &hw, &zip).unwrap();

    let file = fs::File::open(&zip).unwrap();
    let mut archive = zip::ZipArchive::new(file).unwrap();
    let mut raw = String::new();
    archive
        .by_name("manifest.json")
        .unwrap()
        .read_to_string(&mut raw)
        .unwrap();
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let obj = value.as_object().unwrap();

    let mut keys: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
    keys.sort();
    assert_eq!(
        keys,
        vec![
            "appVersion",
            "createdAt",
            "files",
            "format",
            "formatVersion",
            "numberHighWater",
            "schemaVersion",
            "totalBytes",
            "totalFiles",
            "workingTimezone",
        ],
        "manifest 结构不得因回收站而新增字段"
    );
    assert_eq!(obj["format"], "artflow-minidesk-backup");
    assert_eq!(obj["formatVersion"], 1, "备份格式仍是 v1");

    let files = obj["files"].as_array().unwrap();
    assert!(!files.is_empty());
    for f in files {
        assert!(
            f["sha256"].as_str().map(|s| s.len()) == Some(64),
            "每个文件仍带 64 位十六进制 SHA-256"
        );
    }
}

/// 造数据 → 备份 → 预览 → 恢复，然后**释放数据目录写锁**（否则重开会 BUSY）。
/// 返回 (回收站订单 ID, 回收站客户 ID, 该订单的历史事件条数)。
fn backup_and_restore(root: &Path, scratch: &Path) -> (String, String, i64) {
    let env = common::open(root);
    let s = seed_with_trash(&env);

    // 附件：给回收站订单挂一条，原图与缩略图都落盘。
    let generation = env.active_generation().to_string();
    let originals = env.layout().attachments_dir(&generation).join("originals");
    let thumbs = env.layout().attachments_dir(&generation).join("thumbs");
    fs::create_dir_all(&originals).unwrap();
    fs::create_dir_all(&thumbs).unwrap();
    fs::write(originals.join("gone.png"), b"original-bytes").unwrap();
    fs::write(thumbs.join("gone.webp"), b"thumb-bytes").unwrap();
    {
        let conn = env.open_db().unwrap();
        conn.execute(
            "INSERT INTO attachments (id, order_id, original_name, rel_path, thumb_rel_path,
                                      mime_type, byte_size, sha256, state, created_at)
             VALUES ('a-gone', ?1, 'gone.png', 'attachments/originals/gone.png',
                     'attachments/thumbs/gone.webp', 'image/png', 14,
                     'deadbeef', 'ok', '2026-11-20T00:00:00+08:00')",
            [&s.gone_id],
        )
        .unwrap();
    }

    let before_events: i64 = env
        .open_db()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM order_events WHERE order_id = ?1",
            [&s.gone_id],
            |r| r.get(0),
        )
        .unwrap();

    let zip = scratch.join("trash.zip");
    let hw = highwater(&env);
    let created = create::create(&env, &hw, &zip).unwrap();
    assert_eq!(created.summary.orders, 2, "备份摘要含回收站订单");
    assert_eq!(created.summary.trashed_orders, 1);
    assert_eq!(created.summary.trashed_clients, 1);

    // 预览：恢复前就能看到回收站数量。
    let preview = restore::preview(&env, &zip).unwrap();
    assert!(preview.can_restore);
    assert_eq!(preview.summary.orders, 2);
    assert_eq!(preview.summary.trashed_orders, 1);
    assert_eq!(preview.summary.trashed_clients, 1);
    assert_eq!(preview.format_version, 1);

    restore::restore(&env, &hw, &zip, &migrations::production()).unwrap();
    (s.gone_id, s.client_id, before_events)
}

#[test]
fn restore_roundtrip_keeps_trashed_orders_clients_history_and_attachments() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let (gone_id, client_id, before_events) = backup_and_restore(&root, dir.path());

    // 重开：回收站数据必须还在，而且恢复后仍被 Visible 口径挡住。
    let env = common::open(&root);
    let conn = env.open_db().unwrap();

    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
        .unwrap();
    assert_eq!(total, 2, "恢复后基表仍有两单（含回收站）");

    let gone: (Option<String>, Option<String>, String) = conn
        .query_row(
            "SELECT deleted_at, deleted_batch, status FROM orders WHERE id = ?1",
            [&gone_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert!(gone.0.is_some(), "deleted_at 必须随备份恢复");
    assert_eq!(gone.1.as_deref(), Some("b-1"), "批次不丢");
    assert_eq!(gone.2, "active", "原状态不被改写");

    let client_gone: Option<String> = conn
        .query_row(
            "SELECT deleted_at FROM clients WHERE id = ?1",
            [&client_id],
            |r| r.get(0),
        )
        .unwrap();
    assert!(client_gone.is_some(), "回收站客户也要恢复");

    let visible: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM orders_visible WHERE id = ?1",
            [&gone_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(visible, 0, "恢复后仍按可见性视图过滤");

    let events: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM order_events WHERE order_id = ?1",
            [&gone_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(events, before_events, "制作历史与改期历史都要在");

    let resched: Option<String> = conn
        .query_row(
            "SELECT new_delivery_date FROM order_events WHERE kind = 'rescheduled' AND order_id = ?1",
            [&gone_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(resched.as_deref(), Some("2026-12-24"));

    let attach: (String, String) = conn
        .query_row(
            "SELECT order_id, rel_path FROM attachments WHERE id = 'a-gone'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(attach.0, gone_id, "附件与回收站订单的关联不能断");
    assert_eq!(attach.1, "attachments/originals/gone.png");

    let generation = env.active_generation().to_string();
    let originals = env.layout().attachments_dir(&generation).join("originals");
    let thumbs = env.layout().attachments_dir(&generation).join("thumbs");
    assert_eq!(
        fs::read(originals.join("gone.png")).unwrap(),
        b"original-bytes",
        "回收站订单的原图必须随包恢复"
    );
    assert_eq!(fs::read(thumbs.join("gone.webp")).unwrap(), b"thumb-bytes");
}

#[test]
fn old_summary_json_without_new_fields_still_parses() {
    // 旧备份里的摘要没有回收站字段；读取侧必须当作 0，而不是失败。
    let legacy = r#"{
        "orders": 3, "activeOrders": 1, "clients": 2, "templates": 1,
        "events": 10, "attachments": 4, "stageSkips": 0, "reschedules": 1
    }"#;
    let summary: manifest::DataSummary = serde_json::from_str(legacy).unwrap();
    assert_eq!(summary.orders, 3);
    assert_eq!(summary.trashed_orders, 0);
    assert_eq!(summary.trashed_clients, 0);

    // 新写的摘要能被同一类型读回，字段齐全。
    let round: manifest::DataSummary = serde_json::from_str(
        &serde_json::to_string(&manifest::DataSummary {
            orders: 3,
            trashed_orders: 1,
            trashed_clients: 2,
            ..Default::default()
        })
        .unwrap(),
    )
    .unwrap();
    assert_eq!(round.trashed_orders, 1);
    assert_eq!(round.trashed_clients, 2);
}

#[test]
fn backup_zip_still_passes_integrity_checks_with_trashed_rows() {
    // 摘要加了计数，但校验仍按文件 SHA-256 逐条比对；回收站行不改变该校验。
    let ctx = common::Ctx::new();
    seed_with_trash(&ctx.env);
    let dir = tempfile::tempdir().unwrap();
    let zip: PathBuf = dir.path().join("check.zip");
    let hw = highwater(&ctx.env);
    create::create(&ctx.env, &hw, &zip).unwrap();

    // 篡改包内任一文件后，预览必须失败（SHA-256 规则未变）。
    let mut bytes = fs::read(&zip).unwrap();
    let mid = bytes.len() / 2;
    bytes[mid] ^= 0xff;
    fs::write(&zip, &bytes).unwrap();
    assert!(
        restore::preview(&ctx.env, &zip).is_err(),
        "改动字节仍应被校验拦下"
    );
}
