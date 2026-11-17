//! QA 沙箱隔离验证。
//!
//! 这些用例全部在 `tempfile` 临时目录里跑，目标只有一个：
//! **证明 QA 环境不可能读写到别的数据根**。它们不打开真实用户数据目录。

use std::ffi::OsStr;
use std::fs;

use tempfile::TempDir;

use minidesk::infra::state::AppState;
use minidesk::store::qa;
use minidesk::store::paths::Layout;

fn os(value: &str) -> &OsStr {
    OsStr::new(value)
}

#[test]
fn without_env_vars_the_app_stays_in_production_mode() {
    let prod = TempDir::new().unwrap();
    let resolved = qa::resolve_root(prod.path(), None, None).unwrap();
    assert!(resolved.is_none(), "没有环境变量时必须返回 None");
}

#[test]
fn only_one_key_is_rejected_in_both_directions() {
    let prod = TempDir::new().unwrap();
    let qa_dir = TempDir::new().unwrap();

    let only_root = qa::resolve_root(prod.path(), Some(os(&qa_dir.path().to_string_lossy())), None)
        .unwrap_err();
    assert_eq!(only_root.code, "ENV");
    assert!(only_root.message.contains(qa::QA_FLAG_ENV));

    let only_flag = qa::resolve_root(prod.path(), None, Some(os("1"))).unwrap_err();
    assert_eq!(only_flag.code, "ENV");
    assert!(only_flag.message.contains(qa::QA_ROOT_ENV));
}

#[test]
fn qa_root_without_marker_is_refused() {
    let prod = TempDir::new().unwrap();
    let qa_dir = TempDir::new().unwrap();

    let err = qa::resolve_root(
        prod.path(),
        Some(os(&qa_dir.path().to_string_lossy())),
        Some(os("1")),
    )
    .unwrap_err();
    assert_eq!(err.code, "ENV");
    assert!(
        err.message.contains(qa::QA_MARKER_FILE),
        "错误信息必须点名缺少标记文件：{}",
        err.message
    );
}

#[test]
fn qa_root_with_wrong_marker_body_is_refused() {
    let prod = TempDir::new().unwrap();
    let qa_dir = TempDir::new().unwrap();
    fs::write(qa_dir.path().join(qa::QA_MARKER_FILE), "something-else\n").unwrap();

    let err = qa::resolve_root(
        prod.path(),
        Some(os(&qa_dir.path().to_string_lossy())),
        Some(os("1")),
    )
    .unwrap_err();
    assert_eq!(err.code, "ENV");
    assert!(err.message.contains("标记内容不正确"), "{}", err.message);
}

#[test]
fn qa_root_cannot_overlap_production_in_either_direction() {
    let outer = TempDir::new().unwrap();
    let production = outer.path().join("production");
    fs::create_dir_all(&production).unwrap();
    qa::write_marker(&production).unwrap();

    // 同一个目录
    let same = qa::resolve_root(
        &production,
        Some(os(&production.to_string_lossy())),
        Some(os("1")),
    )
    .unwrap_err();
    assert_eq!(same.code, "ENV");

    // QA 在正式目录里
    let inner = production.join("qa");
    fs::create_dir_all(&inner).unwrap();
    qa::write_marker(&inner).unwrap();
    let inside = qa::resolve_root(&production, Some(os(&inner.to_string_lossy())), Some(os("1")))
        .unwrap_err();
    assert_eq!(inside.code, "ENV");
    assert!(inside.message.contains("互相包含"), "{}", inside.message);

    // 正式目录在 QA 里
    let wrapper = outer.path().join("wrapper");
    fs::create_dir_all(wrapper.join("production")).unwrap();
    qa::write_marker(&wrapper).unwrap();
    let wrapping = qa::resolve_root(
        &wrapper.join("production"),
        Some(os(&wrapper.to_string_lossy())),
        Some(os("1")),
    )
    .unwrap_err();
    assert_eq!(wrapping.code, "ENV");
}

#[test]
fn production_start_refuses_when_a_qa_marker_sits_in_the_real_root() {
    let prod = TempDir::new().unwrap();
    qa::write_marker(prod.path()).unwrap();

    let err = qa::resolve_root(prod.path(), None, None).unwrap_err();
    assert_eq!(err.code, "ENV");
    assert!(
        err.message.contains(qa::QA_MARKER_FILE),
        "正式模式发现 QA 标记必须明确报错：{}",
        err.message
    );
}

#[test]
fn a_valid_qa_root_resolves_only_to_itself() {
    let outer = TempDir::new().unwrap();
    let production = outer.path().join("production");
    let qa_dir = outer.path().join("qa");
    fs::create_dir_all(&production).unwrap();
    qa::write_marker(&qa_dir).unwrap();

    let resolved = qa::resolve_root(
        &production,
        Some(os(&qa_dir.to_string_lossy())),
        Some(os("1")),
    )
    .unwrap();
    assert_eq!(resolved, Some(qa::normalize(&qa_dir)));
}

/// 打开两个独立环境，确认各自的数据只落在自己的根里。
#[test]
fn two_roots_stay_separate() {
    let outer = TempDir::new().unwrap();
    let production = outer.path().join("production");
    let qa_dir = outer.path().join("qa");
    fs::create_dir_all(&production).unwrap();
    qa::write_marker(&qa_dir).unwrap();

    // 正式目录先放一个哨兵文件，用来证明 QA 启动没有碰它。
    let sentinel = production.join("SENTINEL");
    fs::write(&sentinel, "production-data\n").unwrap();
    let before: Vec<_> = fs::read_dir(&production).unwrap().flatten().map(|e| e.file_name()).collect();

    let qa_state = AppState::open_mode(&qa_dir, true).unwrap();
    // 启动会对根目录做 canonicalize（macOS 的 /var → /private/var），比较时用同一份。
    let qa_canon = qa::normalize(&qa_dir);
    let qa_layout = qa_state.env.layout().clone();
    let qa_generation = qa_state.env.active_generation().to_string();

    // 全部路径都在 QA 根之下。
    for path in [
        qa_layout.marker(),
        qa_layout.highwater_db(),
        qa_layout.active_pointer(),
        qa_layout.generation_db(&qa_generation),
    ] {
        assert!(
            path.starts_with(&qa_canon),
            "{} 不在 QA 根之下",
            path.display()
        );
        assert!(path.exists(), "{} 没有被创建", path.display());
    }
    assert!(qa_state.qa_mode());
    drop(qa_state);

    // 正式目录原样未动。
    assert_eq!(fs::read_to_string(&sentinel).unwrap(), "production-data\n");
    let after: Vec<_> = fs::read_dir(&production).unwrap().flatten().map(|e| e.file_name()).collect();
    assert_eq!(before.len(), after.len(), "QA 启动不得在正式目录产生任何文件");
    assert!(!Layout::new(&production).marker().exists());
}

/// QA 环境自己的维护动作（这里用代际回收）不会跨到另一个根。
#[test]
fn maintenance_of_one_root_does_not_touch_the_other() {
    use minidesk::store::generation;

    let outer = TempDir::new().unwrap();
    let a = outer.path().join("a");
    let b = outer.path().join("b");
    qa::write_marker(&a).unwrap();
    qa::write_marker(&b).unwrap();

    let a_state = AppState::open_mode(&a, true).unwrap();
    let b_state = AppState::open_mode(&b, true).unwrap();
    let a_layout = a_state.env.layout().clone();
    let b_layout = b_state.env.layout().clone();
    let a_active = a_state.env.active_generation().to_string();
    let b_active = b_state.env.active_generation().to_string();
    drop(a_state);
    drop(b_state);

    // a 里造两个旧代际；按现有规则会保留最近的一个作为回退点，
    // 所以这里期望"恰好回收一个"。
    let stale_old = a_layout.generation_dir("gen-stale-0001");
    let stale_mid = a_layout.generation_dir("gen-stale-0002");
    for (dir, body) in [(&stale_old, "old"), (&stale_mid, "mid")] {
        fs::create_dir_all(dir.join("attachments")).unwrap();
        fs::write(dir.join("database.sqlite"), body).unwrap();
    }

    let plan = generation::plan_reclaim(&a_layout, &a_active).unwrap();
    assert_eq!(
        plan.reclaimable.len(),
        1,
        "两个旧代际中应恰好有一个可回收（另一个作为回退点保留）"
    );
    let removed = generation::apply_reclaim(&a_layout, &a_active).unwrap();
    assert_eq!(removed.len(), 1);
    assert_eq!(
        generation::list_generations(&a_layout).unwrap().len(),
        2,
        "回收后应剩活动代 + 一个回退代"
    );

    // b 的活动代际完好。
    assert!(
        b_layout.generation_db(&b_active).exists(),
        "b 的数据库不得被 a 的回收动作影响"
    );
}
