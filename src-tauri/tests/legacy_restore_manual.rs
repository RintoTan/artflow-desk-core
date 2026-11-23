//! UX-04：真实旧版备份 ZIP → 当前 schema 的端到端恢复。
//!
//! 这个测试**默认跳过**：它需要一个真实的旧备份文件，CI 与环境里没有。
//! 用法（在 src-tauri 下）：
//!
//! ```sh
//! LEGACY_ZIP="/path/to/old-backup.zip" \
//!   cargo test --test legacy_restore_manual -- --ignored --nocapture
//! ```
//!
//! 为什么单独存在：迁移测试只能证明「v8 库能升到 v9」，不能证明
//! 「v2 版本的 ZIP 包能被解析、校验、迁移、落盘、附件完整」。
//! 后者要跑真实 restore 链路，才算端到端。

mod common;

use std::path::Path;

use minidesk::backup::{restore, zip_read};
use minidesk::store::environment::Environment;
use minidesk::store::highwater::HighWater;
use minidesk::store::migrations;

fn open(root: &Path) -> Environment {
    common::open(root)
}

#[test]
#[ignore = "需要 LEGACY_ZIP 指向真实旧版备份"]
fn restores_a_real_legacy_zip_end_to_end() {
    let zip = std::env::var("LEGACY_ZIP").expect("请用 LEGACY_ZIP 指向真实旧备份");
    let zip = Path::new(&zip);
    assert!(zip.exists(), "备份文件不存在：{}", zip.display());

    let inspection = zip_read::inspect(zip).expect("校验失败");
    println!(
        "旧备份：schema v{} · format v{} · app {} · 附件 {} 个",
        inspection.manifest.schema_version,
        inspection.manifest.format_version,
        inspection.manifest.app_version,
        inspection.manifest.files.len().saturating_sub(1)
    );
    assert!(
        inspection.manifest.schema_version < migrations::APP_SCHEMA_VERSION,
        "这个用例只用于旧版备份；当前文件已经是 v{}",
        inspection.manifest.schema_version
    );

    let dir = tempfile::tempdir().unwrap();
    let env = open(&dir.path().join("restored"));
    let hw = HighWater::open(&env.layout().highwater_db()).unwrap();

    // 两条合法结局，除此之外都算失败：
    //  A. 同一血统的旧备份 → 迁移成功；
    //  B. 血统不匹配（如 tv03 原型沙箱）→ 必须给出「结构不兼容」的明确结论，
    //     而不是一句没上下文的 "no such table"。
    let outcome = restore::restore(&env, &hw, zip, &migrations::production());
    let restored = match outcome {
        Ok(restored) => {
            println!(
                "恢复完成：orders={} clients={} templates={} attachments={}",
                restored.summary.orders,
                restored.summary.clients,
                restored.summary.templates,
                restored.summary.attachments
            );
            println!("warnings: {:#?}", restored.warnings);
            restored
        }
        Err(e) => {
            println!("不可自动恢复：code={} message={}", e.code, e.message);
            assert_eq!(e.code, "SCHEMA", "结构不兼容必须报 SCHEMA，而不是 DB/ZIP");
            assert!(
                e.message.contains("不兼容") && e.message.contains("基础表"),
                "错误信息必须说清原因与处理方式：{}",
                e.message
            );
            return;
        }
    };

    let conn = env.open_db().unwrap();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, migrations::APP_SCHEMA_VERSION, "恢复后必须停在当前 schema");

    // 新列必须可用（v9 的 archived_at 在视图里也要能读到）。
    let archived: Option<String> = conn
        .query_row("SELECT archived_at FROM orders_visible LIMIT 1", [], |r| r.get(0))
        .unwrap();
    assert!(archived.is_none(), "旧备份里的订单默认未归档");

    // 附件必须真的落盘，而不是只在清单里。
    let originals = env.layout().attachments_dir(&env.active_generation()).join("originals");
    let files = std::fs::read_dir(&originals).unwrap().count();
    println!("落盘附件：{files} 个 → {}", originals.display());
    assert!(files > 0, "备份里有附件，恢复后目录却是空的");
    assert_eq!(
        files as i64, restored.summary.attachments,
        "落盘数量与摘要不一致"
    );
}
