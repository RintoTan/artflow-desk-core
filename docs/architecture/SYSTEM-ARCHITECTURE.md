# 系统架构

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面壳 | Tauri 2（macOS WKWebView / Windows WebView2） |
| 前端 | React 19 + TypeScript + Vite，纯 CSS（无 UI 框架） |
| 后端 | Rust（rusqlite，bundled SQLite） |
| 数据 | 本地 SQLite + 文件目录，无服务端 |

## 进程与边界

```
┌───────────────────────────── Tauri 壳 ─────────────────────────────┐
│  WebView（React SPA）                                              │
│      │ invoke(cmd, args)                                          │
│      ▼                                                            │
│  Rust 命令层（src-tauri/src/commands/*）                            │
│      │ 事务 + 业务规则                                             │
│      ▼                                                            │
│  领域层（domain/*）── store/*（迁移、代际、路径、高水位、时区）        │
│      │                                                            │
│      ▼                                                            │
│  SQLite（generations/<id>/database.sqlite）+ attachments/          │
└───────────────────────────────────────────────────────────────────┘
```

- 前端不直接写库：所有写操作走命令，命令内部 `BEGIN IMMEDIATE` + revision 乐观锁。
- 事件写入与业务状态变更在同一事务里，避免「状态变了但历史没写」。

## 模块划分

| Rust 模块 | 职责 |
| --- | --- |
| `commands/*` | 命令面：参数校验、调用领域层、返回视图 |
| `domain/orders.rs` | 订单增删改、编号分配、视图组装 |
| `domain/lifecycle.rs` | 开工、推进、返工、跳级、完成、取消、重开 |
| `domain/events.rs` | 事件模型与写入（含改期、跳级快照） |
| `domain/attachments.rs` | 导入、缩略图、作业、隔离区、孤儿恢复 |
| `domain/maintenance.rs` | 隔离文件与作业记录的盘点 / 手动清理 |
| `backup/*` | 导出、校验、恢复、备份状态 |
| `store/*` | 迁移链、代际、路径、高水位、设置、时区、QA 场景 |

| 前端模块 | 职责 |
| --- | --- |
| `pages/*` | 工作台、订单、客户、模板、日历、统计、设置、关于 |
| `components/*` | 列表/看板/表格、阶段面板、附件面板、对话框 |
| `lib/*` | 纯函数：排期计算、看板分列、阶段计划、附件拖放判定、快捷键 |
| `bridge/commands.ts` | 命令类型与 `api` 封装（唯一出口） |

## 关键机制

- **乐观锁**：每次写操作带 `expected_revision`，冲突返回 `CONFLICT`，前端提示刷新。
- **幂等**：写命令可带 `request_id`，重复提交不会重复写事件。
- **编号**：`AF-YYYY-NNNN`，先预留后创建，允许空号；高水位存在独立 `state/highwater.sqlite`。
- **时间**：事件时间存真实时间点（含时区偏移），计划日期是纯日历日期，两者不混用。
