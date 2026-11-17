//! 测试用崩溃探针：在附件导入/修复的中途真实 `abort()`。
//!
//! 只用于开发与测试，不随产品安装包分发，也不注册为 Tauri 命令。
//! 用法：
//!   import-crash <root> <order_id> <image>
//!   repair-crash <root> <attachment_id> <image>

use std::io::Write;
use std::path::{Path, PathBuf};

use minidesk::domain::attachments::test_hooks;
use minidesk::infra::state::AppState;

fn say(text: &str) {
    println!("{text}");
    std::io::stdout().flush().ok();
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(String::as_str).unwrap_or("");
    let root = PathBuf::from(args.get(2).cloned().unwrap_or_default());
    let subject = args.get(3).cloned().unwrap_or_default();
    let image = PathBuf::from(args.get(4).cloned().unwrap_or_default());

    let state = AppState::open(&root).expect("打开数据环境失败");
    let mut conn = state.env.open_db().expect("打开数据库失败");
    let generation = state.env.active_generation().to_string();
    let layout = state.env.layout().clone();

    match mode {
        "import-crash" => {
            let (id, rel) = test_hooks::import_until_publish(
                &mut conn, &layout, &generation, &subject, Path::new(&image),
            )
            .expect("走到发布步骤失败");
            say(&format!("PUBLISHED id={id} rel={rel}"));
            std::process::abort();
        }
        "repair-crash" => {
            test_hooks::repair_until_publish(&mut conn, &layout, &generation, &subject, Path::new(&image))
                .expect("走到替换步骤失败");
            say(&format!("REPLACED id={subject}"));
            std::process::abort();
        }
        other => panic!("未知模式：{other}"),
    }
}
