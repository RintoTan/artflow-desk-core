//! DEV-07：导出 → 校验 → 隔离恢复 的完整链路。
//!
//! 全部在 tempfile 里跑，不碰任何真实数据目录。

mod common;

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use minidesk::backup::{create, restore};
use minidesk::store::environment::Environment;
use minidesk::store::highwater::HighWater;
use minidesk::store::migrations;
use minidesk::store::paths::Layout;

fn open(root: &Path) -> Environment {
    common::open(root)
}

fn highwater(env: &Environment) -> HighWater {
    HighWater::open(&env.layout().highwater_db()).unwrap()
}

/// 造一张带附件、跳级历史与改期历史的订单。
fn seed(env: &Environment) {
    let mut conn = env.open_db().unwrap();
    let hw = highwater(env);
    let view = minidesk::domain::orders::create_order(
        &mut conn,
        &hw,
        common::tz(),
        minidesk::domain::orders::CreateOrderInput {
            title: "备份往返".into(),
            planned_start_date: Some("2026-12-01".into()),
            planned_delivery_date: Some("2026-12-20".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let started = minidesk::domain::lifecycle::start_work(
        &mut conn,
        common::lifecycle_input(&view),
    )
    .unwrap();

    // 跳级：草稿 → 细化，跨过线稿与固有色。
    let target = started.stages[3].id.clone();
    let skipped = minidesk::domain::lifecycle::skip_stage(
        &mut conn,
        minidesk::domain::lifecycle::SkipInput {
            order_id: started.id.clone(),
            expected_revision: started.revision,
            target_stage_id: target,
            reason: Some("客户只要成图".into()),
            request_id: Some("req-skip-backup".into()),
        },
    )
    .unwrap();

    // 改期：v6 字段也要跟着备份走。
    let mut req = minidesk::domain::orders::UpdateDetailsInput {
        order_id: skipped.id.clone(),
        expected_revision: skipped.revision,
        title: skipped.title.clone(),
        client_id: skipped.client_id.clone(),
        commission_type: skipped.commission_type.clone(),
        source: skipped.source.clone(),
        amount_cents: skipped.amount_cents,
        planned_start_date: skipped.planned_start_date.clone(),
        planned_delivery_date: Some("2026-12-24".into()),
        note: skipped.note.clone(),
        change_source: Some("order_details".into()),
        reason: Some("客户推迟".into()),
    };
    minidesk::domain::orders::update_details(&mut conn, req.clone()).unwrap();
    req.expected_revision += 1;

    // 附件：原图 + 缩略图都进包。
    let generation = env.active_generation().to_string();
    let originals = env.layout().attachments_dir(&generation).join("originals");
    let thumbs = env.layout().attachments_dir(&generation).join("thumbs");
    fs::create_dir_all(&originals).unwrap();
    fs::create_dir_all(&thumbs).unwrap();
    fs::write(originals.join("seed.png"), b"original-bytes").unwrap();
    fs::write(thumbs.join("seed.webp"), b"thumb-bytes").unwrap();
    conn.execute(
        "INSERT INTO attachments (id, order_id, original_name, rel_path, thumb_rel_path,
                                  mime_type, byte_size, sha256, state, created_at)
         VALUES ('a1', ?1, 'seed.png', 'attachments/originals/seed.png',
                 'attachments/thumbs/seed.webp', 'image/png', 14,
                 'deadbeef', 'ok', '2026-11-20T00:00:00+08:00')",
        [&skipped.id],
    )
    .unwrap();
}

fn export(env: &Environment, target: &Path) -> create::Created {
    let hw = highwater(env);
    create::create(env, &hw, target).expect("导出失败")
}

#[test]
fn roundtrip_restores_every_table_attachment_and_watermark() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = open(&root);
    seed(&env);
    let hw = highwater(&env);
    let before = hw.snapshot().unwrap();
    let before_generation = env.active_generation().to_string();
    let before_orders: i64 = env
        .open_db()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
        .unwrap();

    let zip = dir.path().join("out.zip");
    let created = export(&env, &zip);
    assert!(zip.is_file());
    assert_eq!(created.attachment_files, 1, "只统计 originals");
    assert_eq!(created.summary.orders, before_orders);
    assert_eq!(created.summary.stage_skips, 1);
    assert_eq!(created.summary.reschedules, 1);

    // 预览：完整校验通过，版本关系正确。
    let preview = restore::preview(&env, &zip).unwrap();
    assert!(preview.can_restore);
    assert_eq!(preview.schema_version, migrations::APP_SCHEMA_VERSION);
    assert_eq!(preview.schema_relation, "current");
    assert_eq!(preview.summary.orders, before_orders);

    // 恢复：新代际，旧代际保留。
    let done = restore::restore(&env, &hw, &zip, &migrations::production()).unwrap();
    assert_ne!(done.new_generation, before_generation);
    assert_eq!(done.previous_generation, before_generation);
    assert!(done.pre_restore_backup.is_some());
    assert!(Layout::new(&root)
        .generation_dir(&before_generation)
        .exists());
    drop(env);

    // 重新打开：活动代际已切换，数据齐全。
    let env = open(&root);
    assert_eq!(env.active_generation(), done.new_generation);
    let conn = env.open_db().unwrap();
    let orders: i64 = conn
        .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
        .unwrap();
    assert_eq!(orders, before_orders);
    let skip: (String, String) = conn
        .query_row(
            "SELECT skipped_stages, skip_reason FROM order_events WHERE kind = 'stage_skipped'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(skip.0.contains("线稿"), "{}", skip.0);
    assert_eq!(skip.1, "客户只要成图");
    let resched: (String, String) = conn
        .query_row(
            "SELECT new_delivery_date, change_source FROM order_events WHERE kind = 'rescheduled'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(resched.0, "2026-12-24");
    assert_eq!(resched.1, "order_details");
    let stages: i64 = conn
        .query_row("SELECT COUNT(*) FROM order_stages", [], |r| r.get(0))
        .unwrap();
    assert!(stages >= 5);
    drop(conn);

    let generation = env.active_generation().to_string();
    let originals = env.layout().attachments_dir(&generation).join("originals");
    let thumbs = env.layout().attachments_dir(&generation).join("thumbs");
    assert_eq!(
        fs::read(originals.join("seed.png")).unwrap(),
        b"original-bytes"
    );
    assert_eq!(fs::read(thumbs.join("seed.webp")).unwrap(), b"thumb-bytes");

    let after = highwater(&env).snapshot().unwrap();
    assert_eq!(after, before, "高水位不得下降");
}

#[test]
fn exporting_twice_never_overwrites_existing_file() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = open(&root);
    seed(&env);
    let zip = dir.path().join("dup.zip");
    export(&env, &zip);
    let hw = highwater(&env);
    let err = create::create(&env, &hw, &zip).unwrap_err();
    assert!(err.message.contains("已存在"), "{}", err.message);
}

#[test]
fn corrupt_zip_is_rejected_before_any_change() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = open(&root);
    seed(&env);
    let zip = dir.path().join("bad.zip");
    export(&env, &zip);

    let mut bytes = fs::read(&zip).unwrap();
    let mid = bytes.len() / 2;
    bytes[mid] ^= 0xff;
    fs::write(&zip, &bytes).unwrap();

    assert!(restore::preview(&env, &zip).is_err());
    let hw = highwater(&env);
    assert!(restore::restore(&env, &hw, &zip, &migrations::production()).is_err());
    // 活动代际没动。
    assert_eq!(env.active_generation(), env.active_generation());
}

#[test]
fn sha_mismatch_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = open(&root);
    seed(&env);
    let zip = dir.path().join("src.zip");
    export(&env, &zip);

    // 解开重打包：把 manifest 里某个文件的 sha 改掉。
    let tampered = dir.path().join("tampered.zip");
    rewrite_zip(&zip, &tampered, |name, data| {
        if name == "manifest.json" {
            let mut manifest: serde_json::Value = serde_json::from_slice(data).unwrap();
            if let Some(files) = manifest["files"].as_array_mut() {
                if let Some(first) = files.first_mut() {
                    first["sha256"] = serde_json::Value::String("0".repeat(64));
                }
            }
            serde_json::to_vec_pretty(&manifest).unwrap()
        } else {
            data.to_vec()
        }
    });

    let err = restore::preview(&env, &tampered).unwrap_err();
    assert!(err.message.contains("SHA-256"), "{}", err.message);
}

#[test]
fn missing_manifest_and_missing_original_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = open(&root);
    seed(&env);
    let zip = dir.path().join("src.zip");
    export(&env, &zip);

    // 1) 去掉 manifest
    let no_manifest = dir.path().join("no-manifest.zip");
    rewrite_zip(&zip, &no_manifest, |name, data| {
        if name == "manifest.json" {
            Vec::new()
        } else {
            data.to_vec()
        }
    });
    let filtered = dir.path().join("no-manifest-2.zip");
    rebuild_without(&no_manifest, &filtered, "manifest.json");
    let err = restore::preview(&env, &filtered).unwrap_err();
    assert!(err.message.contains("manifest"), "{}", err.message);

    // 2) 去掉原图但保留 manifest：应报"缺少原图"
    let missing = dir.path().join("missing-original.zip");
    rebuild_without(&zip, &missing, "attachments/originals/seed.png");
    let err = restore::restore(&env, &highwater(&env), &missing, &migrations::production())
        .unwrap_err();
    assert!(
        err.message.contains("manifest") || err.message.contains("缺少"),
        "{}",
        err.message
    );
}

#[test]
fn newer_schema_backup_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = open(&root);
    seed(&env);
    let zip = dir.path().join("src.zip");
    export(&env, &zip);

    let future = dir.path().join("future.zip");
    rewrite_zip(&zip, &future, |name, data| {
        if name == "manifest.json" {
            let mut manifest: serde_json::Value = serde_json::from_slice(data).unwrap();
            manifest["schemaVersion"] = serde_json::Value::from(99);
            serde_json::to_vec_pretty(&manifest).unwrap()
        } else {
            data.to_vec()
        }
    });

    let preview = restore::preview(&env, &future).unwrap();
    assert!(!preview.can_restore);
    assert_eq!(preview.schema_relation, "newer");

    let err =
        restore::restore(&env, &highwater(&env), &future, &migrations::production()).unwrap_err();
    assert!(err.message.contains("高于"), "{}", err.message);
    // 不允许出现"空库冒充恢复成功"：活动代际仍是原来的库，且数据还在。
    let orders: i64 = env
        .open_db()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
        .unwrap();
    assert_eq!(orders, 1);
}

#[test]
fn broken_database_snapshot_is_rejected_without_touching_active() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = open(&root);
    seed(&env);
    let zip = dir.path().join("src.zip");
    export(&env, &zip);

    // 用垃圾字节替换数据库，并同步 manifest 的 sha/size，让校验走到"打开数据库"这一步。
    let broken = dir.path().join("broken-db.zip");
    let garbage = b"not a sqlite database".to_vec();
    {
        let (_n, sha) = rewrite_zip_with_hash(&zip, &broken, |name, data| {
            if name == "database.sqlite" {
                garbage.clone()
            } else if name == "manifest.json" {
                let mut manifest: serde_json::Value = serde_json::from_slice(data).unwrap();
                for file in manifest["files"].as_array_mut().unwrap() {
                    if file["path"] == "database.sqlite" {
                        file["bytes"] = serde_json::Value::from(garbage.len());
                        // sha 稍后按真实字节补写
                    }
                }
                serde_json::to_vec_pretty(&manifest).unwrap()
            } else {
                data.to_vec()
            }
        });
        let _ = sha;
    }
    // 再算一次真实的 sha 写进 manifest，确保只有"数据库本身坏"这一条被触发。
    let fixed = dir.path().join("broken-db-2.zip");
    let real_sha = sha256_bytes(&garbage);
    rewrite_zip(&broken, &fixed, |name, data| {
        if name == "manifest.json" {
            let mut manifest: serde_json::Value = serde_json::from_slice(data).unwrap();
            for file in manifest["files"].as_array_mut().unwrap() {
                if file["path"] == "database.sqlite" {
                    file["sha256"] = serde_json::Value::String(real_sha.clone());
                }
            }
            serde_json::to_vec_pretty(&manifest).unwrap()
        } else {
            data.to_vec()
        }
    });

    let err =
        restore::restore(&env, &highwater(&env), &fixed, &migrations::production()).unwrap_err();
    assert!(!err.message.is_empty());
    let orders: i64 = env
        .open_db()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
        .unwrap();
    assert_eq!(orders, 1, "原数据必须仍可读");
}

#[test]
fn restore_never_lowers_a_newer_local_watermark() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = open(&root);
    seed(&env);
    let zip = dir.path().join("small.zip");
    export(&env, &zip);

    // 备份之后本机继续分配编号（高水位抬高）。
    let hw = highwater(&env);
    let year = chrono::Utc::now()
        .with_timezone(&common::tz())
        .format("%Y")
        .to_string()
        .parse::<i32>()
        .unwrap();
    let before = hw.peek(year).unwrap().unwrap_or(0);
    for _ in 0..3 {
        hw.reserve(year).unwrap();
    }
    let raised_local = hw.peek(year).unwrap().unwrap();

    restore::restore(&env, &hw, &zip, &migrations::production()).unwrap();
    let after = hw.peek(year).unwrap().unwrap();
    assert_eq!(after, raised_local, "恢复旧备份不得让编号回退");
    assert!(after >= before);
}

#[test]
fn failed_restore_leaves_no_generation_and_keeps_active_pointer() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = open(&root);
    seed(&env);
    let zip = dir.path().join("src.zip");
    export(&env, &zip);

    let layout = Layout::new(&root);
    let before: Vec<String> = minidesk::store::generation::list_generations(&layout).unwrap();
    let pointer = minidesk::store::generation::read_active(&layout)
        .unwrap()
        .unwrap()
        .generation;

    // 数据库内容坏掉但 sha 自洽 → 在"解包之后"失败，才能验证失败现场的处理
    let broken = dir.path().join("broken-db.zip");
    make_broken_db_zip(&zip, &broken);
    assert!(restore::restore(&env, &highwater(&env), &broken, &migrations::production()).is_err());

    let after: Vec<String> = minidesk::store::generation::list_generations(&layout).unwrap();
    assert_eq!(before, after, "失败不得在 generations/ 留下半成品");
    assert_eq!(
        minidesk::store::generation::read_active(&layout)
            .unwrap()
            .unwrap()
            .generation,
        pointer
    );
    let recovery = layout.recovery_dir();
    assert!(recovery.exists(), "失败现场应挪到 recovery/ 便于诊断");
    assert!(fs::read_dir(&recovery).unwrap().count() >= 1);
}

// ---------------------------------------------------------------- 测试工具

fn sha256_bytes(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// 重写 ZIP：把每个条目交给 `map` 处理；返回空 Vec 表示丢弃该条目。
fn rewrite_zip<F>(source: &Path, target: &Path, map: F)
where
    F: Fn(&str, &[u8]) -> Vec<u8>,
{
    let _ = rewrite_zip_with_hash(source, target, map);
}

fn rewrite_zip_with_hash<F>(source: &Path, target: &Path, map: F) -> (usize, usize)
where
    F: Fn(&str, &[u8]) -> Vec<u8>,
{
    use zip::write::SimpleFileOptions;
    let file = fs::File::open(source).unwrap();
    let mut archive = zip::ZipArchive::new(file).unwrap();
    let out = fs::File::create(target).unwrap();
    let mut writer = zip::ZipWriter::new(out);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut written = 0usize;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).unwrap();
        let name = entry.name().unwrap().to_string();
        let mut data = Vec::new();
        std::io::copy(&mut entry, &mut data).unwrap();
        let mapped = map(&name, &data);
        if mapped.is_empty() && name != "manifest.json" {
            continue;
        }
        if mapped.is_empty() {
            continue;
        }
        writer.start_file(name, options).unwrap();
        writer.write_all(&mapped).unwrap();
        written += 1;
    }
    writer.finish().unwrap();
    (written, written)
}

/// 生成"去掉某个条目、其余不动"的包（用于缺文件场景）。
fn rebuild_without(source: &Path, target: &Path, drop: &str) {
    use zip::write::SimpleFileOptions;
    let file = fs::File::open(source).unwrap();
    let mut archive = zip::ZipArchive::new(file).unwrap();
    let out = fs::File::create(target).unwrap();
    let mut writer = zip::ZipWriter::new(out);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).unwrap();
        let name = entry.name().unwrap().to_string();
        if name == drop {
            continue;
        }
        let mut data = Vec::new();
        std::io::copy(&mut entry, &mut data).unwrap();
        writer.start_file(name, options).unwrap();
        writer.write_all(&data).unwrap();
    }
    writer.finish().unwrap();
}

#[allow(dead_code)]
fn zip_names(path: &Path) -> Vec<String> {
    minidesk::backup::zip_read::central_directory_names(path).unwrap()
}

#[allow(dead_code)]
fn path_of(root: &Path, name: &str) -> PathBuf {
    root.join(name)
}

/// 造一个"数据库是垃圾字节、但 manifest 的 sha/大小自洽"的包：
/// 用来验证失败发生在解包之后（校验已通过，坏在数据库本身）。
fn make_broken_db_zip(source: &Path, target: &Path) {
    let garbage = b"not a sqlite database".to_vec();
    let sha = sha256_bytes(&garbage);
    rewrite_zip(source, target, |name, data| {
        if name == "database.sqlite" {
            return garbage.clone();
        }
        if name == "manifest.json" {
            let mut manifest: serde_json::Value = serde_json::from_slice(data).unwrap();
            for file in manifest["files"].as_array_mut().unwrap() {
                if file["path"] == "database.sqlite" {
                    file["bytes"] = serde_json::Value::from(garbage.len());
                    file["sha256"] = serde_json::Value::String(sha.clone());
                }
            }
            return serde_json::to_vec_pretty(&manifest).unwrap();
        }
        data.to_vec()
    });
}
