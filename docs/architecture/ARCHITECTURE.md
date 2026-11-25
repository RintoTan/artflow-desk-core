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

## 数据模型（schema v13）

> 删除、回收站、数据重置与存储位置迁移的详细设计与实现约束见 [DATA-LIFECYCLE.md](DATA-LIFECYCLE.md)（已实施并验收）。

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
| `payment_platforms` | 接单/收款平台与默认手续费率（v10） |
| `payment_schedules` | 付款计划：应收金额、可选预计日期（v10） |
| `payment_records` | 实际到账流水：金额、到账日、费率与手续费快照（v10） |

### 软删除与可见性（v8）

- `orders` 与 `clients` 各增 `deleted_at`、`deleted_batch`；删除是**可见性**，不改 `status`，也不新增状态值。
- 新增三个视图：`orders_visible`、`orders_trashed`、`clients_visible`。业务查询读视图；备份、诊断、幂等与模板使用数统计读基表。
- 按 id 的业务读写另经 `store::visibility` 守卫（不存在 → `NOT_FOUND`，在回收站 → `CONFLICT`），列表与聚合由视图承担。
- **SQLite 视图在建表时展开 `SELECT *`**：此后给 `orders` / `clients` 加列，必须先 `DROP VIEW` 再重建，否则视图列会滞后于基表。

### 关键关系与约束

- `order_stages` 与 `orders` 是**副本关系**：建单时复制模板阶段，之后改模板不影响已有订单，历史因此不可被追溯改写。
- `order_events` 通过外键挂订单，**只追加不更新**；事件里存阶段**名称快照**，不只存 id。
- 阶段推进只有两种合法形态：前进一格（`stage_advanced`）或跳过若干格（`stage_skipped` + `skipped_stages` JSON 快照 + `skip_reason`）；被跳过的阶段标记为「已跳过」，**不计入完成**。
- 计划日期是纯日历日期；实际发生时间只来自事件（真实时间点 + 时区）。两者不互相覆盖。
- `order_events` 的 `kind` 是 CHECK 枚举。SQLite 不能改 CHECK，v6（改期）与 v7（跳级）都是「建新表 → 搬迁 → 建索引 → 改名为原表」的重建式迁移，整步在事务里，失败整体回滚。

### 财务三表（v10）

- **计划与流水分开**：`payment_schedules` 描述「应收」，`payment_records` 描述「已收」。一笔计划可以由多笔流水分摊，因此收款状态与净到账都**不落库**：`net = amount_cents - fee_cents`、状态由「计划金额 vs 未作废流水合计」派生。
- **`orders.amount_cents` 仍是订单总额**，没有第二套总额字段。旧订单迁移后不生成任何计划或流水，界面显示「未记录收款信息」，不显示「未收款 ¥X」。
- **费率可空，空 ≠ 0**：`fee_rate_bp` 为 `NULL` 表示未配置/未知，`0` 表示用户明确填了 0%。`payment_records.fee_cents` **没有默认值**，实际手续费必须显式写入，避免「没算过」被记成「零手续费」。
- **快照而非外键**：`platform_name`、`fee_rate_bp`、`fee_cents` 都存当时的值；删平台把 `platform_id` 置空，删计划把 `schedule_id` 置空，两者都**不删除真实流水**。
- **作废不是退款**：`voided_at` 只标记「这笔录错了」，不作资金流出。真实退款是独立的 `refund_records` 表（v12 起，见下文「退款」）。
- 约束落在数据库层：金额 `> 0`、`fee_cents <= amount_cents`、费率 `0–10000` bp、日期 `GLOB 'NNNN-NN-NN'`。
- 新增 `payment_*` 不涉及 `orders` 列，**因此不需要重建可见性视图**；财务查询将来一律 `JOIN orders_visible`，不申请新的 lint 豁免。
- **v11 补强（FIN-01.1）**：三表改 `STRICT`（`INTEGER` 只是亲和性，`1.5` 会被存成 REAL 而 CHECK 照样通过）；主键显式 `NOT NULL`（rowid 表的 TEXT 主键历史上允许 NULL）；名称要求「已 trim」；日期加 `date(x) IS x` 抓 `2026-02-31` 这类溢出（SQLite 会把它归一化成 3 月 3 日）；`platform_id` 有值时必须有 `platform_name` 快照。
- **同订单不变量**：`payment_records.schedule_id` 指向的计划必须与 `payment_records.order_id` 同单。用触发器而不是复合外键——复合键的 `ON DELETE SET NULL` 会连 `order_id` 一起置空，把「删计划、留流水」这条已冻结语义弄坏。三个触发器覆盖流水 INSERT、流水 UPDATE、以及「已挂流水的计划改挂订单」。
- **v11 必须先断言三表为空**：`PRAGMA foreign_keys` 在事务内是 no-op，三表互相引用时删父表会触发子表 `SET NULL` 并静默抹掉关联。非空则整步中止，不搬迁、不改数据。
### 付款计划与实际收款（FIN-03）

- **计划记预期，流水记事实**。`payment_schedules` 只说明「应收多少、什么时候收」；`payment_records` 只说明「实际到了多少」。建了 ¥300 定金计划不等于收到 ¥300。
- **派生不落库**：净到账 `amount - fee`、计划已收/未收/状态、逾期、订单已收/待收/超额，全部在 `domain::finance::snapshot` 里现算。表里没有 `paid_status` / `remaining_cents` / `net_cents` 这类字段。
- **状态**：`unpaid` / `partial` / `settled` / `overdue`。零宽限期——`expected_date < 今天` 且未收齐即逾期，当天不算；只看未作废流水。逾期只影响财务提示，不动订单状态、阶段与队列。
- **D1 类型一致**：流水挂计划时必须同 `kind`。v12 用三条触发器兜底（INSERT、UPDATE、以及「已挂流水的计划不许改类型」）；领域层先给可读消息。外键的 `SET NULL` 不受影响。
- **D2 计划总额**：有订单总额才能建计划，且合计必须**严格相等**。订单金额后续被改小/改大时，计划不会被自动改动，但读取会 `planMatchesOrder = false`，再次保存计划必须重新对齐。
- **D4 完成与收款独立**：完成的订单照样能记、改、作废收款；未收齐不会把订单拉回制作中。
- **取消单**：财务读写都被拒（读取也报错而不是返回 0，否则会被读成「一分没收」）。恢复订单后原数据重新参与计算。
- **作废不可逆**：只写 `voided_at` / `void_reason`，金额与快照不变，不物理删除；作废后计划状态会回落。
- **日期**：`received_on` 必须是真实日历日期且不能晚于今天（补录历史可以）；`expected_date` 同样要真实，过去未来都允许。

### 客户财务与导出（FIN-06）

- 客户财务汇总只有一份实现（`domain::finance_clients`），客户详情、统计页「按客户」、财务 CSV 三处共用；聚合身份是 `clients.id`，同名客户不合并。
- **不写多表 JOIN 求金额**：先把每个订单的收款/退款各自汇总，再在 Rust 里按客户累加。JOIN 写法会让「一单两笔收款 + 一笔退款」把订单金额放大数倍。
- 待收与超额**逐单**取正负后再汇总，避免客户内一单多收抵掉另一单少收。
- 取消单与回收站单不进入客户财务；「未记录收款信息」的订单不计入待收。
- 导出三个出口：财务统计 CSV（分区，与页面同一份 report）、收款流水 CSV（原始明细，含作废行）、订单明细 CSV（原有 9 列之后追加 13 个财务列）。
- 订单 CSV 的财务列复用 `finance::snapshot`，详情页怎么算导出就怎么算；已取消/回收站的订单金额列整段留空并写明原因。

### 财务统计（FIN-05）

- 一个只读命令 `finance_stats_report(range)` 返回整份报告；页面只负责展示与切范围，**不做任何相加**。
- 口径：到账按 `received_on` 归月，退款按 `refunded_on` 归月，两者各归各月；手续费取流水里的 `fee_cents`，不用平台当前费率重算；取消单一律不进金额（C-1）。
- 累计（lifetime）与当前状态（待收/超额/未知金额/未记录收款/计划不匹配）不受日期范围影响；`period` 才随范围变。
- 预计收款只来自 `payment_schedules.expected_date`，窗口是当前月 + 后续 5 个月；逾期 = 日期 < 今天且仍有未收。
- 平台/付款方式按流水里的快照字段分组，因此平台改名或删除后历史仍归原名；NULL 保留为「未记录平台 / 未记录方式」。
- 「全部」范围的起点取「最早订单月」与「最早收款/退款月」的较小者——补录的早期到账不会被挡在窗口外。
- 索引：月度聚合命中 `payment_records_received`、`refund_records_date`（实测 EXPLAIN），分组用临时 B 树，数据量下可接受。

### 订单详情财务区（FIN-04）

- 一个 `finance_order_snapshot` 驱动整块界面：所有金额、状态、差额都直接用返回值，前端不做任何相加。写入成功后统一重读快照，不用旧数据继续显示。
- **四种空态各说各的**：`unrecorded`、`hasRecordsWithoutPlan`、`planMatchesOrder === false`、`remainingCents === null`。它们互不排斥，按字段分别渲染；`null` 显示「—」，`0` 显示「¥ 0.00」。
- **取消后只锁收款与计划**：收款、作废、计划编辑全部收起，退款的新增/编辑/作废与关联原收款照常开放——钱退没退跟订单还在不在做是两件事。
- 计划整套保存：模式切换或删除有关联流水的计划项时，先把受影响的流水列出来确认，再带 `confirmDetach` 提交；流水只解除关联，不删除。
- 已关联原收款的退款只能更换收款，不提供「改回未关联」——否则可以先解绑再放大金额，绕过「累计退款不超过原收款」的保护。

### 退款（FIN-03 修订）

- **退款独立成表** `refund_records`，不写成负数流水，也不用「作废原收款」冒充。三件不同的事：作废=钱从没进来；退款=进来了又还回去；收款=到账事实。
- **允许不关联原收款**（`payment_record_id` 为空）：历史订单可能没录过收款，但钱确实退了。此时 `unmatched = true`，界面要提示「核验不了可退款余额」，而不是禁止记录。
- **关联原收款时的约束**（领域层 + 触发器双保险）：同订单、原收款未作废、累计有效退款 ≤ 原收款金额；编辑时把自己排除后再算。
- **原收款有有效退款时不能作废**；退款已作废不能「恢复」；退款不提供物理删除命令，只作废。
- **退款不回调任何历史**：原收款金额、手续费、计划已收金额都不变；退款只进 `refundTotalCents`，`netRetained = netReceived − refundTotal`，允许为负（退款超过已记录到账时要如实显示并提示，不能截断成 0）。
- **日期**：`refunded_on` 真实且不得晚于今天，历史补录不设下限。
- **取消订单可选记录退款**：`refundDecision` 必填（`none` / `record`），`record` 至少一笔；退款与取消在**同一事务**，任何一步失败整次取消回滚。
- 取消后财务只读：仍可查看历史收款、计划与退款，可补录/修改/作废退款，但不能再新增普通收款或改计划。

### 平台配置（FIN-02）

- 入口：设置 → 财务设置 → 接单平台与手续费；命令统一在 `commands::finance::*`，规则在 `domain::finance`。
- **只有一个 `archived` 状态**，不设 `enabled`：停用即归档，可恢复；归档平台仍占用名称（唯一索引不带 `archived` 条件），所以新建同名平台会被拒，并按「同名在用 / 同名已归档」给两种不同的提示。
- **名称在 Rust 侧 `trim()`**（覆盖全角空格等 Unicode 空白），数据库的 `name = trim(name)` 只认 ASCII 空格，两层是互补而不是重复。
- **费率原文由界面送进后端换算**：`domain::finance::parse_fee_rate` 只做整数运算，空串 → NULL、`0`/`0.00` → 0、`1.25` → 125；前端不另写一套解析。展示走 `format_fee_rate`。
- 排序：只接受「当前全部正常平台」的一个排列，集合不匹配就拒绝（而不是宽容地只改交集）；整体在一个 `IMMEDIATE` 事务里完成。
- 删除只删配置行；`payment_records.platform_id` 按 `SET NULL` 断开，名称/费率/手续费快照不受影响，返回值里带 `detachedPayments` 让界面说清楚影响了几笔。
- 时间戳：用户动作（编辑/归档/恢复/排序）更新 `updated_at`；`created_at` 从不动。与 C-3 的「重置搬运两个都保留」是两套语义。

- 索引：`payment_records_schedule(schedule_id)` 服务「按计划聚合已收」，`payment_records_received(received_on)` 服务月度现金流扫描（复合索引第二列不能单独用）。

### 备份与恢复里的财务数据（FIN-07）

- **不新增迁移、不改包格式**：四张财务表本来就在 `database.sqlite` 里，随 `VACUUM INTO` 快照一起备份。
  `FORMAT_VERSION` 仍是 1，`manifest.json` 结构不变。
- **摘要是临时算的**：`DataSummary` 不写进 manifest。导出时从本次快照算，预览时解出包内数据库再算一遍，
  所以预览里的数字描述的是**这份包**，不是本机现状。财务四项（平台/计划/收款/退款）是库存计数，
  含已归档平台与已作废流水，不含金额与客户信息。
- **缺表 ≠ 0**：财务表不存在记 0（旧版本还没有）；表存在却统计失败直接报错，不用 `unwrap_or(0)` 兜住。
- **结构判定在迁移之前**：`backup::finance_guard::inspect` 记下「这份包原本有没有四张表」，
  再按声明的 schema 版本核对（v9 及以前不该有、v10/v11 三表无退款表、v12 四表齐全）。
  迁移后再核对四表与 12 条触发器齐全，缺一即拒绝切换。
- **规则 B（平台回填）**：只有「包内没有平台表」时才把恢复前的本机平台搬进新代际，
  `updated_at` 记为恢复时刻；包内有平台表就严格用备份的，空表也保持空。
  业务历史三表永不回填，迁移前后比对行数，变化即拒绝。
- 所有判定都在隔离代际内完成，失败不切 `active.json`、不删旧代际与恢复前快照。

### 迁移链

`APP_SCHEMA_VERSION = 12`，迁移 append-only：只允许新增 `vN → vN+1`，不允许改写历史迁移文件。

| 版本 | 内容 |
| --- | --- |
| v1 | 基础表：orders / order_stages / order_events / attachments / clients / stage_templates |
| v2–v5 | 队列、排期、标签、作业与清理任务 |
| v6 | `order_events` 增加 `rescheduled` 与改期六字段（原/新开始与交付日期、原因、来源） |
| v7 | `order_events` 增加 `stage_skipped`、`skipped_stages`、`skip_reason` |
| v8 | `orders` / `clients` 增加 `deleted_at`、`deleted_batch` 与部分索引；新增 `orders_visible` / `orders_trashed` / `clients_visible` 视图 |
| v9 | `orders` 增加 `archived_at` 与部分索引；**重建两个订单视图**（SQLite 的 `SELECT *` 在建视图时冻结列清单）。归档只影响「订单信息」页普通列表的归属，其余查询口径不变 |
| v10 | 新增 `payment_platforms` / `payment_schedules` / `payment_records` 三表与索引；**不改 `orders`**、不建视图、不写任何种子数据或历史流水 |
| v12 | 新增 `refund_records` 与三条「流水类型 = 计划类型」触发器；迁移前自检历史数据，发现跨类型关联即中止 |
| v13 | 新增 `orders.pinned_at`（可空时间戳）与部分索引；因 `SELECT *` 列冻结，重建 `orders_visible` / `orders_trashed` |
| v11 | 三张财务表重建为 `STRICT`，补主键 `NOT NULL`、名称 trim、日期真实性、平台名快照约束，新增同订单关联三触发器与两个查询索引；迁移前断言三表为空，非空中止 |

## 关键机制

| 机制 | 实现 | 为什么 |
| --- | --- | --- |
| 乐观锁 | 每个写命令带 `expected_revision`，不匹配返回 `CONFLICT`，前端提示刷新 | 单机也可能有多个窗口/快速连点，避免静默覆盖 |
| 幂等 | 写命令可带 `request_id`，重复提交不重复写事件 | 防止重试造成重复事件 |
| 编号 | `AF-YYYY-NNNN`（YYYY = 创建年份），先预留后创建，允许空号；高水位存 `state/highwater.sqlite`，单调只增 | 编号与业务库解耦，恢复时不会回退 |
| 时间 | 事件存真实时间点（含时区偏移），计划日期是纯日历日期 | 改期与「实际何时做的」是两件事 |
| 代际 | 迁移/恢复都新建 `generations/gen-<uuid>/`，写完原子切换 `state/active.json` | 失败不动现有数据，见 [DATA-SAFETY.md](DATA-SAFETY.md) |
| 退出 | Tauri 的 `ExitRequested` 在最后一个窗口销毁后才发出；闸门只在「窗口还在 + 应用级退出」时拦截 | 无条件拦截会留下无窗口的孤儿进程 |
| 置顶 | `orders.pinned_at` 是**展示优先级**，不是状态：不改 `status`、不改 `queue_position`、不动 revision。是否生效统一由 `PIN_EFFECTIVE_SQL`（置过顶 + 进行中 + 未归档）判定 | 只靠清理不靠判据，漏一条生命周期路径就会多出一个置顶；两处都做才安全 |
| 浮层 | 模态走 `lib/modalStack`；右键菜单这类非模态浮层走 `lib/layers` 的层级栈，Esc 只交给最上层 | 两者语义不同：模态要接管焦点与交互，菜单只是临时遮挡；混用会连带改掉页面快捷键与退出排队 |
| 日志 | `logs/app.log`（1 MiB 轮转）+ panic hook + UI ready 回执 | release 版无控制台，`println!` 不可见 |

### 置顶的生命周期

`pinned_at` 非空不等于「有效置顶」：只有 `pinned_at IS NOT NULL AND status = 'active'
AND archived_at IS NULL` 才算（`domain/orders.rs::PIN_EFFECTIVE_SQL`）。数量上限、列表分组、
界面标记三处都过这个判据。

清理**同时**写在每条会让订单离开「活动且未归档」的写入路径上，逐个分支显式置 `NULL`：

| 路径 | 位置 |
| --- | --- |
| 完成 | `lifecycle::complete_order` |
| 取消 | `lifecycle::cancel_order` |
| 重开（防御：不恢复原置顶） | `lifecycle::reopen_order` |
| 归档 / 取消归档 | `orders::set_archived` |
| 移入回收站（单笔 / 按客户整批） | `trash::delete_order` / `trash::delete_client` |
| 从回收站恢复（单笔 / 按客户整批） | `trash::restore_order` / `trash::restore_client` |

队列拖拽的跨组边界在 `queue::move_order` 里拦（`display_ids` 的置顶块长度），
前端禁用把手只是礼貌——`move_order` 收的是目标下标，直接调用同样要挡住。

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
10. **macOS 的 Dock「退出」拦不住，这是框架边界而非疏漏**。tao 0.37.2 的 AppDelegate 只实现
   `applicationWillTerminate:`，没有 `applicationShouldTerminate:`；而 `RunEvent::ExitRequested`
   只在「最后一个窗口销毁」或 `app.exit()` 时发出。Dock 右键退出、活动监视器退出、`osascript quit`
   都走 AppKit 的 `terminate:`，直接进 `willTerminate` → 进程结束，不产生 `ExitRequested`。
   要拦下来只能替换或方法交换 tao 的私有 `TaoAppDelegateParent`，属于未经验证的高风险改动，**未采用**。
   当前 Cmd+Q、顶部菜单退出、红色关闭按钮都有未保存保护；Dock 退出没有。
11. **同一类数据 ≠ 同一个交互模块**。工作台全览时间线（`DashboardPage` / `ProjectTimeline` / `lib/timeline`）与日历排单（`CalendarPage` / `CalendarGrid`）都画订单日期，但前者只读全览、后者可编辑排期，**二者独立实现，不得合并、不得互相复用状态机与布局计算**。为其中一个改需求时，不允许"顺手"改动另一个的组件、`.cal-*` 规则、断点、sticky / overflow / z-index 或改期链路；`styles.css` 是共享文件，各自只改自己的命名空间（`.timeline-*` / `.cal-*`）。若发现某段代码被两者共用，先停下评估影响面，不得自行重构。

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

## 数据根解析与单实例（DEV-0.1.1-05）

启动顺序：应用数据目录 → 读 `root.json` 指针（不存在用默认根）→ 校验目标（存在、
是目录、有 `environment.json`）→ 打开 Environment 并取得跨进程锁。

- 指针损坏或目标不可用：硬失败并提示「重新连接」「切回默认位置」，不回落。
- 锁在数据根上；身份为 Unix `dev+ino` / Windows 卷序号+文件索引，被替换即拒写。
- 第二实例：拿锁失败时会请已有实例 `activate`（macOS Unix socket / Windows 命名管道），
  然后自身退出，不创建第二个主窗口。
- 附件 `asset` 协议按**当前活动代际**授权，不使用通配；因此换根后必须重启，
  重启时会重新授权新根的代际目录。

