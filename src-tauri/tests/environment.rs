//! 数据环境：首次启动、重启、代际规划与安全清理。

mod common;

use std::fs;

use minidesk::store::generation::{self, plan_reclaim, read_active};

#[test]
fn first_run_creates_the_full_layout() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);
    let layout = env.layout();

    assert!(layout.marker().exists(), "环境标记必须写入");
    assert!(layout.active_pointer().exists(), "活动指针必须写入");
    assert!(layout.highwater_db().exists(), "编号记录必须写入");
    assert!(root.join(".write.lock").exists(), "锁文件必须写入");

    let gen = env.active_generation().to_string();
    assert!(layout.generation_db(&gen).exists());
    assert!(layout.attachments_dir(&gen).join("originals").is_dir());
    assert!(layout.attachments_dir(&gen).join("thumbs").is_dir());
}

#[test]
fn restart_is_not_treated_as_first_run() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let first_generation = {
        let env = common::open(&root);
        assert!(env.outcome().first_run);
        env.active_generation().to_string()
    };
    let env = common::open(&root);
    assert!(!env.outcome().first_run);
    assert_eq!(env.active_generation(), first_generation);
}

#[test]
fn missing_marker_with_existing_generations_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);
    let layout = env.layout().clone();
    drop(env);

    fs::remove_file(layout.marker()).unwrap();
    let err = common::try_open(&root).err().expect("必须拒绝");
    assert_eq!(err.code, "ENV");
    assert!(err.message.contains("环境标记"), "{}", err.message);
}

#[test]
fn single_generation_has_nothing_to_reclaim() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let report = plan_reclaim(env.layout(), env.active_generation()).unwrap();
    assert_eq!(report.total, 1);
    assert!(report.reclaimable.is_empty());
    assert!(report.protected.contains(&report.active));
}

#[test]
fn active_and_one_fallback_are_always_protected() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);
    let old = env.active_generation().to_string();
    drop(env);

    // 造出第二个代际：复制一份旧代作为历史代。
    let layout = minidesk::store::paths::Layout::new(&root);
    let clone = "gen-historical-copy";
    fs::create_dir_all(layout.generation_dir(clone)).unwrap();
    fs::copy(
        layout.generation_db(&old),
        layout.generation_db(clone),
    )
    .unwrap();

    let env = common::open(&root);
    let report = plan_reclaim(env.layout(), env.active_generation()).unwrap();
    assert!(report.protected.len() >= 2, "活动代与一个回退代都必须保留");
    assert!(report.protected.iter().any(|g| g == clone));
}

#[test]
fn pending_recovery_protects_everything() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);
    let active = env.active_generation().to_string();

    let layout = env.layout().clone();
    fs::create_dir_all(layout.generation_dir("gen-target")).unwrap();
    fs::copy(layout.generation_db(&active), layout.generation_db("gen-target")).unwrap();
    fs::create_dir_all(layout.recovery_dir()).unwrap();
    fs::write(
        layout.recovery_state(),
        serde_json::json!({
            "phase": "restore",
            "previousGeneration": active,
            "targetGeneration": "gen-target",
            "reason": "test",
            "writtenAt": "2026-01-01T00:00:00.000Z"
        })
        .to_string(),
    )
    .unwrap();

    let report = plan_reclaim(&layout, &active).unwrap();
    assert!(report.reclaimable.is_empty(), "有未完成恢复时不得清理");
    assert!(report.protected.exists_check("gen-target"));
}

trait ContainsGeneration {
    fn exists_check(&self, id: &str) -> bool;
}

impl ContainsGeneration for Vec<String> {
    fn exists_check(&self, id: &str) -> bool {
        self.iter().any(|g| g == id)
    }
}

#[cfg(unix)]
#[test]
fn symlinked_generation_is_never_a_candidate() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);
    let active = env.active_generation().to_string();
    let layout = env.layout().clone();

    std::os::unix::fs::symlink(
        layout.generation_dir(&active),
        layout.generations_dir().join("gen-evil"),
    )
    .unwrap();

    let report = plan_reclaim(&layout, &active).unwrap();
    assert!(report.unknown.iter().any(|g| g == "gen-evil"));
    assert!(!report.reclaimable.iter().any(|g| g == "gen-evil"));
}

#[test]
fn apply_reclaim_deletes_only_reclaimable_and_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);
    let active = env.active_generation().to_string();
    let layout = env.layout().clone();

    for name in ["gen-old-a", "gen-old-b"] {
        fs::create_dir_all(layout.generation_dir(name)).unwrap();
        fs::copy(layout.generation_db(&active), layout.generation_db(name)).unwrap();
    }

    let plan = plan_reclaim(&layout, &active).unwrap();
    assert!(!plan.reclaimable.is_empty(), "多代时应识别候选");
    let to_remove = plan.reclaimable.clone();

    let removed = generation::apply_reclaim(&layout, &active).unwrap();
    assert_eq!(removed, to_remove);
    for id in &removed {
        assert!(!layout.generation_dir(id).exists());
    }
    assert!(layout.generation_db(&active).exists(), "活动代不得被删除");

    let again = generation::apply_reclaim(&layout, &active).unwrap();
    assert!(again.is_empty(), "重复清理应幂等");
}

#[test]
fn reclaim_stops_if_active_database_disappears() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);
    let active = env.active_generation().to_string();
    let layout = env.layout().clone();

    fs::create_dir_all(layout.generation_dir("gen-old")).unwrap();
    fs::copy(layout.generation_db(&active), layout.generation_db("gen-old")).unwrap();
    fs::remove_file(layout.generation_db(&active)).unwrap();

    let err = generation::apply_reclaim(&layout, &active).err().expect("应拒绝");
    assert_eq!(err.code, "ENV");
    assert!(layout.generation_dir("gen-old").exists(), "停止清理时不得删除任何东西");
}

#[test]
fn active_pointer_records_the_generation() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let pointer = read_active(env.layout()).unwrap().expect("指针存在");
    assert_eq!(pointer.generation, env.active_generation());
    assert!(!pointer.updated_at.is_empty());
}
