//! 命令面安全：显式白名单、负向样本、最小权限、无通用危险入口。

/// 独立维护的批准清单。**不得**从注册列表自动生成。
const APPROVED: &[&str] = &[
    "environment_status",
    "working_timezone_get",
    "working_timezone_set",
    "create_order",
    "list_orders",
    "get_order",
    "list_order_events",
    "list_clients",
    "update_order_details",
    "start_work",
    "undo_start_work",
    "advance_stage",
    "rework_stage",
    "complete_order",
    "cancel_order",
    "reopen_order",
    "workflow_add_stage",
    "workflow_rename_stage",
    "workflow_remove_stage",
    "workflow_reorder_stages",
];

/// 解析 `generate_handler![...]` 并取每项最后一段标识符。
fn parse_handlers(source: &str) -> Result<Vec<String>, String> {
    let start = source
        .find("generate_handler![")
        .ok_or("缺少 generate_handler!")?;
    let rest = &source[start + "generate_handler![".len()..];
    let end = rest.find(']').ok_or("generate_handler! 未闭合")?;
    let mut names: Vec<String> = rest[..end]
        .split(',')
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
        .map(|item| {
            item.rsplit("::")
                .next()
                .unwrap_or(item)
                .trim()
                .to_string()
        })
        .collect();
    names.sort();
    Ok(names)
}

fn check(source: &str) -> Result<Vec<String>, String> {
    let actual = parse_handlers(source)?;
    let mut expected: Vec<String> = APPROVED.iter().map(|s| s.to_string()).collect();
    expected.sort();

    let unknown: Vec<&String> = actual.iter().filter(|a| !expected.contains(a)).collect();
    let missing: Vec<&String> = expected.iter().filter(|e| !actual.contains(e)).collect();
    if !unknown.is_empty() || !missing.is_empty() {
        return Err(format!("未批准命令 {unknown:?}；清单缺失 {missing:?}"));
    }
    Ok(actual)
}

#[test]
fn registered_commands_match_the_approved_allowlist() {
    let source = include_str!("../src/lib.rs");
    let actual = check(source).expect("注册命令必须与批准清单完全一致");
    assert_eq!(actual.len(), APPROVED.len());
    assert_eq!(actual, {
        let mut v: Vec<String> = APPROVED.iter().map(|s| s.to_string()).collect();
        v.sort();
        v
    });
}

#[test]
fn unknown_command_is_caught() {
    let injected = r#"
        .invoke_handler(tauri::generate_handler![
            commands::status::environment_status,
            commands::evil::run_sql,
            commands::orders::create_order
        ])
    "#;
    let err = check(injected).expect_err("新增未知命令必须让检查失败");
    assert!(err.contains("run_sql"), "{err}");
    assert!(err.contains("未批准"), "{err}");
}

#[test]
fn removed_command_is_caught() {
    let injected = r#"
        .invoke_handler(tauri::generate_handler![
            commands::status::environment_status
        ])
    "#;
    let err = check(injected).expect_err("缺少已批准命令也必须失败");
    assert!(err.contains("清单缺失"), "{err}");
}

#[test]
fn allowlist_is_not_derived_from_the_source() {
    let source = include_str!("../src/lib.rs");
    assert!(
        !source.contains("APPROVED"),
        "白名单不得出现在注册代码里，否则等于自己和自己比"
    );
}

#[test]
fn experimental_and_dangerous_commands_are_absent() {
    let source = include_str!("../src/lib.rs");
    for forbidden in [
        "tv03_demo",
        "seed",
        "inject_failure",
        "execute_sql",
        "execute_batch",
        "run_sql",
        "delete_file",
        "remove_dir",
        "shell",
        "Command::new",
    ] {
        assert!(
            !source.contains(forbidden),
            "注册代码中不得出现 {forbidden}"
        );
    }
}

#[test]
fn lib_rs_contains_no_sql() {
    let source = include_str!("../src/lib.rs");
    for keyword in ["SELECT ", "INSERT ", "UPDATE ", "DELETE ", "CREATE TABLE", "PRAGMA"] {
        assert!(
            !source.contains(keyword),
            "lib.rs 不应包含 SQL（{keyword}），业务 SQL 属于 store/domain 层"
        );
    }
}

#[test]
fn command_layer_contains_no_sql() {
    for (name, source) in [
        ("status.rs", include_str!("../src/commands/status.rs")),
        ("preferences.rs", include_str!("../src/commands/preferences.rs")),
        ("orders.rs", include_str!("../src/commands/orders.rs")),
    ] {
        for keyword in ["SELECT ", "INSERT ", "UPDATE ", "DELETE ", "CREATE TABLE"] {
            assert!(
                !source.contains(keyword),
                "命令层 {name} 不应包含 SQL（{keyword}）"
            );
        }
    }
}

#[test]
fn capabilities_stay_minimal() {
    let caps = include_str!("../capabilities/default.json");
    let value: serde_json::Value = serde_json::from_str(caps).unwrap();
    let mut permissions: Vec<String> = value["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    permissions.sort();

    assert_eq!(
        permissions,
        vec![
            "core:default",
            "core:window:allow-close",
            "core:window:allow-destroy",
            "dialog:default",
        ]
    );
    for forbidden in ["fs:", "sql:", "shell:", "http:", "process:", "allow-execute"] {
        assert!(!caps.contains(forbidden), "不得出现 {forbidden} 权限");
    }
}

#[test]
fn frontend_never_touches_the_database_directly() {
    let bridge = include_str!("../../src/bridge/commands.ts");
    assert!(!bridge.contains("plugin-sql"), "前端不得直接使用 SQL 插件");
    assert!(!bridge.contains("plugin-fs"), "前端不得直接使用文件系统插件");
    assert!(bridge.contains("invoke"), "前端必须通过具名命令访问后端");
}

#[test]
fn bundle_config_does_not_include_probe_binaries() {
    let config = include_str!("../tauri.conf.json");
    for probe in ["minidesk-probe", "probe", "crash"] {
        assert!(
            !config.contains(probe),
            "打包配置不应引用测试探针（{probe}）"
        );
    }
}
