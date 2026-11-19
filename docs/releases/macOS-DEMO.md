# macOS Demo

## 产物

| 项 | 值 |
| --- | --- |
| 应用 | ArtFlow Desk Core / ArtFlow Desk Core QA |
| 版本 | 0.1.0 |
| 格式 | `.dmg`（内含 `.app`） |
| 架构 | Apple Silicon (arm64) |
| 最低系统 | macOS 13.0 |
| 签名 | ad-hoc（未做 Developer ID 签名） |
| 公证 | 未公证 |

具体文件名与 SHA-256 见 Release 页的 `SHA256SUMS.txt`。

## 首次打开

未签名 + 未公证 → 首次需 **右键 → 打开**，或到 `系统设置 → 隐私与安全性` 点「仍要打开」。

## 两个版本

| | 正式版 | QA 版 |
| --- | --- | --- |
| identifier | `dev.artflow.minidesk` | `dev.artflow.minidesk.qa` |
| 数据目录 | `~/Library/Application Support/dev.artflow.minidesk` | `…/dev.artflow.minidesk.qa/seeded`（默认）或 `…/clean` |
| 用途 | 真实委托 | 演示与试玩 |

**不要用正式版做破坏性测试**。正式数据可能是你正在用的数据。

## 已验证 / 未验证

| 项 | 状态 |
| --- | --- |
| 独立运行（不依赖开发服务器） | 已验证 |
| 数据目录 / 代际 / schema 解析 | 已验证 |
| 资产协议 12 条 URL（含符号链接、跨代际） | 已验证（开发环境 + 打包环境各一轮） |
| 页面渲染与核心功能走查 | 已验证 |
| 退出重启后数据保持 | 已验证 |
| 无签名机器的 Gatekeeper 路径 | 未验证（本机已信任） |
| 深色/浅色双主题完整走查 | 部分验证 |
| 触摸板 / 物理滚轮手感 | 未验证 |
