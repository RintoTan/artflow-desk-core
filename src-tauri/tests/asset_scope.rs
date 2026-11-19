//! asset 协议访问范围：只放行**当前代际**的附件目录。
//!
//! v2 变更：scope 不再有静态 glob，改为启动时按活动代际 `allow_directory`。
//! 原因是静态写 `generations/*/attachments/**` 等于允许通过 asset URL 读任意代际的附件
//! —— 真实 WKWebView 里实测确实能读到别的代际的图（见 03 报告 S3/S9）。
//!
//! 这是**配置层**的验证：用与 Tauri scope 相同的通配语义（glob）匹配真实绝对路径。
//! 它不能替代对运行时拦截行为的验证（那需要真实 WebView 发请求），这一点在报告里写明。

use glob::Pattern;

const APP_DATA: &str = "/Users/someone/Library/Application Support/dev.artflow.minidesk";
const GEN: &str = "gen-e05d7ce65b8d40c0a0d23bedf18476ee";

/// 运行时实际生效的允许范围：活动代际的 attachments 目录（递归）。
fn scope_patterns() -> Vec<Pattern> {
    let layout = minidesk::store::paths::Layout::new(std::path::Path::new(APP_DATA));
    let dir = layout.attachments_dir(GEN);
    let text = format!("{}/**", dir.to_string_lossy());
    vec![Pattern::new(&text).expect("scope 必须是合法 glob")]
}

fn allowed(path: &str) -> bool {
    scope_patterns().iter().any(|p| p.matches(path))
}

#[test]
fn config_has_no_static_asset_scope() {
    // 静态 glob 无法表达"活动代际"，一旦写 `generations/*/attachments/**` 就等于放开跨代际读取。
    for file in ["../tauri.conf.json", "../tauri.qa.conf.json"] {
        let raw = if file.ends_with("qa.conf.json") {
            include_str!("../tauri.qa.conf.json")
        } else {
            include_str!("../tauri.conf.json")
        };
        let value: serde_json::Value = serde_json::from_str(raw).unwrap();
        let entries = value["app"]["security"]["assetProtocol"]["scope"]
            .as_array()
            .unwrap_or_else(|| panic!("{file} 必须有 scope 数组（可以为空）"));
        assert!(
            entries.is_empty(),
            "{file} 不允许再有静态 asset scope：跨代际通配会被真实 WebView 利用"
        );
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
fn other_generation_attachments_are_out_of_scope() {
    // 本轮的收紧点：只有当前代际的附件在允许范围内。
    let other = "gen-f8930531c59f437795d99d28a7ae25c5";
    assert!(
        !allowed(&format!(
            "{APP_DATA}/generations/{other}/attachments/originals/b.jpg"
        )),
        "别的代际的附件不应可读"
    );
    assert!(!allowed(&format!("{APP_DATA}/generations/{other}/database.sqlite")));
}

#[test]
fn scope_does_not_cover_the_tv_experiment_directory() {
    let tv = "/Users/someone/Library/Application Support/dev.artflow.minidesk.tv01/tv03-sandbox/generations/x/attachments/originals/a.png";
    assert!(!allowed(tv), "TV 实验目录不在本应用的 asset scope 内");
}
