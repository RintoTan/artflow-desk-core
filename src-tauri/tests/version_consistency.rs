//! 四处版本号必须一致（APP-INFO）。
//!
//! 为什么值得一条测试：这四处由不同的人在不同的场合改——
//! `Cargo.toml` 决定界面显示（`env!("CARGO_PKG_VERSION")` 的三个消费点），
//! `tauri.conf.json` 决定安装包元数据（Info.plist / FileVersion），
//! `package.json` 是习惯，`windows-build.yml` 里那行是手抄的。
//!
//! 漏改任何一处都不会让构建失败：只会让 Finder 说 0.1.2、应用里说 0.1.0，
//! 或者备份包里记着一个不存在的版本。所以让测试替人记住。

use std::fs;
use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri 应当有上级目录")
        .to_path_buf()
}

fn read(relative: &str) -> String {
    let path = repo_root().join(relative);
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("读不到 {}：{e}", path.display()))
}

/// `Cargo.toml` 里只有 `[package]` 段的 version 是应用版本，依赖项的不能算。
fn cargo_package_version(text: &str) -> Option<String> {
    let mut in_package = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_package = trimmed == "[package]";
            continue;
        }
        if !in_package {
            continue;
        }
        let Some(rest) = trimmed.strip_prefix("version") else {
            continue;
        };
        let Some(rest) = rest.trim_start().strip_prefix('=') else {
            continue;
        };
        let rest = rest.trim();
        return rest
            .strip_prefix('"')
            .and_then(|r| r.split('"').next())
            .map(str::to_string);
    }
    None
}

/// YAML 里的 `APP_VERSION: "0.1.2"`。只认行首赋值，`$env:APP_VERSION` 那种引用不算。
fn yaml_app_version(text: &str) -> Option<String> {
    text.lines()
        .find(|line| line.trim_start().starts_with("APP_VERSION:"))
        .and_then(|line| line.split('"').nth(1))
        .map(str::to_string)
}

fn json_version(text: &str, label: &str) -> String {
    let value: serde_json::Value =
        serde_json::from_str(text).unwrap_or_else(|e| panic!("{label} 不是合法 JSON：{e}"));
    value
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| panic!("{label} 缺少 version 字段"))
        .to_string()
}

fn is_semver(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
}

/// 全部相同且形状合法才算通过；返回那个版本号。
fn compare(values: &[(&str, String)]) -> Result<String, String> {
    let (first_name, first) = values.first().ok_or_else(|| "没有可比较的版本号".to_string())?;
    if !is_semver(first) {
        return Err(format!("{first_name} 的版本号 `{first}` 不是 x.y.z 形式"));
    }
    for (name, value) in &values[1..] {
        if value != first {
            return Err(format!(
                "版本号不一致：{first_name} = {first}，{name} = {value}"
            ));
        }
    }
    Ok(first.clone())
}

#[test]
fn all_four_declare_the_same_version() {
    let cargo = read("src-tauri/Cargo.toml");
    let tauri = read("src-tauri/tauri.conf.json");
    let npm = read("package.json");
    let workflow = read(".github/workflows/windows-build.yml");

    let values = [
        (
            "src-tauri/Cargo.toml",
            cargo_package_version(&cargo).expect("Cargo.toml 的 [package] 段应有 version"),
        ),
        ("src-tauri/tauri.conf.json", json_version(&tauri, "tauri.conf.json")),
        ("package.json", json_version(&npm, "package.json")),
        (
            ".github/workflows/windows-build.yml",
            yaml_app_version(&workflow).expect("windows-build.yml 应有 APP_VERSION"),
        ),
    ];

    match compare(&values) {
        Ok(version) => assert!(is_semver(&version)),
        Err(message) => panic!("{message}"),
    }
}

/// 解析器本身不能空转：如果四个字段都读成空串，「全部相等」就是假通过。
#[test]
fn parsers_actually_read_a_value() {
    assert_eq!(
        cargo_package_version("[package]\nname = \"x\"\nversion = \"1.2.3\"\n\n[dependencies]\nserde = { version = \"1\" }\n"),
        Some("1.2.3".to_string())
    );
    assert_eq!(yaml_app_version("env:\n  APP_VERSION: \"1.2.3\"\n"), Some("1.2.3".to_string()));
    // 只出现在引用里的，不算赋值。
    assert_eq!(yaml_app_version("run: echo $env:APP_VERSION\n"), None);
}

#[test]
fn a_drifted_version_is_rejected() {
    let same = vec![("a", "0.1.2".to_string()), ("b", "0.1.2".to_string())];
    assert_eq!(compare(&same).as_deref(), Ok("0.1.2"));

    let drifted = vec![
        ("src-tauri/Cargo.toml", "0.1.2".to_string()),
        ("package.json", "0.1.1".to_string()),
    ];
    let message = compare(&drifted).expect_err("不一致必须报错");
    assert!(message.contains("0.1.1"), "{message}");

    let malformed = vec![("package.json", "0.1".to_string())];
    assert!(compare(&malformed).is_err());
}
