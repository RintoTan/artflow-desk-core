//! 单实例激活通道（`DATA-LIFECYCLE §8`）。
//!
//! 第二次启动时不弹「已有进程」的死路：先请已经运行的实例把窗口拉到前面，
//! 再安静退出。通道位置必须挂在**应用数据目录**上——数据根可以随时被迁移，
//! 而这条通道必须始终能找到同一个进程。
//!
//! - macOS：Unix Domain Socket
//! - Windows：命名管道
//!
//! 通道只承载「activate」一个意图，不做任何数据交换，也不接受远端连接。

use std::path::{Path, PathBuf};

use crate::error::AppResult;

/// 通道在当前平台上的位置。
///
/// Unix 直接返回 socket 路径；Windows 返回一个用于推导管道名的稳定路径，
/// 不会真的在这个位置创建文件。
pub fn endpoint(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(".instance")
}

#[cfg(unix)]
mod imp {
    use std::io::{Read, Write};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::Path;
    use std::thread;

    use crate::error::{AppError, AppResult};

    const MESSAGE: &[u8] = b"activate";

    pub fn request(endpoint: &Path) -> bool {
        let mut stream = match UnixStream::connect(endpoint) {
            Ok(s) => s,
            Err(_) => return false,
        };
        let sent = stream.write_all(MESSAGE).is_ok() && stream.flush().is_ok();
        // 等对端读完再走，避免消息还留在缓冲区时进程就退出。
        let mut ack = [0u8; 2];
        let _ = stream.read(&mut ack);
        sent
    }

    pub fn serve(endpoint: &Path, on_activate: impl Fn() + Send + 'static) -> AppResult<()> {
        // 上次崩溃留下的 socket 文件会挡住 bind；此时没人监听，删掉是安全的。
        // 走到这里说明已经拿到了数据目录锁，不可能有别的实例在服务。
        if endpoint.exists() && !request(endpoint) {
            let _ = std::fs::remove_file(endpoint);
        }
        let listener = UnixListener::bind(endpoint)
            .map_err(|e| AppError::env(format!("无法建立单实例通道：{e}")))?;

        thread::Builder::new()
            .name("activate-listener".into())
            .spawn(move || {
                for stream in listener.incoming() {
                    let mut stream = match stream {
                        Ok(s) => s,
                        Err(_) => continue,
                    };
                    let mut buf = [0u8; 16];
                    let _ = stream.read(&mut buf);
                    if buf.starts_with(MESSAGE) {
                        on_activate();
                        // 回一个字节，让请求方确认真的有人接住了。
                        let _ = stream.write_all(b"ok");
                        let _ = stream.flush();
                    }
                }
            })
            .map_err(|e| AppError::env(format!("无法启动单实例监听线程：{e}")))?;
        Ok(())
    }
}

#[cfg(windows)]
mod imp {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::path::Path;
    use std::thread;
    use std::time::Duration;

    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, WriteFile, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE,
        PIPE_WAIT,
    };

    use crate::error::{AppError, AppResult};

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// 管道名由应用数据目录推导：正式与 QA 天然不同，不依赖可迁移的数据根。
    fn pipe_name(endpoint: &Path) -> String {
        let mut hasher = DefaultHasher::new();
        endpoint.to_string_lossy().hash(&mut hasher);
        format!(
            r"\\.\pipe\artflow-minidesk-{:016x}",
            hasher.finish()
        )
    }

    pub fn request(endpoint: &Path) -> bool {
        let name = wide(&pipe_name(endpoint));
        unsafe {
            let handle = CreateFileW(
                name.as_ptr(),
                FILE_GENERIC_WRITE,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                // htemplatefile 的类型是 HANDLE（*mut c_void），
                // 传 *const 的 null 会在 Windows 上编译失败（E0308）。
                std::ptr::null_mut(),
            );
            if handle == INVALID_HANDLE_VALUE {
                return false;
            }
            let payload = b"activate";
            let mut written = 0u32;
            let ok = WriteFile(handle, payload.as_ptr(), payload.len() as u32, &mut written, std::ptr::null_mut());
            CloseHandle(handle);
            ok != 0
        }
    }

    pub fn serve(endpoint: &Path, on_activate: impl Fn() + Send + 'static) -> AppResult<()> {
        let name = wide(&pipe_name(endpoint));
        thread::Builder::new()
            .name("activate-listener".into())
            .spawn(move || loop {
                unsafe {
                    // 参数顺序按 kernel32：名称、打开模式、管道模式、实例数、
                    // 输出/输入缓冲、默认超时、安全属性。
                    let handle = CreateNamedPipeW(
                        name.as_ptr(),
                        0,
                        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                        1,
                        512,
                        512,
                        0,
                        std::ptr::null(),
                    );
                    if handle == INVALID_HANDLE_VALUE {
                        // 建不出管道就退避重试，不能把整个进程拖死。
                        thread::sleep(Duration::from_millis(200));
                        continue;
                    }
                    // 没有客户端时阻塞等待；返回即代表有人连上来了。
                    ConnectNamedPipe(handle, std::ptr::null_mut());
                    on_activate();
                    DisconnectNamedPipe(handle);
                    CloseHandle(handle);
                }
            })
            .map_err(|e| AppError::env(format!("无法启动单实例监听线程：{e}")))?;
        Ok(())
    }
}

/// 请求已有实例激活窗口。返回 `true` 代表消息确实送到了活着的实例。
pub fn request(app_data_dir: &Path) -> bool {
    imp::request(&endpoint(app_data_dir))
}

/// 启动监听。只在成功取得数据目录锁之后调用。
pub fn serve(app_data_dir: &Path, on_activate: impl Fn() + Send + 'static) -> AppResult<()> {
    imp::serve(&endpoint(app_data_dir), on_activate)
}
