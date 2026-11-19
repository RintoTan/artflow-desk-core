# DEV-03-FIX 结果报告

- 日期：2026-11-17
- 工程：`/Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk`
- 范围：仅修复 DEV03-UI-01（拖拽排序）与 DEV03-UI-02（模板删除确认），外加一处同源缺陷
- 结论：两项缺陷的根因已定位并修复，**新增 15 个前端用例**；拖拽的真实鼠标行为**仍需用户实机确认**（我没有点击权限）

---

## 1. 两项缺陷的实际根因

### 1.1 DEV03-UI-01：鼠标拖拽不能改变队列顺序

代码事实（修复前 `OrdersPage.tsx:539` 附近）：

```tsx
<li
  draggable={canReorder && busy === false}
  onDragStart={() => setDragIndex(queueIndex)}
  onDragOver={(e) => { if (!canReorder) return; e.preventDefault(); }}
  onDrop={...}
>
  <button className="order-row" onClick={...}>…</button>
</li>
```

查到 **三个各自独立就足以让拖拽失败** 的问题：

| # | 问题 | 为什么会失败 |
|---|---|---|
| 1 | `draggable` 在 `<li>` 上，而整行内容是一个 `<button>` | 在 WebKit 里，mousedown 落在 `<button>` 上时按钮会消费该事件，祖先元素的 `draggable` 不会被启动 → **`dragstart` 从不触发** |
| 2 | `dragstart` 里没有 `dataTransfer.setData(...)` | WebKit/Safari 要求拖拽必须携带数据，否则拒绝开始拖动 |
| 3 | Tauri 窗口的 `dragDropEnabled` 未配置（默认 `true`） | wry 会接管 webview 的原生拖放，HTML5 拖放事件被吞掉（Tauri 文档明确要求关掉它才能用 HTML5 DnD） |

**我必须说清楚的是**：我没有真实鼠标操作权限，无法确认你那次具体卡在哪一步。
但第 1 点是可以从代码确定性推出的（按钮吞掉 mousedown），第 2 点是 WebKit 的硬性要求，
第 3 点是已知的 Tauri 行为。三者任一成立都会表现为"拖了没反应"。

**修复策略：不再依赖 HTML5 拖放。** 改用手柄 + 指针事件：

- 每行左侧新增明确的拖拽手柄 `⠿`（`aria-label="拖动 AF-… 调整队列位置"`）。
- `pointerdown` 开始拖动 → 记录起始位置 → 行进入 `row-dragging` 半透明态。
- 指针划过其它行（`pointerenter`）→ 该行显示虚线高亮 `row-drop-target`，并提示「松开后放到第 N 位」。
- `window` 上监听 `pointerup` / `pointercancel` 收尾：目标位与起点相同 → 不提交；否则调用 `queue_move`。
- 手柄 `touch-action: none` + `user-select: none` + `preventDefault()`，避免拖拽被文本选择干扰。

这样做的理由：完全不依赖 wry 的拖放配置，不依赖 `dataTransfer`，在 WKWebView 里与在浏览器里行为一致，而且可以被自动化测试驱动。

### 1.2 DEV03-UI-02：删除模板没有二次确认

根因：`TemplatesPage` 用的是 `window.confirm(message)`。

在 Tauri 的 WKWebView 中 `window.confirm` **没有实现**，调用会直接返回真值——
所以"确认"这一步被静默跳过，点删除就直接删了。这不是 UI 位置问题，是这条 API 在桌面壳里不可用。

修复：新增应用内 `ConfirmDialog`（复用既有 `.modal-*` 视觉与焦点管理），删除流程改为：

```text
点击「删除模板」→ 打开对话框（无副作用）
  ├─ 取消 / Esc → 关闭，不调用删除命令
  └─ 确认删除 → template_delete { templateId, expectedRevision, replacementDefaultId }
        ├─ 成功 → 关闭 + 刷新列表 + 提示
        └─ 失败 → 保持打开 + 显示原因（不关闭、不提示成功）
```

默认模板的删除在**同一个对话框内**完成替代选择：对话框里出现「请先选择替代的默认模板 *」下拉，
未选择时「确认删除」禁用。

### 1.3 同源缺陷（顺带修复，明确单列）

`OrdersPage` 删除**制作阶段**也用了 `window.confirm`，同样会静默通过。
这是同一类缺陷、且直接影响数据（误删阶段），所以一并换成 `ConfirmDialog`。

这属于缺陷修复，不是新功能；如果你认为超出本轮范围，我可以单独回滚这一处。

---

## 2. 修复涉及的文件与关键行为

| 文件 | 变更 |
|---|---|
| `src/components/ConfirmDialog.tsx` | **新增**。通用确认框：默认焦点在取消、Esc=取消、Tab 焦点陷阱、关闭后焦点归位、`busy` 期间禁用并防重复提交、`error` 内联展示且不关闭 |
| `src/pages/TemplatesPage.tsx` | 删除改为对话框；新增 `deleteTarget / deleteReplacement / deleteBusy / deleteError`；失败保留弹窗；`CONFLICT` 时自动拉取最新模板并刷新目标 |
| `src/pages/OrdersPage.tsx` | ① HTML5 DnD 全量替换为手柄指针拖拽；② 阶段删除改用 `ConfirmDialog`；③ 新增拖拽高亮与「松开后放到第 N 位」提示；④ 筛选到终态时显式说明"拖拽与 ↑↓ 已禁用" |
| `src/styles.css` | `.drag-handle` / `.row-dragging` / `.row-drop-target` / `.drag-hint` |
| `src/pages/TemplatesPage.delete.test.tsx` | **新增** 9 个用例 |
| `src/pages/OrdersPage.drag.test.tsx` | **新增** 6 个用例 |

`src/lib/ordersView.ts` 的 `dropIndex` 保留并继续使用：拖拽收尾时用它挡住"放回原位"与"越界"两种情况，
所以纯函数测试仍然有效。

---

## 3. 新增测试与结果

### 3.1 拖拽（`OrdersPage.drag.test.tsx`，6 个）

1. 每个活动订单都有明确的拖拽手柄
2. 手柄按下 → 划过另一行 → 松开：按目标位置调用 `queue_move`，并重新拉取列表
3. 放回原位不调用 `queue_move`
4. 拖到边界（从第 3 行拖到第 1 行）按正确目标位提交，不越界
5. ↑ / ↓ 仍然可用，且与拖拽走同一条 `queue_move`
6. 筛选到「已完成」时不给手柄，并显示禁用原因

这些用例走的是**真实组件交互链路**：从 `pointerdown` 事件 → 组件状态 → `queueApi.move` 调用 →
`api.listOrders` 刷新，不是只测 `dropIndex` 纯函数。

### 3.2 删除确认（`TemplatesPage.delete.test.tsx`，9 个）

覆盖要求里的 8 条，另加"默认焦点在取消"：

1. 点击删除但未确认时，模板仍在且未调用删除命令
2. 取消不删除
3. Esc 不删除
4. 确认后删除普通模板（且 `replacementDefaultId` 为 null）
5. 删除默认模板未选替代时确认按钮禁用、不调用命令
6. 删除默认模板后列表里恰好一个默认模板
7. 删除失败时对话框不关闭、显示错误、不显示"已删除"
8. 确认期间重复点击只提交一次
9. 默认焦点在取消上

"删除模板不影响既有订单独立流程"这条是后端性质，由既有 Rust 用例
`deleting_a_template_does_not_touch_existing_orders` 与 `editing_a_template_does_not_change_existing_orders` 证明，
本轮未改动该逻辑。

### 3.3 实际执行结果

```text
cargo test        → 194 passed / 0 failed
npm run test      → 40 passed（6 个测试文件）
npx tsc --noEmit  → 通过
npm run build     → built in 88ms
```

前端用例从 25 增至 **40**（+15），Rust 保持 **194** 不变（本轮未改后端）。

---

## 4. 与 DEV-03 原功能的回归关系

用户已验收通过的 5 项都在本轮改动路径上，逐项确认未被破坏：

| 原功能 | 回归方式 | 结果 |
|---|---|---|
| A 队列 ↑ / ↓ 与编号不变 | 新增用例「↑ / ↓ 仍然可用，并与拖拽走同一条命令」；`queue_move` 路径未改 | PASS |
| C 客户关联与改名同步 | 客户页/后端未改动；`cargo test --test clients` 8 例 | PASS |
| D 新默认模板与订单创建 | `cargo test --test templates` 15 例 | PASS |
| F 搜索筛选 | `ordersView.test.ts` 8 例（含"不修改传入数组"） | PASS |
| G 密度持久化 | `preference_set` 未改动 | PASS |
| DEV02-UI-01 未保存弹窗 | `UnsavedChangesDialog.test.tsx` 10 例 + 离页保护 6 例 | PASS |

另外：模板页新增确认框后，其"切换模板"的未保存保护仍走原来的 `UnsavedChangesDialog`，两个模态不会同时打开
（删除框只从「删除模板」按钮打开，且打开时会话不在切换流程中）。

---

## 5. 真实 macOS 启动结果

```text
[minidesk] env ready path=/Users/rinto/Library/Application Support/dev.artflow.minidesk
           generation=gen-e05d7ce65b8d40c0a0d23bedf18476ee schema=v2 first_run=false tz=Asia/Shanghai
窗口（CoreGraphics）: WIN 35781 owner=artflow-minidesk 1120×760 @ (400,103)
```

启动后数据检查：

```text
AF-2026-0002  DEV02-测试订单-B      active  queue 0
AF-2026-0001  DEV02-测试订单-A      active  queue 1
AF-2026-0003  DEV03-模板测试订单     active  queue 2
templates=1  clients=1  generations=2
```

未新增代际、未迁移 schema、未改动任何用户数据。
顺带一个观察：队列位置现在是 0/1/2 连续的——你上一轮点 ↑↓ 时 `queue_move` 已经把历史空洞整理掉了。

---

## 6. 仍需用户点击的项目

**拖拽我没有实机证据，因此不宣称已验收。** 请在 macOS 上确认：

1. 订单页每行左侧有 `⠿` 手柄；按住它拖到另一行上，目标行出现蓝色虚线高亮与「松开后放到第 N 位」。
2. 松开后被拖订单移动到该位置，编号不变；重启应用后顺序保持。
3. 把行拖到自己身上松开 → 顺序不变，不报错。
4. ↑ / ↓ 仍然工作。
5. 模板页点「删除模板」→ 出现「确认删除流程模板？」，默认焦点在「取消」。
6. 按 Esc 或点取消 → 模板仍在。
7. 对**默认模板**点删除 → 对话框里出现替代模板下拉；不选时「确认删除」禁用；选另一个并确认 → 删除成功且仍有且仅一个默认模板。
8. 删除普通模板 → 直接确认即可，不需要选替代。

第 7 项尤其需要你确认，因为这正是原来被 `window.confirm` 静默跳过的那条路径。

---

## 7. 既有数据与旧工程隔离核验

| 对象 | 结果 |
|---|---|
| 正式应用数据 | 3 个订单 / 1 个模板 / 1 个客户全部保留；代际数量 2 未变；schema 仍为 v2 |
| 旧 ArtFlowDesk Web 工程 | 未触碰（未执行任何 git 写操作） |
| TV-01 实验数据库 | 未触碰 |
| TV-03 演示沙箱 | 未触碰 |
| 测试数据 | 全部在 `tempfile` 临时目录与 jsdom 中，不接触真实数据 |

---

## 8. Git 提交记录

```text
58982b5  fix(ui): pointer-handle drag for the activity queue
4e99779  fix(ui): replace window.confirm with an in-app confirm dialog
d5800db  docs: DEV03-FIX results
```

新增用例随对应修复一起提交（拖拽 6 例在 58982b5，删除确认 9 例在 4e99779），
没有单独的测试提交。

未推送远程。未进入 DEV-04。

---

## 9. 用户实机验收结论（2026-11-17）

用户在 macOS 真实桌面应用完成 7 项验证，**全部 PASS**：

| 编号 | 项目 | 结果 |
|---|---|---|
| B1 | 拖拽改变队列顺序 | PASS |
| B2 | 重启后顺序保持 | PASS |
| B3 | 原位拖动无效、上下按钮正常 | PASS |
| E1 | 普通模板删除确认与取消 | PASS |
| E2 | 默认模板删除必须指定替代 | PASS |
| E3 | 删除后默认模板及旧订单流程正确 | PASS |
| S1 | 制作阶段删除确认与取消 | PASS |

**DEV03-UI-01、DEV03-UI-02 及同源的制作阶段删除确认问题全部关闭。**

证据来源说明：

1. 上表结论来自**用户实际操作**，不是我的自动化观察。我本机没有辅助功能与录屏权限，
   无法驱动鼠标或截取窗口。
2. 本报告第 3 节列出的 194 个 Rust 用例与 40 个前端用例，是 DEV-03-FIX 提交时的自动化证据，
   **本轮没有重新运行**，不能算作这次实机验收的证明。
3. 拖拽的指针事件链路此前只有自动化测试覆盖；现在由 B1/B2/B3 补上了真实鼠标证据。
