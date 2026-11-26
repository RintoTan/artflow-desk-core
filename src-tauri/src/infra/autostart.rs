//! 登录时自动启动：真正注册 / 取消操作系统的启动项。
//!
//! 只在数据库里记一个布尔值是不够的——下次登录应用不会自己起来，界面却显示
//! 「已开启」，这比没有开关更糟。所以状态一律以系统里的实际条目为准。
//!
//! - macOS：`~/Library/LaunchAgents/<label>.plist`，`RunAtLoad` 为真。
//! - Windows：`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`。
//!
//! 注册时不主动触发一次启动：`RunAtLoad` 只在登录时生效，立刻 bootstrap
//! 会跟正在运行的实例抢单实例锁，弹一个莫名其妙的提示。

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::error::{AppError, AppResult};

/// 与 `tauri.conf.json` 的 identifier 一致；`label_matches_identifier` 单测会核对。
pub const LABEL: &str = "dev.artflow.minidesk";
/// Windows 注册表里的值名。
pub const WINDOWS_VALUE: &str = "ArtFlowDeskCore";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartStatus {
    /// 系统里是否真的存在指向本程序的启动项。
    pub enabled: bool,
    /// 当前平台是否支持。不支持的平台不会假装成功。
    pub supported: bool,
    /// 实际位置，或者没开启的原因。界面直接展示，不猜。
    pub detail: String,
}

enum Platform {
    Mac,
    Windows,
    Other,
}

fn platform() -> Platform {
    if cfg!(target_os = "macos") {
        Platform::Mac
    } else if cfg!(target_os = "windows") {
        Platform::Windows
    } else {
        Platform::Other
    }
}

fn unsupported() -> AutostartStatus {
    AutostartStatus {
        enabled: false,
        supported: false,
        detail: "当前系统不支持自动启动".to_string(),
    }
}

pub fn current_exe() -> AppResult<PathBuf> {
    std::env::current_exe().map_err(|e| AppError::io(format!("取不到程序自身路径：{e}")))
}

pub fn status(exe: &Path) -> AutostartStatus {
    match platform() {
        Platform::Mac => mac::status(exe),
        Platform::Windows => windows::status(exe),
        Platform::Other => unsupported(),
    }
}

pub fn set(exe: &Path, enabled: bool) -> AppResult<AutostartStatus> {
    match platform() {
        Platform::Mac => mac::set(exe, enabled),
        Platform::Windows => windows::set(exe, enabled),
        Platform::Other => Ok(unsupported()),
    }
}

mod mac {
    use super::*;

    fn home() -> Option<PathBuf> {
        std::env::var_os("HOME").map(PathBuf::from)
    }

    pub(super) fn plist_path(home: &Path) -> PathBuf {
        home.join("Library")
            .join("LaunchAgents")
            .join(format!("{LABEL}.plist"))
    }

    fn escaped(path: &Path) -> String {
        path.to_string_lossy()
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    }

    pub(super) fn body(exe: &Path) -> String {
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
             <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
             <plist version=\"1.0\">\n\
             <dict>\n\
             \t<key>Label</key>\n\
             \t<string>{LABEL}</string>\n\
             \t<key>ProgramArguments</key>\n\
             \t<array>\n\
             \t\t<string>{}</string>\n\
             \t</array>\n\
             \t<key>RunAtLoad</key>\n\
             \t<true/>\n\
             \t<key>ProcessType</key>\n\
             \t<string>Interactive</string>\n\
             </dict>\n\
             </plist>\n",
            escaped(exe)
        )
    }

    /// 只取 ProgramArguments 里的第一个参数：判断启动项是不是指向当前程序。
    fn program_of(body: &str) -> Option<String> {
        let after = body.split("<key>ProgramArguments</key>").nth(1)?;
        let start = after.find("<string>")? + "<string>".len();
        let end = start + after[start..].find("</string>")?;
        Some(
            after[start..end]
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&amp;", "&"),
        )
    }

    pub(super) fn status_at(home: &Path, exe: &Path) -> AutostartStatus {
        let path = plist_path(home);
        let body = match std::fs::read_to_string(&path) {
            Ok(body) => body,
            Err(_) => {
                return AutostartStatus {
                    enabled: false,
                    supported: true,
                    detail: "未注册登录启动项".to_string(),
                }
            }
        };
        match program_of(&body) {
            Some(program) if program == exe.to_string_lossy() => AutostartStatus {
                enabled: true,
                supported: true,
                detail: path.display().to_string(),
            },
            // 程序被移动或换过构建后，旧条目指向一个已经不存在的位置：
            // 显示成「已开启」是骗人的，必须让用户重新开启一次。
            other => AutostartStatus {
                enabled: false,
                supported: true,
                detail: match other {
                    Some(program) => format!("启动项指向 {program}，与当前程序不一致，重新开启即可更新"),
                    None => "启动项内容无法识别，重新开启即可覆盖".to_string(),
                },
            },
        }
    }

    pub(super) fn set_at(home: &Path, exe: &Path, enabled: bool) -> AppResult<AutostartStatus> {
        let path = plist_path(home);
        if enabled {
            let dir = path.parent().expect("plist 路径一定有父目录");
            std::fs::create_dir_all(dir)
                .map_err(|e| AppError::io(format!("创建 {} 失败：{e}", dir.display())))?;
            let tmp = dir.join(format!("{LABEL}.plist.tmp"));
            std::fs::write(&tmp, body(exe))
                .map_err(|e| AppError::io(format!("写入 {} 失败：{e}", tmp.display())))?;
            std::fs::rename(&tmp, &path)
                .map_err(|e| AppError::io(format!("替换 {} 失败：{e}", path.display())))?;
        } else if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|e| AppError::io(format!("删除 {} 失败：{e}", path.display())))?;
        }
        Ok(status_at(home, exe))
    }

    pub(super) fn status(exe: &Path) -> AutostartStatus {
        match home() {
            Some(home) => status_at(&home, exe),
            None => AutostartStatus {
                enabled: false,
                supported: true,
                detail: "找不到用户主目录，无法确认登录启动项".to_string(),
            },
        }
    }

    pub(super) fn set(exe: &Path, enabled: bool) -> AppResult<AutostartStatus> {
        let home = home().ok_or_else(|| AppError::io("找不到用户主目录，无法写入登录启动项"))?;
        set_at(&home, exe, enabled)
    }
}

mod windows {
    use super::*;

    const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

    fn same_path(value: &str, exe: &Path) -> bool {
        let left = value.trim().trim_matches('"');
        left.eq_ignore_ascii_case(&exe.to_string_lossy())
    }

    fn query(exe: &Path) -> AutostartStatus {
        let out = Command::new("reg")
            .args(["query", KEY, "/v", WINDOWS_VALUE])
            .output();
        let value = match out {
            Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
                .lines()
                // 「REG_SZ」这个词本身不随系统语言变化，用它切开比按列对齐稳。
                .find_map(|line| line.split_once("REG_SZ").map(|(_, v)| v.trim().to_string())),
            _ => None,
        };
        match value {
            Some(value) if same_path(&value, exe) => AutostartStatus {
                enabled: true,
                supported: true,
                detail: format!("{KEY}\\{WINDOWS_VALUE}"),
            },
            Some(value) => AutostartStatus {
                enabled: false,
                supported: true,
                detail: format!("启动项指向 {value}，与当前程序不一致，重新开启即可更新"),
            },
            None => AutostartStatus {
                enabled: false,
                supported: true,
                detail: "未注册登录启动项".to_string(),
            },
        }
    }

    pub(super) fn status(exe: &Path) -> AutostartStatus {
        query(exe)
    }

    pub(super) fn set(exe: &Path, enabled: bool) -> AppResult<AutostartStatus> {
        let out = if enabled {
            Command::new("reg")
                .args([
                    "add",
                    KEY,
                    "/v",
                    WINDOWS_VALUE,
                    "/t",
                    "REG_SZ",
                    "/d",
                    // 路径里有空格，注册表里必须带引号，否则登录时按空格截断。
                    &format!("\"{}\"", exe.display()),
                    "/f",
                ])
                .output()
        } else {
            Command::new("reg")
                .args(["delete", KEY, "/v", WINDOWS_VALUE, "/f"])
                .output()
        };
        let out = out.map_err(|e| AppError::io(format!("调用系统命令 reg 失败：{e}")))?;
        if !out.status.success() {
            // 删除一个本来就不存在的值会失败，这种情况按「已经是关闭」处理。
            if !enabled {
                return Ok(query(exe));
            }
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(AppError::io(format!(
                "写入登录启动项失败：{}",
                stderr.trim()
            )));
        }
        Ok(query(exe))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDENTIFIER: &str = include_str!("../../tauri.conf.json");

    #[test]
    fn label_matches_identifier() {
        let needle = format!("\"identifier\": \"{LABEL}\"");
        assert!(
            IDENTIFIER.contains(&needle),
            "登录启动项的 Label 必须与 tauri.conf.json 的 identifier 一致"
        );
    }

    #[test]
    fn plist_points_at_the_given_executable() {
        let body = mac::body(Path::new("/Applications/ArtFlow Desk Core.app/Contents/MacOS/artflow-minidesk"));
        assert!(body.contains("<string>/Applications/ArtFlow Desk Core.app/Contents/MacOS/artflow-minidesk</string>"));
        assert!(body.contains("<key>RunAtLoad</key>"));
    }

    #[test]
    fn enabling_writes_a_launch_agent_and_disabling_removes_it() {
        let home = tempfile::tempdir().expect("tempdir");
        let exe = Path::new("/tmp/fake/artflow-minidesk");

        let before = mac::status_at(home.path(), exe);
        assert!(!before.enabled);
        assert!(before.detail.contains("未注册"));

        let on = mac::set_at(home.path(), exe, true).expect("开启");
        assert!(on.enabled, "{}", on.detail);
        assert!(mac::plist_path(home.path()).exists());

        let off = mac::set_at(home.path(), exe, false).expect("关闭");
        assert!(!off.enabled);
        assert!(!mac::plist_path(home.path()).exists());
    }

    #[test]
    fn a_launch_agent_pointing_elsewhere_is_not_reported_as_enabled() {
        let home = tempfile::tempdir().expect("tempdir");
        let path = mac::plist_path(home.path());
        std::fs::create_dir_all(path.parent().expect("dir")).expect("mkdir");
        std::fs::write(&path, mac::body(Path::new("/old/place/artflow-minidesk"))).expect("write");

        let status = mac::status_at(home.path(), Path::new("/new/place/artflow-minidesk"));
        assert!(!status.enabled);
        assert!(status.detail.contains("/old/place/artflow-minidesk"), "{}", status.detail);
    }

    #[test]
    fn special_characters_in_the_path_are_escaped() {
        let body = mac::body(Path::new("/tmp/a&b/artflow-minidesk"));
        assert!(body.contains("/tmp/a&amp;b/artflow-minidesk"));
    }
}
