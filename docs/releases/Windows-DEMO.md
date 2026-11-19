# Windows Demo

## 构建来源

| 项 | 值 |
| --- | --- |
| 应用版本 | 0.1.0 |
| 构建方式 | GitHub Actions `windows-latest`（原生 MSVC，非交叉编译） |
| 目标三元组 | `x86_64-pc-windows-msvc` |
| 打包器 | Tauri 2 + NSIS |
| 配置 | Production 用 `src-tauri/tauri.conf.json`；QA 用 `src-tauri/tauri.qa.conf.json` |
| 工作流 | `.github/workflows/windows-build.yml` |

本仓库不使用 macOS 交叉编译 Windows 的方案：`llvm-rc` 在本机不可得，早期尝试已被判定为阻断。

## 产物

| 文件 | 说明 |
| --- | --- |
| `ArtFlowDesk-Core-Windows-v0.1.0-Production-Portable.exe` | 正式版免安装主程序，标识 `dev.artflow.minidesk` |
| `ArtFlowDesk-Core-Windows-v0.1.0-Production-Setup.exe` | 正式版 NSIS 安装包 |
| `ArtFlowDesk-Core-Windows-v0.1.0-QA-Portable.exe` | QA 版免安装主程序，标识 `dev.artflow.minidesk.qa` |
| `ArtFlowDesk-Core-Windows-v0.1.0-QA-Setup.exe` | QA 版 NSIS 安装包 |
| `SHA256SUMS.txt` | 上述四个文件的 SHA-256 |
| `启动 QA Clean（空白环境）.cmd` | 已安装 QA 版时进入 clean 场景 |
| `启动 QA Clean（Portable 便携版）.cmd` | 便携版进入 clean 场景（与 exe 放同一目录） |

安装包与 Portable 的主程序内部文件名都是 `artflow-minidesk.exe`；版本信息 `FileVersion=0.1.0`，
产品名分别为 `ArtFlow Desk Core` 与 `ArtFlow Desk Core QA`。

## 校验

Windows（PowerShell）：

```powershell
Get-FileHash .\*.exe -Algorithm SHA256 | Format-Table -AutoSize
```

`SHA256SUMS.txt` 由 PowerShell 生成，行尾是 CRLF；在 macOS/Linux 上比对前先 `tr -d '\r'`。

## 自动化冒烟测试

工作流在构建后真实启动产物，执行：启动 → 等待主窗口 → 发送 `WM_CLOSE` → 等待进程退出 → 检查无残留子进程 → 再启动一次 → 再关闭。
Production 与 QA（clean / seeded）各自执行两轮，并检查数据目录与场景隔离。

- 脚本：`scripts/windows/smoke-test.ps1`
- 日志：随 artifact 一起上传（`smoke-test.log` / `smoke-clean.log` / `smoke-seeded.log`）
- 覆盖：进程启动、窗口创建、关闭后进程退出、二次启动、数据目录与隔离
- **不覆盖**：界面内容是否渲染正确（Runner 无法可靠判定）、安装/卸载、DPI、中文路径、SmartScreen

## 实机验收

尚未在任何一台真实 Windows 电脑上执行。清单见 [WINDOWS-MANUAL-TEST.md](../development/WINDOWS-MANUAL-TEST.md)，全部标记 NOT RUN。

## 已知限制

- 未做代码签名：首次运行有 SmartScreen 提示。
- 同一数据目录只允许一个实例：第二个实例提示「已有实例在运行」后退出，不会聚焦已有窗口。
- 仅构建 x64，未构建 arm64。
- 打包会把 `minidesk-probe` / `attachments-probe` / `qa_seed` 三个开发用 CLI 一起带入，功能无影响但体积偏大。
