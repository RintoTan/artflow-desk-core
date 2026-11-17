# DEV-05-FIX 验收问题修复 — 结果报告

- 日期：2026-11-17
- 工程：`/Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk`（分支 `master`，未推送）
- 范围：DEV05-UI-01（完成事件下钻失败）、DEV05-UX-02（模板选择入口核对）、
  以及新增的 QA 沙箱与分层实机验收机制
- 结论：**已关闭。** 用户实机复测 S3-A / S3-B / T1 全部 PASS（见第 0 节）。
  自动化部分见第 7 节；两者分开记录，不互相代替。

---

## 0. 关闭结论（2026-11-17，用户实机）

| 编号 | 项目 | 结论 |
|---|---|---|
| S3-A | 第一条完成事件打开正确订单 | **PASS** |
| S3-B | 同一订单第二条完成事件也打开正确订单 | **PASS** |
| T1 | 新建订单可以选择两套流程模板，取消后没有创建订单 | **PASS** |

- **DEV05-UI-01 关闭**：S3 的修复在真实窗口中被确认。
- **DEV05-UX-02 关闭**：T1 确认模板选择入口存在且行为正确。
  我上一轮按"证据不足"回退了控件（`888200e`），该判定被这次实机结果推翻；
  控件已原样恢复（`20e24e0`，含 5 个用例），后端未改。
- 因此下面第 4 节保留的是**判定过程记录**，最终结论以本节为准。

---

## 1. 你的验收结果（如实记录）

### 1.1 DEV-05 基础 macOS 验收

**8 / 8 PASS**（由你实机确认，我未参与点击）。

### 1.2 DEV-05 专项验收

| 编号 | 项目 | 你的结论 |
|---|---|---|
| S1 | 首次完成后「本月完成次数」+1 | **PASS** |
| S2 | 重开后再次完成，累计 +2 | **PASS** |
| S3 | 同一订单的完成事件明细可下钻至订单 | **FAIL** |
| C1 | Numbers 没有把 `=1+1` 算成数字 | **PASS** |
| C2 | CSV 原始文本带安全前缀 | **PASS** |

综合：基础 8/8 PASS + 专项 4/5 PASS。S3 仍未关闭，本报告只对它负责。

---

## 2. DEV05-UI-01：S3 的实际根因

### 2.1 完整链路（逐环节核对）

| # | 环节 | 代码位置 | 结论 |
|---|---|---|---|
| 1 | 工作台「本月完成次数」卡片 | `DashboardPage.tsx:73` | 正常，跳 `/stats?range=thisMonth&focus=completed` |
| 2 | 完成事件明细列表 | `StatsPage.tsx:255` | 正常，`focus=completed` 时才渲染 |
| 3 | 事件行点击目标 | `StatsPage.tsx:272` | 正常，`<Link to={/orders?orderId=${event.orderId}}>` |
| 4 | 事件携带的 order ID | `CompletedEventRow.orderId` | **正常**，值正确（不是缺字段） |
| 5 | React Router 实际路由 | `main.tsx` HashRouter | 正常，路径确实变成 `/orders?orderId=...` |
| 6 | 订单页的详情选择与加载 | `OrdersPage.tsx` 挂载 effect | **缺陷就在这一环** |
| 7 | 搜索 / 状态筛选 / 当前选择 / 路由状态 | `visible` 只影响左栏列表 | 不是原因；详情与筛选无关 |
| 8 | 事件数据可读但导航字段缺失 | — | **不存在**，`orderId` 一直有值 |

### 2.2 根因

`OrdersPage` 挂载时无条件把列表第一张订单设为详情：

```tsx
// 修复前
if (list.length > 0 && list[0]) {
  await selectOrder(list[0].id);
}
```

链接把 `?orderId=order-b` 带进来，挂载 effect 却在同一个 async 流程里用
`list[0].id` 覆盖了它。URL 变了、页面也刷新了，看起来"跳转成功"，
但详情区显示的是另一张订单。这也解释了你观察到的现象：**统计对、历史没丢、就是进不去那张单**。

### 2.3 修复

```tsx
// 修复后
// 从工作台/统计页带着 orderId 跳进来时，必须选中那一张，
// 不能因为"默认选第一张"把它覆盖掉（S3 的根因就是这个覆盖）。
const requested = params.get("orderId");
const targetId = requested ?? list[0]?.id;
if (targetId) {
  await selectOrder(targetId);
}
```

- 带 `orderId` → 打开那一张；不带 → 仍按旧行为选第一张。
- 订单不存在 → `selectOrder` 的 catch 走 `describeError` 显示明确错误，
  **不会回退到第一张装作成功**。
- 详情态与左栏筛选解耦：目标订单即使被搜索/筛选挡住，也照常打开。
- 没有第二套查询：仍走 `api.getOrder` + `api.listOrderEvents`。
- 事件标识保留：同订单两条事件在列表里仍是两行，没有合并。

---

## 3. 导航修复的测试证据

`src/pages/StatsDrilldown.test.tsx`（4 个用例，真实路由 + 真实详情加载，不是断言 href）：

| 用例 | 断言 |
|---|---|
| 点击完成事件会真正打开该订单详情 | 点击后 `h1` 变成目标订单标题；`pathname === "/orders"`；`getOrder` 收到 `order-b` |
| 同一订单的两条完成事件都能打开同一张订单 | 点第 2 条链接同样落到 `order-b` |
| 目标订单不在列表首项时也不会退回第一张 | 详情标题是 `被完成两次的订单`，且**不是** `第一张订单` |
| 订单不存在时显示明确错误而不是假装打开 | `/orders?orderId=ghost` → 出现「订单不存在」 |

第 1、3 条是关键：专门检测"只改了 URL 但没换详情"。

---

## 4. DEV05-UX-02：模板选择入口 —— 证据不足，维持现状

### 4.1 结论（已被第 0 节推翻，保留作为过程记录）

当时的结论是"证据不足，维持默认模板"。该结论在用户实机复测后被推翻：
T1 确认模板选择入口存在且行为正确，UX-02 关闭，控件已恢复。

下面的证据表保留原样，用来说明**为什么当时会判成 B**——问题不在于后端能力，
而在于规格原文不在仓库里，我只有摘要。

### 4.2 证据

| 证据 | 内容 | 支持哪一边 |
|---|---|---|
| `docs/SPEC-INDEX.md` D-00-07 | 「仅标题必填；**默认通用流程**；创建时复制阶段」 | **B**（写的是用默认流程） |
| `docs/SPEC-INDEX.md` D-00-14 | 「模板 1–20 阶段、名称唯一、唯一默认模板」 | 只约束模板自身，不涉及建单选模板 |
| 规格原文 | **不在仓库内**（我只有你给的摘要），无法引用"必须可选"的句子 | 无法支持 A |
| `CreateOrderInput.template_id`（自 DEV-03） | 后端接受可选模板 ID | 只说明**数据模型允许**，不等于 UI 必须提供 |
| `tests/order_create.rs::invalid_template_is_reported_not_silently_defaulted` | 传未知模板 → `NOT_FOUND`，不静默回落 | 同上：保证传值可信，不是要求传值 |

按你给的分支规则："若只能确证 B 或证据不足：不擅自加入新功能、保留现状"。

### 4.3 处理、回退与再恢复（如实记录）

上一轮我按"已落地契约 + 既有测试"推断为 A，在 `753681c` 里加了「制作流程」下拉，
并在当时的报告里写了保留意见。按本轮明确的口径（没有规格原文就不算确证），
那属于**超出授权的新功能**，已在 `888200e` 回退：

- 移除下单面板的下拉、`templates` 状态与 `templateApi.list()` 调用；
- 删除配套的 5 个用例与 3 处只为它添加的 mock；
- **后端未动**：`create_order` 的 `templateId` 参数是 DEV-03 既有能力，有独立测试，
  不因回退而移除；界面不传值时后端一律回落到默认模板。

回退后新单阶段仍是默认模板的 5 个阶段。

随后你的复测结果（T1 PASS）确认了控件本身是正确且必要的，
`20e24e0` 已把它原样恢复。这段"加了 → 删了 → 加回来"的来回，
根源是我在没有规格原文时按推断越权实现，而不是控件本身有问题。

### 4.4 决策结果

`docs/REMAINING-WORK.md` #20 已关闭：按单选择模板**成立**，控件已恢复，无 schema 或接口变更。

---

## 5. 本轮新增：QA 沙箱与分层实机验收

完整设计、命令与操作步骤见 **[`docs/QA-SANDBOX.md`](QA-SANDBOX.md)**，这里只记要点与证据。

### 5.1 先评估后新增

现有代码只有 `app.path().app_data_dir()` 一个数据根，没有测试模式。
但 `store/paths.rs` 的 `Layout` 本来就把 `state/`、`generations/`、`highwater.sqlite`、
`attachments/`、`backups/`、`recovery/` 全部从单一 root 派生，`Environment::open_with`
本就接受任意根。

所以没有另造存储，只把 root 的来源改为"可配置 + 可验证"，其余机制原样复用。

### 5.2 四条硬约束（`src-tauri/src/store/qa.rs`）

| # | 约束 | 违反时 |
|---|---|---|
| 1 | 双钥匙 `AF_MINIDESK_QA=1` + `AF_MINIDESK_QA_ROOT=<绝对路径>` | 只设一个 → `ENV` 错误，**中止启动**，不回退正式目录 |
| 2 | 目标目录必须含 `.qa-root` 标记且内容匹配 | 拒绝启动 |
| 3 | QA 根与正式数据目录不得互相包含 | 拒绝启动 |
| 4 | 正式模式启动时正式目录里出现 `.qa-root` | 拒绝启动 |

界面标识：`environment_status` 返回 `qaMode`；外壳显示琥珀色横幅
「QA 测试环境 · 数据目录与正式应用完全隔离」，侧栏副标题变「QA 测试环境」，
「数据环境」页第一行显示「运行模式」。

### 5.3 隔离证据（`src-tauri/tests/qa_isolation.rs`，9 用例全通过）

关键是这两条：

- `two_roots_stay_separate`：在 QA 根启动后，正式目录**文件数量不变**、
  哨兵文件内容不变、不产生 `environment.json`。
- `maintenance_of_one_root_does_not_touch_the_other`：对 A 根做代际回收，
  B 根数据库完好；回收只看到 A 自己的旧代际。

其余 7 条覆盖：单钥匙、缺标记、错标记、同目录、正向嵌套、反向嵌套、反向守卫。

### 5.4 预置数据（`qa_seed`，全部经领域函数写入）

本轮实际生成的 QA 根：`/Users/rinto/ArtFlow-miniDesk-QA`，
代际 `gen-d9deacb28d364ab394f4ef5d35d78ab5`。

| 编号 | 标题 | 状态 | 金额 | 交付日 | 用途 |
|---|---|---|---|---|---|
| AF-2026-0001 | 双完成演示稿 | 已完成（两次） | 880.00 | 前天 | **S3 靶子**：`completed`(id 7) → `reopened`(8) → `completed`(9) |
| AF-2026-0002 | 制作中的加急稿 | 制作中 | 1500.00 | 今天 | 今天到期 |
| AF-2026-0003 | 已逾期的线稿 | 排队中 | 300.00 | 3 天前 | 逾期 |
| AF-2026-0004 | 未排期的草稿 | 排队中 | NULL | 无 | 未排期 + 未知金额 |
| AF-2026-0005 | 零元友情稿 | 已完成 | 0.00 | 昨天 | 0 元 ≠ 未知 |
| AF-2026-0006 | 已取消的企划 | 已取消 | 50.00 | 无 | 终态下钻 |
| AF-2026-0007 | `=1+1 公式注入标题` | 排队中 | 123.45 | 无 | CSV 防注入 + 3 张附件 |

客户 2 个（同名不同人「林小满」）、模板 2 个（默认 5 阶段 + 非默认 3 阶段）、
附件 3 张（PNG/JPEG/WebP，`image` 库现场生成纯色块，非真实作品）。

事件时间用真实 UTC 时间戳，没有伪造历史；所以"本月完成次数"当前为 **3**
（AF-0001 两次 + AF-0005 一次）。

### 5.5 QA 启动实测

```text
[minidesk] env ready mode=qa path=/Users/rinto/ArtFlow-miniDesk-QA
           generation=gen-d9deacb28d364ab394f4ef5d35d78ab5 schema=v3 first_run=false tz=Asia/Shanghai
```

同时复核正式环境：`generation=gen-c00a879220964299af7adcef8b9fc1c5` 未变，
`state/active.json` 的 mtime 仍是 15:16（我动手之前），订单 4 / 事件 23 / 完成 4 全部不变。

> 踩坑记录：第一次 QA 启动失败，报 `Port 1420 is already in use`——上一次正式启动留下的
> vite 进程没退干净。清理端口后重启成功。这条已写进 `QA-SANDBOX.md` 的排错段。

---

## 6. 变更文件与 Git 提交

| 文件 | 变更 |
|---|---|
| `src/pages/OrdersPage.tsx` | S3 根因修复（`?orderId=` 优先）；模板下拉已回退，回到默认模板 |
| `src/pages/StatsDrilldown.test.tsx` | **新增** 4 个下钻集成用例 |
| `src/App.tsx` / `src/App.test.tsx` | QA 横幅与侧栏标识（3 个用例） |
| `src/pages/StatusPage.tsx` | 「运行模式」行 |
| `src/styles.css` | `.qa-banner` |
| `src/bridge/commands.ts` | `EnvironmentStatus.qaMode` |
| `src-tauri/src/store/qa.rs` | **新增** QA 根解析与守卫 |
| `src-tauri/src/bin/qa_seed.rs` | **新增** 预置数据工具 |
| `src-tauri/tests/qa_isolation.rs` | **新增** 9 个隔离用例 |
| `src-tauri/src/{lib.rs, infra/state.rs, store/mod.rs, commands/status.rs}` | 接入 QA 根与标识 |
| `docs/QA-SANDBOX.md` | **新增** 沙箱设计与操作手册 |
| `docs/DEV05-FIX-RESULTS.md` | 本报告 |
| `docs/DEV05-RESULTS.md` / `docs/REMAINING-WORK.md` | 补记验收结论与待决策项 |

提交（本轮共 4 个）：

```text
753681c fix(orders): open the linked order and let new orders choose a template
3446b1a docs: DEV-05-FIX root cause, drill-down fix and template-selector ruling
888200e revert(orders): drop the new-order template selector pending a product ruling
b795dee feat(qa): isolated QA data root with seeded fictional scenarios
ac32bab docs: QA sandbox manual, corrected template ruling and re-test steps
20e24e0 feat(orders): restore the workflow template selector   ← 按实机 T1 结论恢复
```

`753681c` 里同时含 S3 修复与后来被回退的模板下拉；`888200e` 只回退了控件本身，
S3 修复保留。没有改写历史，因此这条界线在提交列表里看起来是"加了又删"。

**schema 未变（v3），没有迁移，没有新命令（仍是 45 个）。**

---

## 7. 自动化测试结果

```text
cargo test                → 270 passed / 0 failed（29 个测试二进制 + doc-tests）
cargo check --all-targets → 通过，0 warning
npm run test              → 87 passed / 0 failed（13 个文件，恢复模板 5 用例后）
npx tsc --noEmit          → 通过
npm run build             → ✓ built in 118ms（dist/assets/index-DnvW4JFi.js 392.85 kB）
```

Rust 261 → **270**（新增 `qa_isolation` 9 条）。
前端 75 → **87**：+4 下钻、+3 外壳 QA 标识、+5 模板选择（恢复后）。

> 说明：本轮（QA-01）之前的数字属于 DEV-05-FIX 实施时的证据，QA-01 起重新记录。

真实启动：正式模式与 QA 模式各启动一次，均通过（日志见 5.5 与上轮报告）。
**窗口像素与鼠标点击仍 NOT VERIFIED**：`osascript` 返回「不允许辅助访问 (-1728)」。

---

## 8. 回归核对

| 项目 | 证据 |
|---|---|
| 本月完成次数仍按事件计数 | `stats.rs` 18 用例通过，口径代码未动 |
| 同一订单重复完成计两次 | `event_counts_follow_events_not_status` 通过 |
| 工作台与统计页区间一致 | 共用 `month_bounds_utc`，未改 |
| 订单筛选、拖拽排序 | `OrdersPage.drag.test.tsx` 6 用例通过 |
| CSV 内容 / 隐私排除 / 防注入 | `export_csv.rs` 11 用例通过 |
| DEV-04 图片查看器与模态栈 | 未触碰 `modalStack` / `ImageViewer`；`TemplatesPage.delete` 9 用例通过 |
| 新订单默认模板逻辑 | 后端 `create_order` 未改；`order_create.rs` 11 用例通过 |
| 回退后下单面板 | 前端 82 用例全绿，`tsc` 通过 |

---

## 9. 你的真实数据隔离结果

动手前后各取一次指纹，**完全一致**：

| 项 | 修复前 | 修复后 |
|---|---|---|
| 活动代际 | `gen-c00a879220964299af7adcef8b9fc1c5` | 同 |
| `state/active.json` mtime | 15:16 | 15:16（未被写入） |
| schema | v3 | v3 |
| 订单 / 客户 / 模板 / 附件 | 4 / 1 / 2 / 2 | 4 / 1 / 2 / 2 |
| 生命周期事件（含 completed） | 23（4） | 23（4） |
| 正式目录内 `.qa-root` | 无 | 无 |

- QA 数据全部在 `/Users/rinto/ArtFlow-miniDesk-QA`，可整体删除。
- QA 启动期间正式目录未被打开（无锁占用、无新文件）。
- 旧 ArtFlowDesk Web 工程、TV-01/TV-03 工程与数据库：未触碰。
- 自动化测试全部在 `tempfile` 临时目录与 jsdom 中。

---

## 10. 需要你实机复测的项目

操作步骤在 **`docs/QA-SANDBOX.md` 第 5 节（启动）与第 7 节（步骤）**，这里只列判定点。

### A. 预置场景（QA 沙箱）

| # | 项目 | 期望 |
|---|---|---|
| 1 | 工作台「本月完成次数」 | 显示 **3** |
| 2 | 点进去看到完成事件明细 | **3 条**，其中两条属于「双完成演示稿」 |
| 3 | 点第一条「查看订单」 | 详情标题 = **双完成演示稿**（**已由用户复测 PASS**，2026-11-17） |
| 4 | 点同订单另一条 | 仍打开 **双完成演示稿** |
| 5 | 点「零元友情稿」那条 | 详情切到 **零元友情稿** |
| 6 | 地址改成 `#/orders?orderId=not-exist` | 显示「订单不存在」，不显示别的订单 |

第 3、4 条就是 S3 的复测点，均已由用户实机 PASS（S3-A / S3-B），本节保留作为将来回归的同一组检查。

### B. 从零流程（QA 沙箱）

| # | 项目 | 期望 |
|---|---|---|
| 7 | 「订单」→「新建」，只填标题后创建 | 新建成功，编号 `AF-2026-0008` |
| 8 | 打开该订单详情 | 阶段 = 默认模板 **5 个**（草稿/线稿/固有色/细化/最终调整） |
| 9 | 下单面板 | 有「制作流程」下拉，列出两套模板（已由用户 T1 复测 PASS） |

### C. 正式环境

| # | 项目 | 期望 |
|---|---|---|
| 10 | 正常启动（不带环境变量） | 顶部**没有** amber 横幅，「数据环境」显示「正式应用」 |

---

## 11. DEV-06 边界

DEV-06 原计划内容已登记在 `docs/REMAINING-WORK.md`：主题系统、轻量时间轴、
窗口关闭草稿保护、快捷键与键盘操作、侧边栏折叠与视觉打磨、统计图表数值可读性。

本轮**没有实现其中任何一项**，也没有顺手改样式（`.qa-banner` 是 QA 标识所需）。
DEV-05-FIX 到此停止。
