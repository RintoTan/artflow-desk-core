//! macOS 应用菜单：把 Cmd+Q 从"系统直接终止"改成"我们的退出请求"。
//!
//! ## 为什么必须换掉默认菜单
//!
//! Tauri 2.12.5 的默认菜单用 `PredefinedMenuItem::quit`，它在 macOS 上绑定的是
//! `NSApplication terminate:`（muda-0.20.0 `platform_impl/macos/mod.rs:944`）。
//! 而 tao 的 AppDelegate 只实现了 `applicationWillTerminate:`，
//! **没有实现 `applicationShouldTerminate:`**（tao-0.37.2 `app_delegate.rs`），
//! 于是系统直接按 `NSTerminateNow` 结束进程。
//!
//! `RunEvent::ExitRequested` 只在两处产生（tauri-runtime-wry-2.12.3 `lib.rs:4262/4302`）：
//! 窗口全部销毁、或 `AppHandle::exit()` 主动请求。Cmd+Q 走的 terminate: 两个都不经过，
//! 所以之前注册的 `prevent_exit` 根本不会被执行——这就是实机 Cmd+Q 直接退出的原因。
//!
//! ## 做法
//!
//! 自建菜单：Quit 换成**自定义菜单项**（不再绑定 `terminate:`），accelerator 仍是 Cmd+Q，
//! 点击后在 `on_menu_event` 里发 `app://exit-requested` 给界面。
//! 同时保留 `RunEvent::ExitRequested` 作为第二条网（窗口全关、`app.exit` 请求仍然会走它）。
//!
//! 编辑菜单必须一起建：macOS 的复制/粘贴/全选快捷键来自菜单，只留 App 菜单会让输入框失去 Cmd+C/V。

use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{App, Emitter};

pub const QUIT_MENU_ID: &str = "quit";

/// 安装应用菜单。只在 macOS 上调用。
pub fn install(app: &mut App) -> tauri::Result<()> {
    let quit = MenuItemBuilder::with_id(QUIT_MENU_ID, "退出 ArtFlow Desk Core")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;

    let app_menu = SubmenuBuilder::new(app, "ArtFlow Desk Core")
        .item(&PredefinedMenuItem::about(app, None, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&quit)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "编辑")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "窗口")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&edit_menu)
        .item(&window_menu)
        .build()?;

    app.set_menu(menu)?;
    println!(
        "[minidesk] menu installed quit_id={QUIT_MENU_ID} accelerator=CmdOrCtrl+Q kind=custom"
    );
    Ok(())
}

/// 菜单事件分发。命中 Quit 时发退出请求，由界面决定是否真的退。
pub fn handle_menu_event(app: &tauri::AppHandle, id: &str) {
    if is_quit(id) {
        let _ = app.emit("app://exit-requested", ());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_quit_item_requests_exit() {
        assert!(is_quit(QUIT_MENU_ID));
        assert!(!is_quit("close"));
        assert!(!is_quit(""));
        assert!(!is_quit("quit-other"));
    }
}

/// 与 `handle_menu_event` 共用的判定，单独抽出来便于测试。
pub fn is_quit(id: &str) -> bool {
    id == QUIT_MENU_ID
}
