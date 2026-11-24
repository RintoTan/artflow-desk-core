//! DEV-0.1.1-05：数据根迁移与根指针。
//!
//! 全部使用临时目录，不碰任何既有 QA 数据根。

mod common;

use std::fs;
use std::path::{Path, PathBuf};

use common::Ctx;
use minidesk::domain::migrate;
use minidesk::store::environment::open_connection;
use minidesk::store::migrations;
use minidesk::store::rootptr::{self, RootPointer};

fn pointer_in(dir: &Path) -> PathBuf {
    dir.join("root.json")
}

fn write_pointer(dir: &Path, target: &Path) {
    rootptr::write_atomic(
        &pointer_in(dir),
        &RootPointer {
            data_root: target.display().to_string(),
            updated_at: "2026-11-24T00:00:00+08:00".into(),
        },
    )
    .unwrap();
}

/// 造一个「历史代际」：目录 + 已迁移的库 + 一张附件，不写进 active.json。
fn add_second_generation(ctx: &Ctx) -> String {
    let id = "gen-test-history".to_string();
    let layout = ctx.env.layout();
    let dir = layout.generation_dir(&id);
    fs::create_dir_all(dir.join("attachments").join("originals")).unwrap();
    fs::create_dir_all(dir.join("attachments").join("thumbs")).unwrap();

    let db = layout.generation_db(&id);
    let mut conn = open_connection(&db).unwrap();
    migrations::migrate_to(&mut conn, &migrations::production(), migrations::APP_SCHEMA_VERSION)
        .unwrap();
    conn.execute(
        "INSERT INTO clients (id, display_name, contact, note, revision, created_at, updated_at)
         VALUES ('legacy-c1', '历史客户', NULL, NULL, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        [],
    )
    .unwrap();
    drop(conn);

    fs::write(
        dir.join("attachments").join("originals").join("legacy.bin"),
        b"legacy-bytes",
    )
    .unwrap();
    id
}

#[test]
fn migrating_moves_every_generation_and_keeps_the_source() {
    let ctx = Ctx::new();
    ctx.create_order("当前代际的订单");
    let history = add_second_generation(&ctx);

    let target_dir = tempfile::tempdir().unwrap();
    let target = target_dir.path().join("moved");
    let ptr = pointer_in(target_dir.path());

    let preview = migrate::preview(&ctx.env, &target).unwrap();
    assert!(
        preview.generations.len() >= 2,
        "预览必须列出全部代际：{:?}",
        preview.generations
    );
    assert!(preview.generations.contains(&history));

    let report = migrate::run(&ctx.env, &ctx.hw, &target, &ptr).unwrap();

    // 指针切到新根
    let pointer = rootptr::read(&ptr).unwrap().expect("指针应存在");
    assert_eq!(PathBuf::from(&pointer.data_root), fs::canonicalize(&target).unwrap());

    // 每个代际的库都在，且都能通过完整性检查
    for id in &report.generations {
        let db = target.join("generations").join(id).join("database.sqlite");
        assert!(db.exists(), "代际 {id} 的数据库没搬过去");
        let conn = open_connection(&db).unwrap();
        let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(integrity, "ok");
    }

    // 历史代际的业务数据真的还在
    let legacy_db = target.join("generations").join(&history).join("database.sqlite");
    let legacy = open_connection(&legacy_db).unwrap();
    let name: String = legacy
        .query_row("SELECT display_name FROM clients WHERE id = 'legacy-c1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(name, "历史客户");

    // 旧根完整保留
    assert!(ctx.env.root().join("environment.json").exists());
    assert!(ctx.env.layout().generation_dir(&history).exists());

    // 备份与快照都跟着走
    assert!(target.join("backups").exists());
    let snapshot = report.snapshot_path.expect("缺少安全快照");
    assert!(PathBuf::from(&snapshot).exists(), "快照应留在旧根");
    assert!(target.join(".write.lock").exists(), "目标根必须重新建锁文件");
}

#[test]
fn missing_database_in_any_generation_fails_the_verification() {
    // 区分度：校验若只看活动代际，这条会通过。它必须失败。
    let ctx = Ctx::new();
    ctx.create_order("活动代际");
    let history = add_second_generation(&ctx);
    fs::remove_file(ctx.env.layout().generation_db(&history)).unwrap();

    let target_dir = tempfile::tempdir().unwrap();
    let target = target_dir.path().join("moved");
    let ptr = pointer_in(target_dir.path());

    let err = migrate::run(&ctx.env, &ctx.hw, &target, &ptr).unwrap_err();
    assert!(
        err.message.contains(&history) || err.message.contains("数据库"),
        "应当明确指出缺失的代际：{}",
        err.message
    );
    assert!(!ptr.exists(), "失败时不能留下指针");
    assert!(
        !target.join("environment.json").exists(),
        "失败时目标侧半成品必须被清理"
    );
}

#[test]
fn pending_recovery_state_blocks_migration() {
    let ctx = Ctx::new();
    ctx.create_order("有恢复任务的订单");
    let recovery = ctx.env.layout().recovery_dir();
    fs::create_dir_all(&recovery).unwrap();
    fs::write(recovery.join("state.json"), b"{\"generation\":\"gen-x\"}").unwrap();

    let target_dir = tempfile::tempdir().unwrap();
    let target = target_dir.path().join("moved");
    let err = migrate::run(&ctx.env, &ctx.hw, &target, &pointer_in(target_dir.path())).unwrap_err();
    assert!(err.message.contains("恢复"), "{}", err.message);
    assert!(recovery.join("state.json").exists(), "不得自动删除该文件");
}

#[test]
fn diagnostic_recovery_directories_are_carried_along() {
    let ctx = Ctx::new();
    ctx.create_order("诊断目录测试");
    let evidence = ctx.env.layout().recovery_dir().join("failed-restore-20260101-gen-x");
    fs::create_dir_all(&evidence).unwrap();
    fs::write(evidence.join("note.txt"), b"evidence").unwrap();

    let target_dir = tempfile::tempdir().unwrap();
    let target = target_dir.path().join("moved");
    migrate::run(&ctx.env, &ctx.hw, &target, &pointer_in(target_dir.path())).unwrap();

    assert!(
        target.join("recovery").join("failed-restore-20260101-gen-x").join("note.txt").exists(),
        "失败恢复的诊断目录必须保留"
    );
}

#[test]
fn target_with_an_existing_environment_is_refused() {
    let ctx = Ctx::new();
    ctx.create_order("源数据");
    let other = tempfile::tempdir().unwrap();
    fs::write(other.path().join("environment.json"), b"{}").unwrap();

    let err = migrate::run(&ctx.env, &ctx.hw, other.path(), &pointer_in(other.path())).unwrap_err();
    assert!(err.message.contains("已经存在"), "{}", err.message);
    assert_eq!(err.code, "CONFLICT");
}

#[test]
fn non_empty_target_is_refused_rather_than_merged() {
    let ctx = Ctx::new();
    ctx.create_order("源数据");
    let other = tempfile::tempdir().unwrap();
    fs::write(other.path().join("用户的文件.txt"), b"mine").unwrap();

    let err = migrate::run(&ctx.env, &ctx.hw, other.path(), &pointer_in(other.path())).unwrap_err();
    assert!(err.message.contains("不是空的"), "{}", err.message);
    assert!(other.path().join("用户的文件.txt").exists(), "不得动别人的文件");
}

#[test]
fn nested_targets_are_refused() {
    let ctx = Ctx::new();
    ctx.create_order("源数据");
    let inside = ctx.env.root().join("nested");
    let err = migrate::run(&ctx.env, &ctx.hw, &inside, &pointer_in(ctx.env.root())).unwrap_err();
    assert!(err.message.contains("内部"), "{}", err.message);

    let parent = ctx.env.root().parent().unwrap().to_path_buf();
    let err = migrate::run(&ctx.env, &ctx.hw, &parent, &pointer_in(ctx.env.root())).unwrap_err();
    assert!(err.message.contains("上级") || err.message.contains("递归"), "{}", err.message);
}

#[test]
fn qa_marker_travels_with_a_qa_root_only() {
    let ctx = Ctx::new();
    ctx.create_order("QA 场景");
    fs::write(ctx.env.root().join(".qa-root"), b"artflow-qa-root\n").unwrap();

    let target_dir = tempfile::tempdir().unwrap();
    let target = target_dir.path().join("moved");
    migrate::run(&ctx.env, &ctx.hw, &target, &pointer_in(target_dir.path())).unwrap();
    assert!(target.join(".qa-root").exists(), "QA 标记必须跟着场景走");
}

#[test]
fn pointer_round_trips_and_rejects_corruption() {
    let dir = tempfile::tempdir().unwrap();
    let ptr = pointer_in(dir.path());

    assert!(rootptr::read(&ptr).unwrap().is_none(), "没有指针代表用默认根");

    write_pointer(dir.path(), Path::new("/tmp/somewhere"));
    let loaded = rootptr::read(&ptr).unwrap().unwrap();
    assert_eq!(loaded.data_root, "/tmp/somewhere");

    // 原子写不留临时文件
    let leftovers: Vec<_> = fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
        .collect();
    assert!(leftovers.is_empty(), "不应留下临时文件");

    fs::write(&ptr, b"{ not json").unwrap();
    let err = rootptr::read(&ptr).unwrap_err();
    assert!(err.message.contains("损坏"), "{}", err.message);
}

#[test]
fn a_custom_root_must_look_like_a_data_root() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("gone");
    let err = rootptr::validate_existing_root(&missing).unwrap_err();
    assert!(err.message.contains("不存在"), "{}", err.message);

    let empty = dir.path().join("empty");
    fs::create_dir_all(&empty).unwrap();
    let err = rootptr::validate_existing_root(&empty).unwrap_err();
    assert!(err.message.contains("环境标记"), "{}", err.message);
}

#[test]
fn migrating_twice_to_the_same_target_is_refused() {
    let ctx = Ctx::new();
    ctx.create_order("只搬一次");
    let target_dir = tempfile::tempdir().unwrap();
    let target = target_dir.path().join("moved");
    let ptr = pointer_in(target_dir.path());

    migrate::run(&ctx.env, &ctx.hw, &target, &ptr).unwrap();
    let err = migrate::run(&ctx.env, &ctx.hw, &target, &ptr).unwrap_err();
    assert!(
        err.message.contains("已经存在") || err.message.contains("不是空的"),
        "{}",
        err.message
    );
}
