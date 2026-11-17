# DEV-05 工作台 · 历史统计 · CSV 导出 — 结果报告

- 日期：2026-11-17
- 工程：`/Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk`
- 结论：后端全部落地并有测试；**界面与真实保存对话框未经我点击验证**（无辅助功能与录屏权限），
  相关验收项标 PARTIAL / NOT RUN，等用户实机确认。

---

## 1. 执行摘要

| 交付 | 状态 |
|---|---|
| 工作台 8 个指标 + 到期提醒口径 | 已实现 |
| 订单列表风险徽标（与工作台同一套判定） | 已实现 |
| 指标卡点击跳转对应筛选 / 完成事件明细 | 已实现 |
| 历史统计（事件口径 + 金额按创建月归属） | 已实现 |
| 月度趋势（纯 SVG/CSS，无第三方图表库） | 已实现 |
| 汇总 CSV 导出 | 已实现 |
| 订单明细 CSV 导出（范围选择 + 预计条数） | 已实现 |
| CSV 安全（转义、防公式注入、BOM） | 已实现 |
| 规格索引与未完成事项登记 | 已新增两份文档 |

实测：`cargo test` **261 passed / 0 failed**、`cargo check --all-targets` **0 warning**、
`npm run test` **75 passed**、`tsc --noEmit` 通过、`vite build` 通过、应用真实启动正常。

**没有 schema 变更**，用户数据零迁移。

---

## 2. 依据的规格与五项裁定

| 裁定 | 落实方式 |
|---|---|
| 1.1 到期提醒归 DEV-05 | 工作台 4 个到期指标 + 列表风险徽标，共用 `domain/deadline.rs` 一套判定 |
| 1.2 轻量时间轴归 DEV-06 | 本轮未实现，已登记到 `REMAINING-WORK.md` |
| 1.3 永久删除为 DEV-07 前置 | 本轮**不新增任何危险写命令**；统计只 JOIN 仍存在的订单 |
| 1.4 CSV 不提供联系方式开关 | 明细固定不导出联系方式/备注/路径，无任何开关 |
| 1.5 未知金额明确展示 | 汇总与统计页都显示「未知金额订单：N」，合计不含 NULL |

对应冻结条目：D-00-19（工作台）、D-00-28（历史统计）、D-00-31（统计口径）、
D-00-06（日期与提醒）、FIX-06（完成指标）、FIX-07（CSV）、R-04（统计 CSV 与明细）。
条目摘要与来源见新增的 `docs/SPEC-INDEX.md`（**注意：规格原文不在仓库内**）。

---

## 3. Git、schema 与正式数据状态

| 项 | 值 |
|---|---|
| 起始 HEAD | `4a3f385` |
| 分支 | `master`，未推送 |
| schema | **v3，未变**（未创建 v4） |
| 代际 | 3 个，未新增（无迁移） |
| 正式数据 | 3 个订单 / 1 个客户 / 1 个模板 / 2 张附件，全部保留 |

启动实测：

```text
[minidesk] env ready generation=gen-c00a879220964299af7adcef8b9fc1c5 schema=v3 first_run=false tz=Asia/Shanghai
窗口：WIN 36623 owner=artflow-minidesk 1120×760 @ (400,103)
```

---

## 4. 工作台指标与到期提醒口径

`domain/dashboard.rs` + `domain/deadline.rs`。

| 指标 | 口径 |
|---|---|
| 活动订单 | `status = 'active'` |
| 排队中 | 活动且 `started_at IS NULL` |
| 制作中 | 活动且 `started_at IS NOT NULL` |
| 三日内到期 | 交付日在 **明天～第三天（含）** |
| 今天到期 | 交付日 = 今天 |
| 已逾期 | 交付日 < 今天 |
| 未排期 | 交付日 IS NULL |
| 本月完成次数 | 本月 `completed` **事件**数（不是状态为 completed 的订单数） |

四类风险互斥，且只对活动订单计算；终态订单在视图里恒为 `scheduled`，不进入提醒。

判定用**工作时时区的日历日期**，不做 24 小时乘法：

```rust
classify(delivery: Option<NaiveDate>, today: NaiveDate) -> DeadlineState
```

测试覆盖跨月（1 月 30 日 → 2 月 2 日仍算三日内）、跨年（12 月 31 日 → 1 月 3 日）、
闰年 2 月（2028-02-28 → 03-02）。

**单一来源**：`orders::load` 直接返回 `deadline_state`，列表与工作台读同一个字段，
不存在两套算法。测试 `order_list_and_dashboard_agree_on_risk` 断言这一点。

提醒**不改变队列**：本轮没有在提醒路径上写 `queue_position` / `queue_revision` 的代码，
`reports_do_not_touch_order_or_queue_versions` 用例断言统计与提醒前后版本不变。

---

## 5. 历史统计的事件口径

`domain/stats.rs`。统计范围 4 档：本月 / 近 6 / 近 12 / 全部，均为**含当前月的自然月**。

事件计数 SQL（要点）：

```sql
SELECT e.kind, e.occurred_at
FROM order_events e
JOIN orders o ON o.id = e.order_id          -- 只统计仍存在的订单
WHERE e.kind IN ('created', 'completed', 'cancelled')
```

月份归属在 Rust 侧完成：`occurred_at` → 工作时时区 → `YYYY-MM`。
这样跨月/跨年/夏令时都由时区库负责，SQL 里不做日期运算。

- 同一订单两次完成 → 两个 `completed` 事件 → 计 2 次（测试 `event_counts_follow_events_not_status`）。
- 重开不会擦除之前的完成（`reopen_does_not_erase_previous_completions`）。
- 订单被删除后，事件因级联消失，不再计数（`events_of_missing_orders_are_not_counted`）。
- 取消不是删除，取消事件仍计数（`cancelled_orders_still_count_their_cancel_events`）。
- 时区变化只改变归属月份（`events_are_attributed_by_working_timezone_month`：
  同一时刻在上海归 11 月、在洛杉矶归 10 月）。

---

## 6. NULL 金额与创建月份归属

- 金额按**订单创建月份**归属，取该订单**当前** `amount_cents`。
- `NULL` 不计入合计，计入 `unknownOrders`；`0` 计入合计与 `knownOrders`。
- 金额全程用 `i64` 整数分累加，仅展示时转元；测试用 `999999999.99` 级别的值断言无浮点漂移。
- 修改当前金额会影响创建月份（`amount_follows_creation_month_and_current_value`）。
- 重复完成不会重复累加金额（金额按订单、不按事件）。

界面：统计页合计卡片 + 逐月明细都显示「已知金额 / 已知订单 / 未知订单」；
未知订单 > 0 时额外用一句话说明「没有被当成 0 元」。

---

## 7. CSV 格式、安全与隐私

### 7.1 两个独立出口

| 出口 | 入口 | 内容 |
|---|---|---|
| 统计汇总 | 统计页「导出汇总 CSV」 | 说明块 + 月度明细 + 合计 + 口径说明 |
| 订单明细 | 订单页「导出」 | 说明块 + 逐单一行 |

明细导出前必须选范围：**当前筛选结果（N 条）** 或 **全部订单（M 条）**，
两个数字都来自界面当前状态；选「当前筛选」时把可见订单 ID 传给后端，
**后端不另造一套过滤规则**。

### 7.2 格式

- UTF-8 **BOM** 开头（`EF BB BF`），Excel/Numbers 打开中文不乱码。
- **CRLF** 行尾。
- 含逗号 / 双引号 / 换行的单元格按 RFC 4180 加引号、双引号成对转义。

### 7.3 防公式注入

`Cell` 区分文本与数字：

- **文本**：若去掉前导空白与控制字符后以 `= + - @ \t \r` 开头，前置 `'`。
  覆盖 `=cmd|...`、`+1+1`、`-2+3`、`@SUM(...)`、`\t=1`、`   =1+1` 六种样本。
- **数字 / 金额**：原样输出，不加前缀 —— 所以 `-5`、`0`、`1234.56` 仍是数值，
  不会因为防注入被降级成文本。

副作用必须说清：被前缀的文本在表格软件里会**显示一个前导单引号**。
这是 OWASP 推荐做法，代价是可见字符发生变化。若不可接受，需要换方案（例如仅对真危险值加 `\t`）。

### 7.4 隐私

明细固定**不导出**：客户联系方式、客户/订单备注、附件路径、文件系统绝对路径、任何内部 ID 之外的系统信息。
测试用 `CONTACT-SECRET-42` / `NOTE-SECRET-42` 这两个哨兵值断言它们不出现在任何一行。

> 踩过一次坑：最初用「私人备注」当哨兵，结果命中了 CSV 里的隐私说明文字，误报。
> 改成哨兵值是正确做法。

---

## 8. 导出失败与取消路径

| 情况 | 行为 | 测试 |
|---|---|---|
| 用户在保存对话框取消 | 不创建文件、不提示成功、不动数据库 | `StatsPage.test` / `OrdersPage.export.test` |
| 目标目录不存在 | `INVALID`，不留下任何文件 | `write_failures_are_reported_and_leave_nothing_behind` |
| 目标路径为空 | `INVALID` | 同上 |
| 目标是目录或符号链接 | 拒绝覆盖 | 同上 |
| 写入中途失败 | 先写同目录临时文件再 rename；失败删除临时文件 | 同上（断言无 `minidesk-export-*` 残留） |
| 导出前后数据 | 订单 revision / updated_at / queue_revision 不变 | `export_does_not_touch_the_database` |

---

## 9. 测试命令与结果

```text
cargo test                → 261 passed / 0 failed
cargo check --all-targets → 通过，0 warning
npm run test              → 75 passed（10 个文件）
npx tsc --noEmit          → 通过
npm run build             → built in 94ms
```

本轮新增：

| 文件 | 数量 | 覆盖 |
|---|---|---|
| `tests/stats.rs` | 18 | 互斥边界、跨月/跨年/闰年、工作台计数、终态排除、事件口径、时区归属、删除订单不计、金额归属、大额精度、只读性、完成事件下钻、列表与工作台一致 |
| `tests/export_csv.rs` | 11 | BOM/CRLF、转义、防公式注入（6 种）、数字语义、隐私哨兵、口径说明、范围差异、写盘成功/失败、只读性、未知金额标记 |
| `src/pages/DashboardPage.test.tsx` | 6 | 指标数字、跳转链接、关注提示、错误态 |
| `src/pages/StatsPage.test.tsx` | 8 | 范围/时区/合计、未知金额说明、切换范围、取消导出、成功导出、失败导出、完成事件明细、空状态 |
| `src/pages/OrdersPage.export.test.tsx` | 6 | 范围与预计条数、取消、当前筛选、全部、筛选后条数、失败 |
| `src/lib/ordersView.test.ts` | +3 | 风险筛选、工作状态筛选、风险徽标 |

Rust 232 → **261**；前端 52 → **75**。

---

## 10. 未实现事项与限制

1. **界面从未被点击验证**：工作台、统计页、导出对话框、CSV 保存对话框。
   自动化只能证明组件行为，不能证明真实渲染与原生对话框。
2. **CSV 前缀单引号的可见副作用**：见 7.3，需你确认是否接受。
3. 图表是手写的月度柱状图（CSS flex + 高度百分比），没有坐标轴刻度线与数值标签，
   只在 `title` 里给出数值。若需要更正式的可视化，属于 DEV-06 的视觉范围。
4. 统计只按**月**聚合，没有按日/按客户维度。
5. 明细导出按订单创建时间排序，未提供排序选项。
6. 工作台没有「未来 7 天 / 本月交付」等额外界别（规格只要求三日内）。

---

## 11. 隔离核验

| 对象 | 结果 |
|---|---|
| 正式用户数据 | 3 订单 / 1 客户 / 1 模板 / 2 附件全部保留；未改创建时间、金额或事件 |
| schema / 代际 | v3，3 代，均未变 |
| 旧 ArtFlowDesk Web 工程 | 未触碰 |
| TV 实验工程与数据库 | 未触碰 |
| 测试数据 | 全部 `tempfile` 临时目录 + jsdom |

---

## 12. 需要用户 macOS 实机验收的项目

| # | 项目 | 状态 | 说明 |
|---|---|---|---|
| 1 | 工作台八个指标与真实数据一致 | **NOT RUN** | 需点击查看 |
| 2 | 「本月完成次数」点进去看到完成事件明细，再点进入订单 | **NOT RUN** | 依赖真实路由跳转 |
| 3 | 切换「本月/近 6/近 12/全部」，数字随之变化 | **NOT RUN** | |
| 4 | 未知金额订单显示为「未知金额订单：N」，合计不含它 | **NOT RUN** | |
| 5 | 修改某订单金额后，其创建月份的汇总变化 | **NOT RUN** | |
| 6 | 导出汇总 CSV，用 Excel/Numbers 打开：中文正常、单位正确 | **NOT RUN** | 需要真实保存对话框 |
| 7 | 明细 CSV 以 `=`/`+`/`-`/`@` 开头的标题不会变成公式 | **NOT RUN** | 需要真实表格软件 |
| 8 | CSV 中不含联系方式与私人备注 | **PARTIAL** | 后端有哨兵断言；实际文件需你打开确认 |
| 9 | 保存对话框取消后没有生成文件 | **NOT RUN** | |
| 10 | 列表风险徽标与工作台数字一致；队列顺序未被改动 | **NOT RUN** | |

自动化已 PASS 的部分：所有领域计算、CSV 编码与写盘、组件行为（上表之外的用例）。

---

## 13. DEV-06 前置条件

1. 主题系统需要覆盖本轮新增的 `.metric-*`、`.chart*`、`.risk-*` 等类名——
   这些目前用的是 `:root` 里的 Arctic Blue 变量，未硬编码颜色（`#9fb6cb` 等处有少量固定值，
   主题化时需要收敛成变量）。
2. 轻量时间轴（D-00-05）在 DEV-06 实现时，**日期判定必须复用 `domain/deadline`**，
   不要另写一套。
3. 窗口关闭保护（DEV-06）要接上现有的 `modalStack`，与未保存对话框共用栈。
4. 订单列表的风险徽标位置由 DEV-06 决定是否重新设计，但**判定逻辑不得复制**。
5. 若 DEV-06 引入表格/图表样式调整，注意 CSV 导出的列语义不要跟着变（CSV 是数据契约）。
