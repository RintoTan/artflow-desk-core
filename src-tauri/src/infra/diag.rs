//! 轻量诊断日志。
//!
//! 为什么需要它：Windows 的 release 包是 `windows_subsystem = "windows"`，
//! `println!` 没有控制台可去；启动失败、或被锁挡下时，用户只看到"点了没反应"。
//! 这里把启动/窗口/退出/失败四类事件写到应用数据目录里，出问题时有据可查。
//!
//! 约束：
//! - 只写应用自己的数据目录（正式与 QA 标识天然分离）；
//! - 只记事件与错误，不写订单内容、客户信息、路径之外的用户数据；
//! - 单文件上限 1 MiB，超出后滚动为 `app.log.1`，不会无限增长。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

pub const LOG_DIR: &str = "logs";
pub const LOG_FILE: &str = "app.log";
pub const MAX_BYTES: u64 = 1024 * 1024;

struct Sink {
    dir: PathBuf,
    limit: u64,
}

static SINK: OnceLock<Mutex<Option<Sink>>> = OnceLock::new();

fn sink() -> &'static Mutex<Option<Sink>> {
    SINK.get_or_init(|| Mutex::new(None))
}

/// 绑定日志目录（通常是 `app_data_dir()`）。失败时静默降级：日志不能反过来挡住启动。
pub fn init(dir: &Path) {
    let mut guard = match sink().lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if fs::create_dir_all(dir).is_err() {
        *guard = None;
        return;
    }
    *guard = Some(Sink {
        dir: dir.to_path_buf(),
        limit: MAX_BYTES,
    });
}

/// 追加一行。写盘失败不影响调用方。
pub fn log(scope: &str, detail: &str) {
    let guard = match sink().lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(s) = guard.as_ref() {
        append(s, scope, detail);
    }
}

/// 没有可用目录时的兜底：stderr。GUI 子系统下看不见，但测试与终端启动时有效。
pub fn log_or_stderr(scope: &str, detail: &str) {
    log(scope, detail);
    eprintln!("[{scope}] {detail}");
}

fn append(sink: &Sink, scope: &str, detail: &str) {
    let line = format!(
        "{} [{scope}] {}\n",
        chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        detail.trim_end()
    );
    let path = sink.dir.join(LOG_FILE);
    let current = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if current > 0 && current + line.len() as u64 > sink.limit {
        rotate(&path);
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
        let _ = f.flush();
    }
}

fn rotate(path: &Path) {
    let backup = path.with_extension("log.1");
    let _ = fs::remove_file(&backup);
    let _ = fs::rename(path, backup);
}

/// 当前日志文件路径（诊断报告里提示用户去找）。
pub fn log_path() -> Option<PathBuf> {
    let guard = sink().lock().ok()?;
    guard.as_ref().map(|s| s.dir.join(LOG_FILE))
}

/// 致命错误提示：优先用 Tauri 的原生对话框，失败时退回平台自带消息框。
pub fn show_fatal(app: &tauri::AppHandle, title: &str, message: &str) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    let shown = app
        .dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Error)
        .blocking_show();
    if !shown {
        native_message(title, message);
    }
}

/// 应用还没构建出来（例如 WebView 创建失败）时的兜底消息框。
pub fn native_message(title: &str, message: &str) {
    #[cfg(windows)]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;

        #[link(name = "user32")]
        extern "system" {
            fn MessageBoxW(
                hwnd: *mut core::ffi::c_void,
                text: *const u16,
                caption: *const u16,
                utype: u32,
            ) -> i32;
        }

        let wide = |s: &str| -> Vec<u16> {
            OsStr::new(s)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect()
        };
        let text = wide(message);
        let caption = wide(title);
        // 0x10 = MB_ICONERROR
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                text.as_ptr(),
                caption.as_ptr(),
                0x10,
            );
        }
    }
    #[cfg(not(windows))]
    {
        eprintln!("{title}: {message}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "afd-diag-{tag}-{}-{}",
            std::process::id(),
            chrono::Local::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn appends_lines_with_scope() {
        let dir = temp_dir("append");
        let sink = Sink {
            dir: dir.clone(),
            limit: MAX_BYTES,
        };
        append(&sink, "startup", "hello");
        let body = fs::read_to_string(dir.join(LOG_FILE)).unwrap();
        assert!(body.contains("[startup] hello"));
        assert_eq!(body.lines().count(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotates_before_exceeding_limit() {
        let dir = temp_dir("rotate");
        let sink = Sink {
            dir: dir.clone(),
            limit: 200,
        };
        for i in 0..20 {
            append(&sink, "exit", &format!("line {i} padding-padding"));
        }
        let backup = dir.join("app.log.1");
        assert!(backup.is_file(), "超出上限后应生成滚动文件");
        let size = fs::metadata(dir.join(LOG_FILE)).unwrap().len();
        assert!(size <= 200, "滚动后当前文件不应超过上限：{size}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_detail_is_allowed() {
        let dir = temp_dir("empty");
        let sink = Sink {
            dir: dir.clone(),
            limit: MAX_BYTES,
        };
        append(&sink, "window", "");
        let body = fs::read_to_string(dir.join(LOG_FILE)).unwrap();
        assert!(body.contains("[window]"));
        let _ = fs::remove_dir_all(&dir);
    }
}
