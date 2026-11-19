# 已知限制｜DEV-09B

## 一、没有任何 Windows 产物

`.github/workflows/windows-build.yml` 已写好但未运行（仓库无远程地址）。`installers/` 为空是刻意的。

## 二、构建成功前无法确认的事

- 工作流是否真能跑通（Node 20 + Tauri 2.12 + NSIS 的组合在 `windows-latest` 上的行为）
- NSIS 安装包体积、安装路径、开始菜单项名称
- 主程序 exe 的实际文件名（`artflow-minidesk.exe` 还是 `ArtFlow Desk Core.exe`）——手册与脚本对两种都做了兼容，但真实值要等产物

## 三、必须在 Windows 实机验证（本机无法替代）

| 项 | 为什么不能在 macOS 替代 |
| --- | --- |
| 应用启动 / WebView2 运行时 | 需要真实 WebView2 |
| Asset 协议 `http://asset.localhost` 的 scope 行为 | 与 macOS 的 `asset://localhost` 实现不同 |
| `%APPDATA%` 实际落盘路径 | Windows 才有的目录语义 |
| 中文/空格/长路径下的附件导入与缩略图 | 文件系统差异 |
| 125% / 150% DPI | 需要真实显示缩放 |
| Ctrl 快捷键实按键 | 键盘布局与 IME 交互 |
| 资源管理器拖拽导入 | 需要真实 OLE 拖放 |
| 安装 / 卸载 / 重装后的数据保留 | NSIS 行为需实测 |
| 跨平台备份（macOS ↔ Windows） | 未做任何互操作测试 |

## 四、代码层已知边界

1. QA 版默认场景是 `seeded`；clean 需要脚本或环境变量，已提供 `.cmd`，但**未在 Windows 上跑过**。
2. 应用未签名：SmartScreen 会拦一次，属预期，不是 bug。
3. 打包会把三个开发 CLI 带进安装目录（见 BUILD-REPORT 第八节）。
