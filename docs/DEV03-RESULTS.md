# DEV-03 阶段报告：DEV02-UI-01 未保存确认改为模态对话框

- 日期：2026-11-17
- 工程：`/Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk`
- 范围：DEV02-UI-01（未保存确认模态）+ DEV-03 主体（活动队列、客户档案、流程模板、搜索筛选与列表密度）
- 状态：**DEV02-UI-01 已验收通过（4/4）并关闭**。前端测试 17 个、Rust 测试 160 个是修复当时的自动化证据，本轮未重新运行。

---

## 1. 问题

DEV-02 的未保存提示渲染在页面内容流里（订单详情下方），有三个实际缺陷：

1. **不醒目**：出现在页面底部，长页面需要滚动才能看到，用户容易以为"什么都没发生"。
2. **不是模态**：提示出现时背后的表单、列表仍可继续操作，用户可以绕过它改变状态。
3. **焦点未管理**：提示出现时焦点停留在原处，键盘用户不知道需要处理，Tab 会跑到背后的控件。

## 2. 修复内容

### 2.1 新增组件 `src/components/UnsavedChangesDialog.tsx`

- 通过 `createPortal` 渲染到 `document.body`，`position: fixed` 居中，`rgba(16,30,46,0.34)` 遮罩 + 1.5px 背景模糊。
- 语义：`role="alertdialog"`、`aria-modal="true"`、`aria-labelledby` / `aria-describedby`。
- 标题固定为**「有尚未保存的修改」**，正文按场景区分（切换订单 / 新建订单 / 离开订单页面）。
- 三个操作：**保存并离开**（主按钮）、**放弃修改**（危险色）、**继续编辑**。

### 2.2 八项要求逐条落实

| 要求 | 实现 | 验证 |
|---|---|---|
| 1. 明确标题 | 标题常量「有尚未保存的修改」 | `显示标题与三种操作` |
| 2. 居中 + 遮罩 | `.modal-overlay` fixed inset 0 + grid 居中 + 半透明遮罩 | `以模态方式呈现，并带背景遮罩` |
| 3. 三种操作 | 三个按钮，语义与 DEV-02 一致 | `点击「放弃修改」只触发一次` 等 |
| 4. 默认聚焦继续编辑，Esc 不丢草稿 | 打开时 rAF 聚焦；Esc 监听挂在 `document` 捕获阶段，任何焦点位置都生效 | `默认聚焦「继续编辑」`、`按 Esc 等同「继续编辑」`、`Esc 不会离开页面，也不会丢草稿` |
| 5. 保存失败保留草稿并提示 | 保存失败时对话框不关闭，`error` 以 `role="alert"` 显示，草稿留在表单 | `保存失败时保持打开、显示错误` |
| 6. 阻止确认期间重复导航 | 父组件 `guardBusy` + 组件内部 `inFlightRef` 双重闸门，`busy` 时三个按钮全部禁用 | `处理中禁用全部操作`、`连续点击只触发一次` |
| 7. 键盘操作与焦点恢复 | Tab / Shift+Tab 在对话框内循环；关闭后焦点回到打开前的元素 | `Tab 不会把焦点移出对话框`、`关闭后焦点回到打开前的元素` |
| 8. 针对性测试 | 新增 vitest + Testing Library，17 个用例（10 组件 + 6 集成 + 1 冒烟） | `npm run test` |

### 2.3 订单页接线（`src/pages/OrdersPage.tsx`）

原先有两套守卫：路由级 `useBlocker` 一套、切换订单一套，各自渲染一个 `SwitchGuard`。
现在合并为**单一数据源**：

```tsx
const routeBlocked = blocker.state === "blocked";
const dialogOpen = routeBlocked || manualNav !== null;
const pendingNav = manualNav ?? (routeBlocked ? { kind: "route" } : null);
```

- 路由被拦下时，对话框"就是打开状态"，不再额外用一个 `useEffect` 把 blocker 状态复制到本地 state。
  这是本轮踩到的真实缺陷：早先的写法在 `reset()` 与 `setState` 之间有渲染时序竞争，
  偶发让对话框关掉后又立刻重新弹出（测试里表现为"点了继续编辑但对话框还在"）。
- 改由单一派生状态后，关闭只可能通过 `proceed()` / `reset()` 发生，不存在"本地已关但 blocker 仍阻塞"的中间态。

`saveDraft()` 的返回类型从 `boolean` 改成 `string | null`（错误文案或成功），
使对话框能直接展示保存失败原因，而不用再猜 `draftError` 的时序。

## 3. 测试

### 3.1 新增测试基建

`vitest 4.1.12` + `jsdom` + `@testing-library/react` + `user-event` + `jest-dom`，
配置见 `vitest.config.ts`，入口 `src/test/setup.ts`。`npm run test` 即可运行。

安装时 `npm i -D vitest` 报 `Cannot read properties of null (reading 'edgesOut')`（vite 8 与 vitest 的
peer 解析冲突），改用 `--legacy-peer-deps` 安装成功，运行时无异常。

### 3.2 用例清单（17 个）

`src/components/UnsavedChangesDialog.test.tsx`（10）

1. 显示标题与三种操作，默认聚焦「继续编辑」
2. 以模态方式呈现，并带背景遮罩
3. 按 Esc 等同「继续编辑」，不会丢弃草稿
4. 点击「放弃修改」只触发一次
5. 保存失败时保持打开、显示错误，且草稿未被丢弃
6. 处理中禁用全部操作，避免重复导航
7. 连续点击「保存并离开」只触发一次
8. Tab 不会把焦点移出对话框
9. 关闭后焦点回到打开前的元素
10. 关闭时不渲染任何内容

`src/pages/OrdersPage.guard.test.tsx`（6，真实 `createMemoryRouter` + mock 后的 Tauri bridge）

1. 有未保存修改时导航会弹出模态确认，而不是直接离开
2. 「继续编辑」关闭对话框并留在原地，草稿仍在
3. Esc 不会离开页面，也不会丢草稿
4. 「放弃修改」才真正离开
5. 「保存并离开」先保存再跳转
6. 没有修改时导航不弹对话框

第 8 条要求"避免修改后破坏既有离页保护"由第 2 组覆盖：这 6 个用例走的是
真实的 `useBlocker` + 路由切换路径，不是对组件的孤立调用。

### 3.3 实际执行结果

```text
npm run test     → Test Files 3 passed (3)，Tests 17 passed (17)
npx tsc --noEmit → 通过（exit 0）
npm run build    → 345.00 kB / gzip 107.91 kB，88 ms
cargo test       → 160 passed / 0 failed（Rust 侧本轮无改动）
```

真实应用启动（macOS）：

```text
[minidesk] env ready … generation=gen-e05d7ce65b8d40c0a0d23bedf18476ee schema=v2 tz=Asia/Shanghai
窗口：WIN 35501 owner=artflow-minidesk 1120×760 @ (400,103)
```

## 4. 未覆盖 / 明确不属于本轮

1. **桌面窗口关闭保护仍未实现**（`useBeforeUnload` / 关闭确认属 DEV-06）。
   现在关窗仍会丢草稿——本轮的对话框只覆盖应用内导航与订单切换，**这一点没有改善**。
2. **我没有做人工点击验证。** 本机 `osascript` 返回"不允许辅助访问 (-1719)"，
   `screencapture -l` 返回 "could not create image from window"（无录屏权限）。
   因此模态框的实际观感（遮罩浓淡、动画、真实输入法下的键盘行为）需要用户看一眼。
3. 焦点陷阱只处理 Tab / Shift+Tab 首尾环绕，未实现 `inert` 背景隔离；
   `aria-hidden` 未应用到背景内容（部分读屏器仍可能读到背景）。
   作为 DEV-02 遗留项记录，正式无障碍审查留给后续。
4. 遮罩点击不关闭对话框（有意设计，避免误触丢弃草稿）。

## 4.5 验收结论（用户实机操作）

2026-11-17，用户在 macOS 实机完成 4 项验证，**全部通过**：

| # | 验证项 | 结果 |
|---|---|---|
| 1 | 弹窗居中显示，背景遮罩正常 | PASS |
| 2 | 弹窗打开后按 Enter 安全返回编辑并保留草稿 | PASS |
| 3 | 按 Esc 关闭弹窗并保留草稿 | PASS |
| 4 | 连续 Tab 焦点始终限制在弹窗内部 | PASS |

**DEV02-UI-01 正式关闭。**

三点必须说清楚：

1. 该结论来自**用户实际操作**，不是我的自动化观察。我本机没有辅助功能与录屏权限，无法点击或截图。
2. 第 1 节列出的 17 个前端用例与 160 个 Rust 用例是修复提交时的自动化证据，
   **本轮没有重新运行**，不能算作这次验收的证明。
3. Enter 行为经用户确认可用：默认焦点在「继续编辑」，回车即安全返回。
   这条没有专门的自动化断言，现在的证据只有用户操作。

## 5. 需要用户确认

请在有未保存修改时切换订单或点导航，确认：

1. 对话框是否居中、遮罩是否合适；
2. 打开时焦点是否在「继续编辑」上（直接按回车应无任何事发生）；
3. 按 Esc 是否关闭并保留草稿；
4. Tab 是否始终在三个按钮之间循环。

若观感需要调整（例如遮罩更淡、按钮顺序、标题字号），说明即可，改动只在 CSS 与文案。

## 6. Git

```text
docs: DEV-02 manual acceptance update (D02-19/20 → PASS)
test(ui): add vitest + testing-library and unsaved-dialog coverage
feat(ui): replace inline unsaved guard with a centered modal dialog
docs: DEV-03 report for DEV02-UI-01
```

未推送远程。DEV-03 的队列、客户、模板功能未开始。

---

# 第二部分：DEV-03 主体开发

## 7. 执行摘要

四项 DEV-03 功能全部落地，**Rust 194 / 前端 25 个测试全部通过**。
**本轮没有修改数据库结构**，因此没有触发代际迁移——用户的两份实机测试订单原样保留。

| 功能 | 状态 |
|---|---|
| 活动队列：插入位置、拖拽、上下移、`queue_revision` 冲突保护 | 已实现 |
| 客户档案：新建、编辑、改名、关联订单历史 | 已实现 |
| 全局流程模板：新建、编辑、复制、删除、设默认、1–20 阶段 | 已实现 |
| 订单搜索、状态筛选、列表密度模式 | 已实现 |
| 拖拽排序的人工操作验证 | **未验证**（见第 12 节） |

## 8. 数据保护

**没有 schema 变更。** DEV-03 需要的全部结构在 v1/v2 就已存在：

| 需求 | 既有结构 |
|---|---|
| 客户 | `clients`（v1） |
| 模板与阶段 | `stage_templates` / `stage_template_steps`（v1） |
| 队列版本 | `queue_state`（v2） |
| 列表密度 | `app_settings.list_density`（v1 播种） |
| 搜索筛选 | 纯前端，无需持久化 |

因此本轮**不产生新的 generation，不执行 VACUUM INTO，不切换指针**。

实测（应用真实启动后）：

```text
[minidesk] env ready … generation=gen-e05d7ce65b8d40c0a0d23bedf18476ee schema=v2 first_run=false
generations 数量：2（与 DEV-02 结束时一致，未新增）
订单：AF-2026-0002 / AF-2026-0001，状态与队列位置均未变化
```

这是有意的选择：能在不改结构的前提下实现，就不要动用户的数据目录。

## 9. 活动队列

### 9.1 实现

`domain/queue.rs`：

- `list` / `snapshot`：按 `queue_position` 读活动订单（终态不在队列里）。
- `move_order(input)`：`BEGIN IMMEDIATE` → 校验 `queue_state.revision` → 读出活动 ID 序列 →
  移除并插入到目标位 → 重写 0..n 连续位置 → bump `queue_state.revision`。
- `shift(order_id, delta)`：上移/下移共用实现，落到同一个 `move_order`。
- `insert_new(tx, order_id, position)`：建单时按指定位置插入并整体重排。

### 9.2 关键性质

| 性质 | 保障方式 |
|---|---|
| 排序不改订单版本 | 只 `UPDATE orders SET queue_position`，不动 `revision`；有测试断言 |
| 排序冲突独立 | 只比 `queue_state.revision`，资料编辑不会因此冲突 |
| 位置连续 | 每次变更后整体重写 0..n |
| 越界夹取 | `to_index` 夹到 `[0, len-1]`，不报错也不乱序 |
| 终态订单不在队列 | 查询带 `status = 'active'`；对终态排序返回 `INVALID` |
| 建单插队也受保护 | 指定 `queueInsertPosition` 时必须同时给 `expectedQueueRevision`，否则 `INVALID`/`CONFLICT` |

重新打开订单也改为走 `queue::insert_new`，保证重开后位置连续（上一版是 `MAX+1`，
会在终态订单留下的空洞上继续增长，实测用户数据里就出现了位置 1、2 而 0 空缺）。

### 9.3 测试

`tests/queue.rs` 11 个用例：追加、按索引移动并重排、上移/下移、越界夹取、
过期队列版本冲突、排序不 bump 订单版本、终态离开队列、单元素无操作、
建单插队、建单时队列版本冲突（且不建单）、重开入队尾。

## 10. 客户档案

`domain/clients.rs` + `commands/clients.rs`：

- `create` / `update`：名称 trim、长度限制、空白字段归一为 NULL。
- `update` 用 `revision` 乐观锁；**内容完全一致时不 bump**，避免重试误报冲突。
- `detail`：客户资料 + 关联订单（含当前阶段名）+ 按状态计数。
- 改名后订单显示立刻更新——订单读取 `LEFT JOIN clients` 取最新名称，不做冗余存储。
- 同名客户不合并：由稳定 ID 决定身份，名称只用于显示。

`tests/clients.rs` 8 个用例。

## 11. 全局流程模板

`domain/templates.rs` + `commands/templates.rs`：

| 规则 | 实现 |
|---|---|
| 1–20 个阶段 | `clean_steps` 校验，超出返回 `INVALID` |
| 同模板内不允许重名 | 领域层校验 + `UNIQUE(template_id, title)` 兜底 |
| 阶段稳定 ID | 编辑时按传入 `stepId` 保留，新增才生成 |
| 唯一默认模板 | `is_default` 唯一部分索引 + 事务内先清后设 |
| 删除默认必须先另选 | `replacementDefaultId` 必填，否则 `INVALID` |
| 至少保留一个模板 | `remove` 检查总数 |
| 复制模板 | 复制阶段标题但生成**新** step ID |
| 改模板不追溯订单 | 订单创建时复制阶段；有测试断言订单不受影响 |

顺带修了一个真实缺陷：`create_order` 之前用硬编码常量 `DEFAULT_TEMPLATE_ID` 兜底，
而不是读数据库里 `is_default = 1` 的模板。切换默认模板后新建订单仍用旧模板——已改为查库。

`tests/templates.rs` 15 个用例。

## 12. 搜索、筛选与列表密度

- `src/lib/ordersView.ts`：纯函数 `matchesQuery` / `filterOrders` / `densityClass` / `dropIndex`。
- 搜索匹配标题、编号、客户名，大小写与空白不敏感。
- 状态筛选：全部 / 活动 / 已完成 / 已取消。
- 只影响展示，不修改队列（有测试断言输入数组未被改动）。
- 列表密度 `comfortable` / `compact`，通过 `preference_set("list_density")` 持久化；
  后端只接受这两个值，其他键一律 `DENIED`。

`src/lib/ordersView.test.ts` 8 个用例。

## 13. 测试与实测

```text
cargo test        → 194 passed / 0 failed
npm run test      → 25 passed（4 个测试文件）
npx tsc --noEmit  → 通过
npm run build     → 362.87 kB / gzip 111.42 kB
```

| 套件 | 用例 |
|---|---|
| schema / migrations / numbering / timezone / lock / environment / media / zip_safety | 15 / 10 / 15 / 9 / 10 / 10 / 8 / 11 |
| commands（33 项白名单） | 10 |
| order_create / order_details / lifecycle / workflow_edit / idempotency | 11 / 7 / 23 / 13 / 8 |
| **queue / clients / templates（本轮新增）** | **11 / 8 / 15** |
| 前端：对话框 / 离页保护 / 视图逻辑 / 冒烟 | 10 / 6 / 8 / 1 |

命令白名单从 20 项扩到 **33 项**，新增 13 项全部逐条登记并通过负向测试。

## 14. 未实现 / 未验证

1. **拖拽排序我没有实测过。** 没有辅助功能与录屏权限，无法真的拖。
   逻辑有 `dropIndex` 单测与 `queue_move` 集成测试，但"鼠标能不能拖起来"需要你确认。
   上移/下移按钮走的是同一条 `queue_move` 路径，键盘可用。
2. **整个新 UI 我没有点击验证**（客户页、模板页、搜索框、密度切换、列表拖拽）。
3. 队列位置存在历史空洞（用户数据里是 1、2，缺 0）。不影响功能，
   下一次重排会自动整理为 0..n；我没有在启动时做隐式修复。
4. 客户**不支持删除**（规格未要求；删除会牵扯订单关联语义，留给后续决策）。
5. 模板改名不校验全局重名（规格只要求同模板内阶段名唯一）。
6. 搜索与筛选是会话内状态，不持久化（符合 D-00-18）。
7. 列表密度只持久化在后端，前端首次读取失败会回退 `comfortable` 且不提示。
8. 桌面窗口关闭保护仍未实现（DEV-06）。

## 15. 需要用户验证（约 3 分钟）

1. **队列**：订单页有两张活动订单时，点某一行的 ↑ 或 ↓，确认顺序变化、编号不变；
   再试着把一行拖到另一行上，确认顺序按拖放位置变化。
2. **客户**：客户页新建一位客户 → 改名 → 回到订单页，确认关联订单显示新名字。
3. **模板**：模板页新建一个 2 阶段模板 → 设为默认 → 回订单页新建订单，
   确认新订单用的是这个 2 阶段流程；再删除默认模板，确认提示需要另选。
4. **搜索/密度**：搜索框输入编号片段，确认只剩匹配项；点右上「舒适/紧凑」，
   重启应用确认密度被记住。

## 16. Git

本轮提交（计划）：

```text
feat(domain): activity queue with insert position, drag reorder and queue revision
feat(domain): client profiles with revision-guarded edits and order history
feat(domain): global stage templates with unique default and safe deletion
feat(commands): queue, client, template and preference surfaces (33 total)
feat(ui): search, status filter, density switch and queue reordering
test: queue, clients and templates coverage (34 new cases)
docs: DEV-03 results
```

未推送远程。未进入 DEV-04。
