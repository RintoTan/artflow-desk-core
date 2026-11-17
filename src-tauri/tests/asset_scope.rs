//! asset 协议访问范围：只放行代际里的附件目录。
//!
//! 这是**配置层**的验证：用与 Tauri scope 相同的通配语义（glob）匹配真实绝对路径。
//! 它不能替代对运行时拦截行为的验证（那需要真实 WebView 发请求），这一点在报告里写明。

use glob::Pattern;

const APP_DATA: &str = "/Users/someone/Library/Application Support/dev.artflow.minidesk";
const GEN: &str = "gen-e05d7ce65b8d40c0a0d23bedf18476ee";

fn scope_patterns() -> Vec<Pattern> {
    let raw = include_str!("../tauri.conf.json");
    let value: serde_json::Value = serde_json::from_str(raw).unwrap();
    let entries = value["app"]["security"]["assetProtocol"]["scope"]
        .as_array()
        .expect("assetProtocol.scope 必须是数组");
    entries
        .iter()
        .map(|entry| {
            let text = entry
                .as_str()
                .unwrap()
                .replace("$APPDATA", APP_DATA);
            Pattern::new(&text).expect("scope 必须是合法 glob")
        })
        .collect()
}

fn allowed(path: &str) -> bool {
    scope_patterns().iter().any(|p| p.matches(path))
}

#[test]
fn scope_is_not_the_whole_app_data_directory() {
    let raw = include_str!("../tauri.conf.json");
    let value: serde_json::Value = serde_json::from_str(raw).unwrap();
    let entries = value["app"]["security"]["assetProtocol"]["scope"]
        .as_array()
        .unwrap();
    for entry in entries {
        let text = entry.as_str().unwrap();
        assert_ne!(text, "$APPDATA/**", "不允许整个 AppData 都可读");
        assert_ne!(text, "$APPDATA", "不允许整个 AppData 都可读");
    }
}

#[test]
fn attachment_images_are_allowed() {
    let original = format!("{APP_DATA}/generations/{GEN}/attachments/originals/a.png");
    let thumb = format!("{APP_DATA}/generations/{GEN}/attachments/thumbs/a.webp");
    assert!(allowed(&original), "原图必须可预览");
    assert!(allowed(&thumb), "缩略图必须可预览");
}

#[test]
fn business_database_is_not_reachable() {
    let db = format!("{APP_DATA}/generations/{GEN}/database.sqlite");
    assert!(!allowed(&db), "业务数据库不能被 asset 协议读到");
}

#[test]
fn highwater_and_environment_files_are_not_reachable() {
    for path in [
        format!("{APP_DATA}/state/highwater.sqlite"),
        format!("{APP_DATA}/environment.json"),
        format!("{APP_DATA}/state/active.json"),
        format!("{APP_DATA}/recovery/state.json"),
        format!("{APP_DATA}/.write.lock"),
    ] {
        assert!(!allowed(&path), "{path} 不应可读");
    }
}

#[test]
fn generation_root_artifacts_are_not_reachable() {
    // 代际目录本身（database.sqlite 所在层）不应被整体放行
    let dir = format!("{APP_DATA}/generations/{GEN}");
    assert!(!allowed(&dir));
    let sibling = format!("{APP_DATA}/generations/{GEN}/attachments");
    assert!(!allowed(&sibling), "只放行附件的两级子目录");
}

#[test]
fn glob_matching_alone_does_not_normalize_dot_segments() {
    // 这是一个必须如实记录的局限：glob 是**纯文本**匹配，
    // `attachments/**` 会匹配 `attachments/../database.sqlite` 这种字符串。
    // 因此不能只依赖 scope 文本匹配，还需要：
    //   1) 后端永不向前端返回含 `..` 或越界的路径（见 attachments 集成测试）；
    //   2) Tauri 运行时的路径规范化（本轮无法在无 WebView 的环境里验证）。
    let traversal = format!("{APP_DATA}/generations/{GEN}/attachments/../database.sqlite");
    assert!(
        allowed(&traversal),
        "如果这条断言失败，说明 glob 语义变了，需要重新评估结论"
    );
}

#[test]
fn paths_outside_app_data_are_rejected() {
    for path in ["/etc/passwd".to_string(), "/tmp/evil.png".to_string()] {
        assert!(!allowed(&path), "{path} 必须被拒绝");
    }
    let tv = "/Users/someone/Library/Application Support/dev.artflow.minidesk.tv01/minidesk-tv01.sqlite";
    assert!(!allowed(tv));
}

#[test]
fn other_generation_attachments_stay_inside_their_own_generation() {
    // 另一个代际的附件同样在 scope 内（都是合法图片），但不包括它的数据库。
    let other = "gen-f8930531c59f437795d99d28a7ae25c5";
    assert!(allowed(&format!(
        "{APP_DATA}/generations/{other}/attachments/originals/b.jpg"
    )));
    assert!(!allowed(&format!("{APP_DATA}/generations/{other}/database.sqlite")));
}

#[test]
fn scope_does_not_cover_the_tv_experiment_directory() {
    let tv = "/Users/someone/Library/Application Support/dev.artflow.minidesk.tv01/tv03-sandbox/generations/x/attachments/originals/a.png";
    assert!(!allowed(tv), "TV 实验目录不在本应用的 asset scope 内");
}
