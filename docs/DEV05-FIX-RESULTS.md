# DEV-05-FIX 验收问题修复 — 结果报告

- 日期：2026-11-17
- 工程：`/Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk`（分支 `master`，未推送）
- 范围：DEV05-UI-01（完成事件下钻失败）、DEV05-UX-02（新建订单模板选择入口核对）
- 结论：**两个问题都已定位到具体代码位置并修复，自动化验证通过。**
  S3 需要你再次用真实鼠标点一次才能关闭——我没有辅助功能与录屏权限，
  不能替你点击，也不会把"测试通过"当成"实机通过"。

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

综合：基础 8/8 PASS + 专项 4/5 PASS。S3 是唯一未通过项，本报告只对它负责，
另外核对了你提出的"新建订单没有模板选择入口"。

---

## 2. DEV05-UI-01：S3 的实际根因

### 2.1 完整链路（逐环节核对结果）

| # | 环节 | 代码位置 | 结论 |
|---|---|---|---|
| 1 | 工作台「本月完成次数」卡片 | `DashboardPage.tsx:73` | 正常，跳 `/stats?range=thisMonth&focus=completed` |
| 2 | 完成事件明细列表 | `StatsPage.tsx:255` | 正常，`focus=completed` 时才渲染 |
| 3 | 事件行点击目标 | `StatsPage.tsx:272` | 正常，`<Link to={/orders?orderId=${event.orderId}}>` |
| 4 | 事件携带的 order ID | `CompletedEventRow.orderId` | **正常**，值正确（不是缺字段） |
| 5 | React Router 实际路由 | `main.tsx` HashRouter | 正常，路径确实变成了 `/orders?orderId=...` |
| 6 | 订单页的详情选择与加载 | `OrdersPage.tsx` 挂载 effect | **缺陷就在这一环** |
| 7 | 搜索 / 状态筛选 / 当前选择 / 路由状态 | `visible` 只影响左栏列表 | 不是原因；详情与筛选无关 |
| 8 | 事件数据可读但导航字段缺失 | — | **不存在**，`orderId` 一直有值 |

### 2.2 根因

`OrdersPage` 挂载时无条件把列表第一张订单设为详情，紧接在读完列表之后：

```tsx
// 修复前
if (list.length > 0 && list[0]) {
  await selectOrder(list[0].id);
}
```

于是发生了一次**静默覆盖**：链接把 `?orderId=order-b` 带进来，
挂载 effect 却在同一个 async 流程里用 `list[0].id` 覆盖了它。
URL 变了、页面也刷新了，看起来"跳转成功"，但详情区显示的是另一张订单（通常是队列第一张）。

这也解释了你观察到的现象：**统计数字对、历史没丢、就是进不去那张单**。
数据层完全正常，问题只在"选中哪一张"这一步。

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

- 带 `orderId` → 打开那一张；不带 → 仍按旧行为选第一张（不影响日常使用）。
- `getOrder` 不存在 → `selectOrder` 的 catch 走 `describeError` 显示明确错误，
  **不会回退到第一张装作成功**。
- 详情态与左栏筛选彻底解耦：目标订单即使被搜索/筛选挡住、不在列表里，也照常打开
  （`selectOrder` 不读 `visible`）。
- 没有新增第二套查询：仍然走 `api.getOrder` + `api.listOrderEvents` 原通路。
- 事件标识保留：`CompletedEventRow.eventId` 原样保留，同订单两条事件在列表里仍是两行，
  没有合并。

---

## 3. 导航修复的测试证据

新增 `src/pages/StatsDrilldown.test.tsx`（4 个用例），使用**真实路由 + 真实详情加载**，
不是断言 href 字符串：

| 用例 | 断言 |
|---|---|
| 点击完成事件会真正打开该订单详情 | 点击后 `h1` 变成目标订单标题；`router.state.location.pathname` 为 `/orders`；`getOrder` 收到 `order-b` |
| 同一订单的两条完成事件都能打开同一张订单 | 点第 2 条链接同样落到 `order-b` |
| 目标订单不在列表首项时也不会退回第一张 | 详情标题是 `被完成两次的订单`，且**不是** `第一张订单` |
| 订单不存在时显示明确错误而不是假装打开 | `/orders?orderId=ghost` → 出现「订单不存在」 |

第 1、3 条是关键：它们正是扫描"只改了 URL 但没换详情"的检测点。

---

## 4. DEV05-UX-02：模板选择入口是否属于冻结规格

### 4.1 结论

**判定为 A：新建订单可以指定模板，未指定时回落到当前默认模板。**
缺的是 UI 控件，不是后端能力。因此按 A 做了最小修复：**只加前端控件，后端零改动**。

### 4.2 证据链

| 证据 | 内容 | 倾向 |
|---|---|---|
| `docs/SPEC-INDEX.md` D-00-07 | 「仅标题必填；默认通用流程；创建时复制阶段」 | 单看摘要像 **B** |
| `docs/SPEC-INDEX.md` D-00-14 | 「模板 1–20 阶段、名称唯一、**唯一默认模板**」 | 说明"默认"是模板的一种属性，而非唯一用法 |
| `domain/orders.rs` `CreateOrderInput.template_id` | 自 `bb9e865`（DEV-03）起就在入参里，注明「未指定模板时使用数据库中标记为默认的那一个」 | **A** |
| `tests/order_create.rs::invalid_template_is_reported_not_silently_defaulted` | 传入不存在的模板 → `NOT_FOUND`，**不静默回退默认** | **A**（若只允许 B，这个用例没有存在意义） |
| `tests/order_create.rs:110` | 建单失败时新客户与订单必须回滚（用未知模板触发） | **A** |

**诚实的保留**：D-00-07 的一行摘要本身只写了"默认通用流程"，
如果只看它，B 也说得通；规格原文不在仓库内，我无法引用更细的句子。
判定 A 的依据是**已落地的契约与既有测试**，不是我对规格的推断。

如果产品最终认定只有 B，删掉这个下拉即可，后端行为完全不变（前端会传 `null`）。

### 4.3 实现

`CreateOrderPanel` 新增「制作流程」下拉：

- 选项来自 `templateApi.list()`，显示「名称（N 个阶段）」，默认项额外标 `· 默认`。
- 初值 = `isDefault` 的那一个；没有默认则取第一个；列表为空则显示「（使用默认流程）」。
- 提交时 `templateId: templateId === "" ? null : templateId` —— 空值交给后端回落默认。
- 模板列表晚于面板挂载到达时会补齐默认值，避免"下拉显示 X、实际提交空"的错位。
- **已创建订单的阶段快照不受影响**：只读模板表来建新单，任何编辑/删除模板的操作都不回写历史订单
  （`templates.rs` 的 `usageCount` 只做统计）。

### 4.4 测试（`src/pages/OrdersPage.create.test.tsx`，5 个用例）

| 用例 | 断言 |
|---|---|
| 默认选中当前默认模板 | `select.value === "tpl-default"`，选项文本含「通用制作流程」与「默认」 |
| 可以选择另一个模板，并把模板 ID 传给后端 | 选 `tpl-simple` → `createOrder` 入参 `templateId === "tpl-simple"` |
| 不改动选择时沿用默认模板 | 不碰下拉 → 入参 `templateId === "tpl-default"` |
| 模板列表为空时不传模板 ID | 列表为空 → 入参 `templateId === null`（交给后端默认） |
| 说明文字提示会复制阶段成订单独立流程 | 提示文案存在 |

> 过程记录：这组测试第一次跑是 1 通过 3 失败，原因有两个，都是我自己写错，不是产品缺陷：
> ① 我把 `<p class="hint">` 放在 `<label>` 里面，提示文字被算进了 `select` 的可访问名称，
> `getByLabelText("制作流程")` 自然找不到；现在提示移到 label 之外，并给 select 显式 `id`。
> ② 测试里的 `getOrder` mock 复用了 `createOrder` 的 mock，创建后加载详情又调了一次，
> 造成"期望 1 次实际 2 次"的假失败；现在两者各自独立。

---

## 5. 变更文件与 Git 提交

| 文件 | 变更 |
|---|---|
| `src/pages/OrdersPage.tsx` | S3 根因修复；新建面板接入模板下拉（+ 晚到补齐默认值） |
| `src/pages/StatsDrilldown.test.tsx` | **新增** 4 个下钻集成用例 |
| `src/pages/OrdersPage.create.test.tsx` | **新增** 5 个模板选择用例 |
| `src/pages/OrdersPage.drag.test.tsx` | 补 `templateApi` mock（页面新增依赖） |
| `src/pages/OrdersPage.export.test.tsx` | 同上 |
| `src/pages/OrdersPage.guard.test.tsx` | 同上 |
| `docs/DEV05-FIX-RESULTS.md` | 本报告 |
| `docs/DEV05-RESULTS.md` | 补记你的实机验收结论 |
| `docs/REMAINING-WORK.md` | 登记待复测项与 DEV-06 计划内容 |

提交：

```text
753681c fix(orders): open the linked order and let new orders choose a template
```

后端、schema、命令、依赖 **零改动**。

---

## 6. 自动化测试结果

```text
cargo test                → 261 passed / 0 failed（27 个测试二进制 + doc-tests 0）
cargo check --all-targets → 通过，0 warning
npm run test              → 84 passed / 0 failed（12 个文件）
npx tsc --noEmit          → 通过
npm run build             → ✓ built in 89ms（dist/assets/index-BqXRnCPW.js 393.24 kB）
```

前端 75 → **84**（新增 4 + 5，另把 3 个既有测试文件的 mock 补齐以便页面新依赖可跑）。

真实启动（`npm run tauri dev`）：

```text
[minidesk] env ready path=/Users/rinto/Library/Application Support/dev.artflow.minidesk
           generation=gen-c00a879220964299af7adcef8b9fc1c5 schema=v3 first_run=false tz=Asia/Shanghai
```

进程存活、正式代际与 schema 未变、`state/.write.lock` 被该进程持有。

**窗口是否真的画出来了、路由点击是否真的生效：NOT VERIFIED。**
`osascript` 返回「不允许辅助访问 (-1728)」，`screencapture -l` 也无法取窗口，
我只能证明进程启动成功并进入 setup 之后的正常状态，不能证明像素。

---

## 7. 回归核对（本轮重点项）

| 项目 | 证据 |
|---|---|
| 本月完成次数仍按事件计数 | `stats.rs` 18 个用例全通过，未改口径代码 |
| 同一订单重复完成计两次 | `event_counts_follow_events_not_status` 通过 |
| 工作台与统计页区间一致 | 共用 `domain/timezone.rs` + `month_bounds_utc`，本轮未动 |
| 订单筛选、拖拽排序仍正常 | `OrdersPage.drag.test.tsx` 6 用例通过 |
| CSV 内容 / 隐私排除 / 防注入 | `export_csv.rs` 11 用例通过 |
| DEV-04 图片查看器与模态栈 | 未触碰 `modalStack` / `ImageViewer`；`TemplatesPage.delete` 9 用例仍通过 |
| 新订单默认模板逻辑 | 新增 5 个用例覆盖（含空列表回落 `null`） |

---

## 8. 你的真实数据隔离结果

做事前后各取一次指纹，**完全一致**：

| 项 | 修复前 | 修复后 |
|---|---|---|
| 活动代际 | `gen-c00a879220964299af7adcef8b9fc1c5` | 同 |
| 代际数量 | 3 | 3 |
| schema | v3 | v3 |
| 订单 | 4 | 4 |
| 客户 | 1 | 1 |
| 模板 | 2 | 2 |
| 附件 | 2 | 2 |
| 生命周期事件 | 23 | 23 |
| 其中 `completed` 事件 | 4 | 4 |

- 你为专项测试建的订单与两次完成事件 **原样保留**，我没有读取内容以外的任何写操作。
- 本轮没有清空、重置、重建数据目录，没有新代际，没有 schema 迁移。
- 旧 ArtFlowDesk Web 工程、TV-01/TV-03 实验工程与数据库：未触碰。
- 所有新增测试运行在 `tempfile` 临时目录与 jsdom 中。

---

## 9. 需要你实机复测的项目

| # | 项目 | 怎么验 | 期望 |
|---|---|---|---|
| 1 | **S3 下钻**（唯一未关闭项） | 工作台点「本月完成次数」→ 完成事件明细 → 点某条的「查看订单」 | 详情标题 = 该事件对应订单，不是队列第一张 |
| 2 | S3 同订单第二次完成 | 同上，点同一订单的另一条事件 | 仍打开同一张订单 |
| 3 | S3 反例 | 手动把地址改成 `.../orders?orderId=not-exist` | 显示「订单不存在」，不显示别的订单 |
| 4 | 新建订单模板下拉 | 订单页点「新建」，**只看不提交**，然后「取消」 | 看到「制作流程」下拉，默认项带「· 默认」，不写任何数据 |
| 5 | 模板切换生效（可选） | 若你愿意建一张试验单：选非默认模板创建 | 新订单的阶段数/阶段名与所选模板一致 |

第 4 项特意设计成"只看不提交"，因为订单永久删除要到 DEV-07-PRE 才有，
我不想让你为了验证 UI 而多出一张删不掉的单。

---

## 10. DEV-06 边界（仅登记，本轮不实现）

DEV-06 原计划内容已写入 `docs/REMAINING-WORK.md`，包括：

1. 主题系统（含对比度警告、恢复默认、主题损坏回退）。
2. 轻量时间轴。
3. 窗口关闭时的草稿保护。
4. 快捷键与键盘操作。
5. 侧边栏（含折叠）与视觉交互打磨。
6. 统计图表数值可读性优化（当前柱子只有 `title` 提示，没有刻度与数值标签）。

本轮**没有**实现其中任何一项，也没有顺手改样式。DEV-05-FIX 到此停止。
