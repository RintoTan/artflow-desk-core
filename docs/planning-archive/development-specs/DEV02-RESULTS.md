# DEV-02 订单业务与制作生命周期 — 结果报告

- 日期：2026-11-16
- 工程：`/Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk`
- 结论：**DEV-02 阶段验收通过**。`cargo test` 160/160 通过，v1→v2 迁移在真实应用数据目录上完成。
- **2026-11-17 更新**：D02-19 / D02-20 由用户在 macOS 实机完成 12/12 项手动操作验收，全部通过，
  两项由 PARTIAL 更正为 PASS（见 F 节与 H.2）。

---

## A. 执行摘要

| 交付 | 状态 |
|---|---|
| 建单（含内联新建客户，同事务回滚） | 已实现 |
| 资料整体保存 + revision 冲突保护 | 已实现 |
| 开始制作 / 撤销开工（FIX-03） | 已实现 |
| 推进 / 返工（含多阶段返工与越界拦截） | 已实现 |
| 完成（FIX-02）/ 取消 / 重新打开（FIX-04、R-01） | 已实现 |
| 订单独立流程编辑（增删改序、删除当前阶段需指定替代） | 已实现 |
| 生命周期事件 9 种 + 幂等键 | 已实现 |
| 订单界面（列表 + 详情 + 阶段控制 + 历史） | 已实现，未人工点击验证 |
| 未保存保护（内部导航 + 切换订单） | 已实现，未人工点击验证 |

实测：`cargo test` **160 passed / 0 failed**、0 编译告警；`tsc --noEmit` 通过；
`vite build` 通过（342.59 kB / gzip 107.02 kB）；应用真实启动并把 v1 数据库升级到 v2。

---

## B. Git 与工程状态

| 项 | 值 |
|---|---|
| 分支 | `master` |
| DEV-02 起始 HEAD | `5a96f93` |
| 本轮提交 | 6 个（store / domain / domain / commands / test / ui），其后 1 个 docs 提交 |
| 工作区 | 干净 |
| 远程 | 未推送 |

开始前核对：DEV-01 的 schema v1、20 项命令面（4 项）、98 个测试均在位；
正式数据目录 `~/Library/Application Support/dev.artflow.minidesk` 中**订单数为 0**，
没有非测试数据，因此可以直接演进 schema。DEV01-RESULTS.md 与代码无偏差。

---

## C. 实现的功能与对应规则

| 功能 | 规则 | 实现位置 |
|---|---|---|
| 标题必填、其余可选、编号自动分配、默认队尾 | D-00-07 / D-00-09 / D-00-26 | `domain/orders.rs::create_order` |
| 建单可内联新建客户，原子提交，同名不合并 | D-00-17 + 本轮决策 B | 同上（客户与订单同一事务） |
| 资料整体保存：标题/客户/类型/金额/计划日期/说明 | D-00-03 / D-00-08 + 本轮决策 A | `update_details` |
| 金额整数分、NULL≠0、非负 | D-00-08 | 校验 + `orders.amount_cents` CHECK |
| 计划日期为日历日期，交付不早于开始 | D-00-05 / D-00-06 | `clean_date` + `validate_date_order` |
| 普通资料编辑不写制作历史 | D-00-11 | `update_details` 不插入事件 |
| 终态仍可改资料、不能改流程/阶段 | D-00-27 / D-00-12 | `capabilities` + `assert_editable` |
| 手动开工、派生「排队中/制作中」 | D-00-10 | `lifecycle::start_work` + `work_state` |
| 撤销开工三条件 | FIX-03 | `capabilities` + 事件 id 判定 |
| 推进一次一步、最后阶段不可推进 | D-00-13 | `advance_stage` |
| 返工默认一步、可指定更早阶段、不可向前 | D-00-13 | `rework_stage` |
| 完成必须已开工且位于最后阶段 | FIX-02 | `complete_order` |
| 取消不补记开工时间、从队列移除 | D-00-13 / D-00-27 | `cancel_order` |
| 重开保留阶段与开工记录、加入队尾 | FIX-04 / R-01 | `reopen_order` |
| 订单独立流程增删改序、删除当前阶段需替代 | D-00-12 | `domain/workflow.rs` |
| 阶段名快照、改名不改历史 | D-00-12 | 事件存 `from/to_stage_title` |
| 9 种生命周期事件 | D-00-11 | `domain/events.rs` |

---

## D. 领域 API 与事务边界

```text
commands/*.rs            薄壳：打开连接 / 转调 / 打印结果，无 SQL
  └─ domain::orders      create_order, update_details, load, list, stages, list_clients
  └─ domain::lifecycle   capabilities, start_work, undo_start_work, advance_stage,
                         rework_stage, complete_order, cancel_order, reopen_order
  └─ domain::workflow    add_stage, rename_stage, remove_stage, reorder_stages
  └─ domain::events      append, list, request_already_applied, stage_moved_after
```

每个写操作的事务边界：

```text
BEGIN IMMEDIATE
  1. 幂等短路（request_id 已落事件 → 读当前订单后直接提交返回）
  2. 读事实（status / started_at / 当前阶段 / revision / 阶段表 / 最近开工事件）
  3. 校验 revision（不匹配 → CONFLICT，事务结束）
  4. 校验业务前置条件（不满足 → INVALID，事务结束）
  5. UPDATE orders ... WHERE id=? AND revision=?   检查 changed == 1
  6. INSERT order_events（同一事务）
COMMIT
```

失败路径均已验证：事务内的 `UPDATE` 被触发器注入失败后，**事件不落库、revision 不前进、阶段不变**
（`d02_17_*` 三个用例）。

`create_order` 的顺序是：**先在独立高水位库保留编号 → 再开业务事务**。
两者之间没有跨文件事务，因此建单失败只会跳号。

---

## E. `order.revision` 与 `queue_revision`

| 操作 | order.revision | queue_revision |
|---|---|---|
| 资料整体保存（内容有变） | +1 | 不变 |
| 资料整体保存（内容相同） | 不变 | 不变 |
| 开始制作 / 撤销开工 | +1 | 不变 |
| 推进 / 返工 | +1 | 不变 |
| 流程结构编辑 | +1 | 不变 |
| 完成 / 取消 | +1 | +1（移出活动队列） |
| 重新打开 | +1 | +1（插入队尾） |
| 仅改变队列位置（DEV-03） | 不变 | +1 |

- `queue_revision` 存放在 `queue_state`（单行表），与订单版本完全独立。
- 因此**排序变化不会让无关订单的资料编辑变成冲突**：资料保存只比较自己的 revision。
- 所有写路径都要求传入 `expected_revision`，并在 `UPDATE ... WHERE revision=?` 上二次确认。

---

## F. 真实测试命令与结果

```bash
cargo test                 # 160 passed / 0 failed，0 warning
npx tsc --noEmit           # 通过
npx vite build             # 342.59 kB / gzip 107.02 kB，91 ms
```

| 测试文件 | 用例 | 覆盖 |
|---|---|---|
| `schema.rs` | 15 | DEV-01 结构约束回归 |
| `migrations.rs` | 10 | 空库→当前版本、隔离代际升级（v2→测试用 v3）、失败回滚、高版本拒绝 |
| `numbering.rs` | 15 | 编号只增不复用、跨年、崩溃、合并 |
| `timezone.rs` | 9 | IANA 时区、改时区不改时间点 |
| `lock.rs` | 10 | 跨进程锁（真实子进程、真实 abort） |
| `environment.rs` | 10 | 代际与清理保护 |
| `media.rs` | 8 | 附件路径与限制 |
| `zip_safety.rs` | 11 | 备份包校验、真实重复条目 |
| `commands.rs` | 10 | 20 项白名单、负向样本、capabilities、layering |
| `order_create.rs` | 11 | D02-01 / 02 / 04 + JSON 契约 |
| `order_details.rs` | 7 | D02-03 / 11 |
| `lifecycle.rs` | 23 | D02-05 ～ D02-14 |
| `workflow_edit.rs` | 13 | D02-15 / 16 + 重排不得绕过 FIX-03 |
| `idempotency.rs` | 8 | D02-17 / 18 |

### 逐条对照验收矩阵

| ID | 场景 | 结果 | 证据 |
|---|---|---|---|
| D02-01 | 标题必填、建单成功、自动编号 | **PASS** | `d02_01_title_is_required_and_code_is_generated`、`d02_01_second_order_appends_to_queue_tail` |
| D02-02 | 客户可选、内联客户原子提交 | **PASS** | `d02_02_*` 四个用例（含失败回滚、同名不合并） |
| D02-03 | 整体保存与 revision 冲突 | **PASS** | `d02_03_*` 三个用例 |
| D02-04 | NULL 金额与 0 区分 | **PASS** | `d02_04_null_amount_differs_from_zero` |
| D02-05 | 未开工不可推进或完成 | **PASS** | `d02_05_cannot_advance_or_complete_before_starting` |
| D02-06 | 开工后可正常推进 | **PASS** | `d02_06_*` 两个用例 |
| D02-07 | 返工一步与更早阶段 | **PASS** | `d02_07_*` 两个用例 |
| D02-08 | 撤销开工满足 FIX-03 | **PASS** | `d02_08_*` 四个用例 + 重排绕过 |
| D02-09 | 单阶段必须先开工才能完成 | **PASS** | `d02_09_single_stage_order_must_start_before_completing` |
| D02-10 | 未开工允许取消 | **PASS** | `d02_10_unstarted_order_can_be_cancelled_and_does_not_fake_a_start` |
| D02-11 | 终态锁与资料可编辑 | **PASS** | `d02_11_*`（lifecycle + details 各一） |
| D02-12 | 重开保留阶段与开工状态 | **PASS** | `d02_12_*` 两个用例 |
| D02-13 | 重开进入队列末尾 | **PASS** | `d02_13_reopen_appends_to_the_active_queue_tail` |
| D02-14 | 多次完成保留多个事件 | **PASS** | `d02_14_completing_twice_records_two_completion_events` |
| D02-15 | 阶段改名不改历史快照 | **PASS** | `d02_15_rename_keeps_historical_snapshots` |
| D02-16 | 删除当前阶段必须选替代 | **PASS** | `d02_16_removing_current_stage_requires_a_replacement` |
| D02-17 | 事务失败不留孤立事件 | **PASS** | `d02_17_*` 三个用例（触发器注入真实失败） |
| D02-18 | 重复请求不产生重复事件 | **PASS** | `d02_18_*` 三个用例 |
| D02-19 | 内部导航不丢失未保存草稿 | **PASS**（用户实机验收） | 2026-11-17 用户手动验证：内部导航与切换订单均被拦截，三种处理选项均实际操作通过。自动化侧另见 DEV03-RESULTS 的 17 个前端用例 |
| D02-20 | 真实窗口走通主要生命周期 | **PASS**（用户实机验收） | 2026-11-17 用户手动走通：创建、开工、推进、返工、资料保存、完成、重新打开、历史查看；自动化侧由 23 个集成用例覆盖同一领域路径 |

---

## G. 生命周期端到端证据

### G.1 真实应用启动与 schema 升级

真实应用以既有数据目录启动，**自动完成 v1 → v2 隔离代际升级**：

```text
[minidesk] env ready path=/Users/rinto/Library/Application Support/dev.artflow.minidesk
           generation=gen-e05d7ce65b8d40c0a0d23bedf18476ee schema=v2 first_run=false tz=Asia/Shanghai

generations/
  gen-e05d7ce65b8d40c0a0d23bedf18476ee  → user_version = 2   （当前活动代）
  gen-f8930531c59f437795d99d28a7ae25c5  → user_version = 1   （保留的旧代）
state/active.json → gen-e05d7ce…  updatedAt 2026-11-16T11:40:59.392Z

窗口（CoreGraphics）: WIN 34951 owner=artflow-minidesk 1120×760 @ (400,103)
```

这说明迁移链、代际复制、指针切换在真实应用里跑通了，而不只是测试。

### G.2 完整生命周期（测试中的真实数据库路径）

`d02_14` 用例走完：创建 → 开工 → 完成 → 重开 → 再完成，事件序列为

```text
created → work_started → completed → reopened → completed
```

`d02_08_undo_then_restart_starts_a_new_window` 的事件序列：

```text
created → work_started → work_start_undone → work_started
```

`d02_08_reorder_cannot_bypass_the_undo_restriction`：

```text
created → work_started → stage_advanced → workflow_changed
```

即使把当前阶段重排到第一位，`canUndoStartWork` 仍为 false——
判定依据是「本次开工事件之后是否发生过推进/返工」，不是阶段索引。

### G.3 事务回滚

触发器 `BEFORE UPDATE ON orders RAISE(ABORT)` 注入失败后：

```text
advance_stage → 返回 DB 错误
订单 revision 不变、当前阶段不变、order_events 数量不变
```

---

## H. 已修复问题与未解决风险

### H.1 本轮发现并修复

| # | 问题 | 处理 |
|---|---|---|
| 1 | `order_events.request_id` 最初建成全局唯一，导致两个订单不能复用同一个键，与"按订单幂等"的判定不一致 | 改为 `UNIQUE(order_id, request_id)` |
| 2 | `ClientChoice` 的枚举字段未做 camelCase 重命名，前端传 `clientId` 会被拒 | 加 `rename_all_fields`，并补 JSON 契约测试锁死 |
| 3 | 资料保存遇到"内容与库里完全一致"时会误报 revision 冲突（重试场景） | 内容一致即视为成功，不 bump revision |
| 4 | 迁移测试断言写死 v1，v2 上线后失效 | 改为读 `APP_SCHEMA_VERSION`，升级测试改用测试专属 v3 |
| 5 | 单步返工被标成"多阶段返工" | 修正为仅在跨越 >1 阶段时标注，并调整断言 |

### H.2 未解决 / 未验证

1. ~~D02-19、D02-20 未人工验证。~~ **已于 2026-11-17 由用户实机验收通过**（12/12）。
   我这边仍然没有辅助功能与录屏权限，无法自行点击或截图，因此**人工结论来自用户操作，不是我的观测**；
   自动化证据只覆盖领域逻辑与对话框行为。
2. **桌面窗口关闭保护未实现**（`useBeforeUnload` / 关闭确认留给 DEV-06）。
   应用内路由与切换订单已保护，但**直接关窗仍会丢草稿**——这一点在报告里明确算未覆盖。
3. 队列插入位置、拖拽与上移下移未实现（DEV-03）。当前只保证"默认队尾"。
4. 客户仅支持"选已有 / 内联新建"，无客户管理页（DEV-03）。
5. 金额输入为元字符串，前端用正则校验；后端只接受整数分。非法输入在前端报错，未做远程端二次解析。
6. 全局模板（新增/删除/排序/默认模板）未实现，当前只有内置单一模板（DEV-03）。

---

## I. 隔离核验

| 对象 | 结果 |
|---|---|
| ArtFlowDesk 旧工程 | 未修改。DEV-02 开始时 `a4dccda` + 3 个未提交改动（另一进程在编辑模板功能），结束时未触碰；未执行任何 git 写操作 |
| TV-01 实验数据库 | `integrity_check = ok`，订单 1，历史 5 |
| TV-03 演示沙箱 | 2 代、1 备份，未触碰 |
| 正式应用数据目录 | 仅本应用自己的环境：迁移后 2 个代际（v2 活动 / v1 保留），订单 0 条 |
| 测试数据 | 全部在 `tempfile` 临时目录，测试结束回收 |

---

## J. DEV-03 建议与前置条件

### 需要用户确认

1. **请按下面脚本点一遍**（约 2 分钟），确认界面可用；我这边没有权限验证：
   1. 打开应用 → 左侧点「新建」→ 只填标题 → 创建
   2. 右侧点「开始制作」→ 点「推进阶段」两次
   3. 点「返工一步」→ 再点「推进阶段」
   4. 修改资料里的金额为 `1200.5` → 点「保存资料」
   5. 直接改标题但不保存 → 点左侧另一张订单（或再点「新建」）→ 应弹出三选项
   6. 点「完成」→ 弹出确认 → 确认 → 点「重新打开」
   7. 看「制作历史」是否按顺序列出上述事件
2. **队列插入位置与拖拽**是否在 DEV-03 一次做完（含上移下移与并发冲突）。
3. **客户管理页**是否与模板管理同批，还是拆开。

### DEV-03 建议范围

- 活动队列：指定位置插入、上移/下移、拖拽，全部检查 `queue_revision`
- 客户管理：列表、编辑、改名、同名区分、关联订单
- 全局流程模板：CRUD、1–20 阶段、唯一名、唯一默认模板、删除默认前需另选
- 订单列表的密度模式与筛选（D-00-18 / D-00-25 的最小版本）

### 验收建议

沿用本轮口径：每个写操作一个事务 + revision 检查、失败不得报告成功、
新增命令必须进白名单、重复请求必须有幂等键。
D02-19 / D02-20 这类需要真实点击的项，建议在 DEV-03 前由用户补一次，避免累积。

---

## 判定

**DEV-02 阶段验收通过**：20 个验收项全部 PASS（18 项由自动化用例证明，D02-19 / D02-20 由用户实机操作证明）。

补充：未保存确认 UI 的位置问题已作为 DEV02-UI-01 在 DEV-03 阶段修复，
详见 `DEV03-RESULTS.md`。桌面窗口关闭保护仍未实现，属 DEV-06。
