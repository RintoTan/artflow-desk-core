# 技术实验归档（TV-01 ～ TV-03.5）

本目录保存 ArtFlow miniDesk 正式开发之前的技术实验报告，供追溯设计依据。

| 文档 | 内容 |
|---|---|
| `TV01-RESULTS.md` | Rust + SQLite 事务、revision 冲突、故障注入与崩溃恢复 |
| `TV02-RESULTS.md` | Tauri WebView 交互：中文输入、路由、未保存保护、文件对话框 |
| `TV03-RESULTS.md` | 附件、ZIP 备份、数据代际恢复、恶意 ZIP 拒绝 |
| `TV035-RESULTS.md` | 跨进程锁、缩略图重建、代际清理、真实重复 ZIP 条目、命令白名单 |

## 三条必须记住的限制

1. **这些是技术实验，不是产品功能验收。** 实验实现的是机制，不是业务规则；
   正式业务以 DEV 阶段实现与测试为准。
2. **macOS 结论不代表 Windows 实机验证。** 全部实验均在 macOS arm64 上执行，
   Windows 尚未实测。
3. **实验数据没有迁入正式工程。** 实验数据库、沙箱、虚构订单都留在原实验目录，
   正式工程从空库开始。

原实验工程：`/Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk-tv01`（保留原样，未复制数据库）。
