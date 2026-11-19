# Windows Demo

## 当前状态

| 项 | 状态 |
| --- | --- |
| 构建工作流 | 已就绪：`.github/workflows/windows-build.yml` |
| 正式版 `.exe` + NSIS | **尚未生成**（等待 CI 运行） |
| QA 版 `.exe` + NSIS | **尚未生成** |
| 实机验收 | **未执行**（当前开发环境是 macOS） |

## 构建方式

GitHub Actions → `windows-build` → Run workflow（勾选 `build_qa`）：

1. `windows-latest` 上装 Node 20 + Rust MSVC；
2. `npm ci` → `npm run typecheck` → `npm run build` → `cargo test`；
3. `tauri build --target x86_64-pc-windows-msvc --bundles nsis`；
4. 正式版与 QA 版分别在两个 job 里构建，互不覆盖；
5. 产物 + `SHA256SUMS.txt` 上传为 artifact。

## 产物形态（预期）

```
ArtFlowDesk-Windows-Production/
├── artflow-minidesk.exe
├── ArtFlow Desk Core_0.1.0_x64-setup.exe
└── SHA256SUMS.txt

ArtFlowDesk-Windows-QA/
├── artflow-minidesk.exe
├── ArtFlow Desk Core QA_0.1.0_x64-setup.exe
├── SHA256SUMS.txt
└── Launchers/启动 QA Clean（空白环境）.cmd
```

实际文件名以 CI 输出为准。

## WebView2

未显式配置 `webviewInstallMode`，采用 Tauri 默认的 `downloadBootstrapper`：安装时若缺 WebView2 运行时会引导联网下载。

## 待实机验证

WebView2 运行时、`http://asset.localhost` 的 scope 行为、`%APPDATA%` 落盘路径、中文与空格路径、125%/150% DPI、Ctrl 快捷键、资源管理器拖拽导入、NSIS 安装/卸载/重装后的数据保留、与 macOS 的备份互恢复。

验收清单见仓库根的 `docs/DEV-09-WINDOWS-MANUAL-TEST.md`（T01–T59）。
