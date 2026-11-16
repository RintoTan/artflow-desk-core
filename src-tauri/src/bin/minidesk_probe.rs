//! 测试用子进程探针：验证跨进程目录锁。
//!
//! 只用于开发与测试，不随产品安装包分发。
//! 模式：
//!   try <dir>          尝试以正式启动路径打开环境
//!   hold <dir> <秒>    打开后持有若干秒
//!   hold-crash <dir>   打开后 abort（模拟崩溃）
//!   reserve <dir>      预留一个编号并打印（验证跨进程编号连续）
//!   reserve-crash <dir> 预留编号后立即 abort（验证已保留编号不会因崩溃被复用）

use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

use minidesk::infra::state::AppState;

fn say(text: &str) {
    println!("{text}");
    std::io::stdout().flush().ok();
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(String::as_str).unwrap_or("");
    let dir = PathBuf::from(args.get(2).cloned().unwrap_or_default());

    match mode {
        "try" => match AppState::open(&dir) {
            Ok(state) => say(&format!(
                "ACQUIRED pid={} generation={}",
                std::process::id(),
                state.env.active_generation()
            )),
            Err(e) => {
                say(&format!("BUSY code={} message={}", e.code, e.message));
                std::process::exit(3);
            }
        },
        "hold" => {
            let _state = AppState::open(&dir).expect("acquire");
            let secs: u64 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(3);
            say(&format!("LOCKED pid={}", std::process::id()));
            std::thread::sleep(Duration::from_secs(secs));
            say("RELEASING");
        }
        "hold-crash" => {
            let _state = AppState::open(&dir).expect("acquire");
            say(&format!("LOCKED pid={}", std::process::id()));
            std::process::abort();
        }
        "reserve" => {
            let state = AppState::open(&dir).expect("open");
            let now = minidesk::store::timezone::now_timestamp();
            let tz = minidesk::store::settings::working_timezone(&state.env.open_db().unwrap())
                .expect("tz");
            let code = minidesk::domain::numbering::reserve(&state.highwater, &now, tz).expect("reserve");
            say(&format!("RESERVED {code}"));
        }
        "reserve-crash" => {
            let state = AppState::open(&dir).expect("open");
            let now = minidesk::store::timezone::now_timestamp();
            let tz = minidesk::store::settings::working_timezone(&state.env.open_db().unwrap())
                .expect("tz");
            let code = minidesk::domain::numbering::reserve(&state.highwater, &now, tz).expect("reserve");
            say(&format!("RESERVED {code}"));
            std::process::abort();
        }
        other => panic!("未知模式：{other}"),
    }
}
