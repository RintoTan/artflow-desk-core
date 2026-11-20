# 技术架构

ArtFlow Desk Core 是一个本地优先的单机桌面应用：Tauri 壳 + React 前端 + Rust 命令层 + 本地 SQLite。没有服务端，没有账号体系，运行时不发起任何网络请求。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面壳 | Tauri 2（macOS WKWebView / Windows WebView2） |
| 前端 | React 19 + TypeScript + Vite，纯 CSS（无 UI 框架） |
| 后端 | Rust + rusqlite（bundled SQLite） |
| 数据 | 本地 SQLite + 附件文件目录，代际隔离 |

## 进程与边界

```
┌───────────────────────────── Tauri 壳 ─────────────────────────────┐
│  WebView（React SPA）                                              │
│      │ invoke(cmd, args)                                          │
│      ▼                                                            │
│  Rust 命令层（src-tauri/src/commands/*）                            │
│      │ 参数校验 + 事务 + 业务规则                                    │
│      ▼                                                            │
│  领域层（domain/*）── store/*（迁移、代际、路径、高水位、时区、QA 场景）│
│      │                                                            │
│      ▼                                                            │
│  SQLite（generations/gen-<uuid>/database.sqlite）+ attachments/    │
└───────────────────────────────────────────────────────────────────┘
```

两条硬边界：

1. **前端不直接写库**。所有写操作走命令，命令内部 `BEGIN IMMEDIATE` + revision 乐观锁。
2. **事件与状态同事务**。状态变更和历史事件在一个事务里写，不会出现「状态变了但历史没记」。

## 模块划分

### Rust（`src-tauri/src/`）

| 模块 | 职责 |
| --- | --- |
| `commands/*` | 命令面：参数校验、调用领域层、组装返回视图。14 个命令模块 |
| `domain/orders.rs` | 订单增删改、编号分配、视图组装 |
| `domain/lifecycle.rs` | 开工、推进、返工、跳级、完成、取消、重开 |
| `domain/events.rs` | 事件模型与写入（含改期、跳级快照） |
| `domain/attachments.rs` | 导入、缩略图、作业、隔离区、孤儿恢复 |
| `domain/maintenance.rs` | 隔离文件与作业记录的盘点 / 手动清理 |
| `domain/stats.rs` | 月度完成与收入聚合、下钻、CSV 数据 |
| `backup/*` | 导出、校验、恢复、备份状态 |
| `store/*` | 迁移链、代际、路径、高水位、设置、时区、QA 场景 |
| `infra/*` | 退出闸门、诊断日志、单实例锁、原生菜单 |

### 前端（`src/`）

| 模块 | 职责 |
| --- | --- |
| `pages/*` | 工作台、订单、客户、模板、日历、统计、设置、关于 |
| `components/*` | 列表/看板/表格、阶段面板、附件面板、对话框、时间线 |
| `lib/*` | 纯函数：排期计算、看板分列、阶段计划、附件拖放判定、快捷键、时区 |
| `bridge/commands.ts` | 命令类型与 `api` 封装，**invoke 的唯一出口** |
| `styles.css` | 原生 CSS + 设计令牌（Arctic Blue） |

## 数据模型（schema v7）

### 核心表

| 表 | 说明 |
| --- | --- |
| `orders` | 订单主体：`code`（唯一）、`status`（active/complete/cancelled）、`amount_cents`、计划开始/交付日期、队列位置、`revision` |
| `order_stages` | 每个订单**自己的阶段副本**（来自模板），按 `position` 排序 |
| `order_events` | 只追加的事件流：创建、开工、推进、返工、跳级、改期、完成、取消、重开 |
| `attachments` | 附件元数据（相对路径），原图必须在，缩略图可重建 |
| `attachment_jobs` | 导入/修复作业（pending / done / failed） |
| `cleanup_tasks` | 待清理文件（含代际归属） |
| `clients` / `client_tags` | 客户与标签 |
| `stage_templates` | 流程模板（保留一个系统默认模板） |

### 关键关系与约束

- `order_stages` 与 `orders` 是**副本关系**：建单时复制模板阶段，之后改模板不影响已有订单，历史因此不可被追溯改写。
- `order_events` 通过外键挂订单，**只追加不更新**；事件里存阶段**名称快照**，不只存 id。
- 阶段推进只有两种合法形态：前进一格（`stage_advanced`）或跳过若干格（`stage_skipped` + `skipped_stages` JSON 快照 + `skip_reason`）；被跳过的阶段标记为「已跳过」，**不计入完成**。
- 计划日期是纯日历日期；实际发生时间只来自事件（真实时间点 + 时区）。两者不互相覆盖。
- `order_events` 的 `kind` 是 CHECK 枚举。SQLite 不能改 CHECK，v6（改期）与 v7（跳级）都是「建新表 → 搬迁 → 建索引 → 改名为原表」的重建式迁移，整步在事务里，失败整体回滚。

### 迁移链

`APP_SCHEMA_VERSION = 7`，迁移 append-only：只允许新增 `vN → vN+1`，不允许改写历史迁移文件。

| 版本 | 内容 |
| --- | --- |
| v1 | 基础表：orders / order_stages / order_events / attachments / clients / stage_templates |
| v2–v5 | 队列、排期、标签、作业与清理任务 |
| v6 | `order_events` 增加 `rescheduled` 与改期六字段（原/新开始与交付日期、原因、来源） |
| v7 | `order_events` 增加 `stage_skipped`、`skipped_stages`、`skip_reason` |

## 关键机制

| 机制 | 实现 | 为什么 |
| --- | --- | --- |
| 乐观锁 | 每个写命令带 `expected_revision`，不匹配返回 `CONFLICT`，前端提示刷新 | 单机也可能有多个窗口/快速连点，避免静默覆盖 |
| 幂等 | 写命令可带 `request_id`，重复提交不重复写事件 | 防止重试造成重复事件 |
| 编号 | `AF-YYYY-NNNN`（YYYY = 创建年份），先预留后创建，允许空号；高水位存 `state/highwater.sqlite`，单调只增 | 编号与业务库解耦，恢复时不会回退 |
| 时间 | 事件存真实时间点（含时区偏移），计划日期是纯日历日期 | 改期与「实际何时做的」是两件事 |
| 代际 | 迁移/恢复都新建 `generations/gen-<uuid>/`，写完原子切换 `state/active.json` | 失败不动现有数据，见 [DATA-SAFETY.md](DATA-SAFETY.md) |
| 退出 | Tauri 的 `ExitRequested` 在最后一个窗口销毁后才发出；闸门只在「窗口还在 + 应用级退出」时拦截 | 无条件拦截会留下无窗口的孤儿进程 |
| 日志 | `logs/app.log`（1 MiB 轮转）+ panic hook + UI ready 回执 | release 版无控制台，`println!` 不可见 |

## 关键技术约束

这些约束是踩过坑得出的，改代码前先读：

1. **不要用正式 identifier 做开发调试**——会触发正式库迁移。开发一律用 QA 配置（见 [DEVELOPMENT.md](../development/DEVELOPMENT.md)）。
2. **不要手工改数据库或删代际目录**。要动数据，走应用的备份/恢复。
3. **资产协议 scope 必须保持为空 + 运行时按活动代际授权**。写死目录或放开整个 AppData 会让越界读取重新成立。
4. **新增事件类型必须同步三处**：迁移、领域层校验、前端展示。
5. **跨平台测试不能带平台假设**：`HOME`、路径分隔符、unix 符号链接都要处理（`#[cfg(unix)]` 或归一化）。
6. **Windows release 无控制台**：任何诊断信息必须落到 `logs/app.log`。
7. **打包不要带上开发 CLI**（`minidesk-probe` / `attachments-probe` / `qa_seed`）。它们是测试依赖，只能从打包配置里排除，不能删源码。
8. **子进程退出是异步的**：Windows 冒烟测试判定残留要给收敛窗口（15 秒），固定 800 ms 会误报。
9. **单个数据目录只允许一个实例**（`.write.lock`）。第二个实例提示后退出，不聚焦已有窗口——已知取舍。

## 已采纳的技术结论

以下来自正式开发前的独立技术实验（TV-01～TV-03.5），结论已体现在上述实现里；实验工程本身没有迁入本仓库。

| 结论 | 落点 |
| --- | --- |
| SQLite 事务 + revision 冲突检测能覆盖本地并发写 | `BEGIN IMMEDIATE` + `expected_revision` |
| 崩溃恢复需要「写入前留痕」，否则无法判断上次操作是否走完 | `recovery/state.json` |
| ZIP 必须拒绝绝对路径、`..`、盘符、重复条目、符号链接 | 备份解包校验 |
| 缩略图可重建、原图不可重建，二者要在数据模型上分开 | `attachments/originals` vs `thumbs` |
| 跨进程锁要落在数据根而非单一文件 | `.write.lock` |
| 备份校验要用逐文件 SHA-256，不能只校验 ZIP 本身 | `manifest.json` |
| 资源协议按目录授权 + 真实路径比对能挡住符号链接逃逸 | 资产协议 scope |
