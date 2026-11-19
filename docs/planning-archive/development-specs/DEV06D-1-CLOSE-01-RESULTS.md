# DEV-06D-1-CLOSE-01 实施报告

**范围：** 全局滚动条右侧空隙（任务 A）、订单详情阶段操作入口整合（任务 B）、阶段变更真实写入验证（任务 C）、针对性回归与交付（任务 D）。

**状态：** `DEV-06D-1 = OPEN / PARTIALLY ACCEPTED`（等 CLOSE-QA 实机验收）。

**未改动：** HEAD-NEW 页头、扁平看板、模板×阶段筛选、极简卡片、四列自适应表格、三视图切换、全局主题、聚焦模式（保持已删除）、HTML5 拖拽（保持已删除）。未新增迁移，未改 identifier、编号规则、生命周期语义、CSV 协议，未推送远程。

---

## 1. 任务 A：滚动条右侧空隙

### 1.1 实测（Blink 无头 Chrome，900×800 CSS px）

| 指标 | 修复前 | 修复后 |
|---|---|---|
| `window.innerWidth` | 900 | 900 |
| `.shell` 宽度 | 885 | 900 |
| `.main` 右边界 | 885 | 900 |
| **滚动节点右缘到窗口右边** | **15px** | **0px** |
| `html` 的 `scrollbar-gutter` | `stable` | `auto` |
| `.main` 的 `scrollbar-gutter` | `stable` | `stable` |
| `.main` 的 `padding-right` | 34px | 0px（留白移到 `.main-inner`） |
| `.main` 装饰性滚动条宽度 | 15px | 15px |
| 面板右缘 inset（留白，不是空隙） | 49px | 49px |

1400×800 修复后：`.shell` 1400，`.main` 右缘 1400，`rightGapToWindow = 0`，面板 inset 49px。

### 1.2 结论与两处改动

1. **根因一（已实测）：** `html` 上保留了 `scrollbar-gutter: stable`。根节点实际不滚动（`body { overflow: hidden }`），这条规则只在窗口右侧预留 15px，永远不会被滚动条覆盖 —— 这就是用户看到的浅色带。`.shell` 因此只有 885px 宽。删除 `html` 的槽位后 `rightGapToWindow` 从 15 → 0。
2. **根因二（结构性）：** 主滚动视口自己承担 34px 横向 padding。按任务要求改为「滚动视口负责滚动、内部容器负责留白」：`.main` 改为 `padding: 28px 0 40px`，新增 `.main-inner { padding-inline: 34px }`，`container-type: inline-size` 一并移到 `.main-inner`（否则容器查询阈值会整体偏 68px）。

未使用负 margin、绝对定位或覆盖层；未定制滚动条颜色/宽度。

### 1.3 限制

Blink 在 macOS 上用覆盖式滚动条，与 WKWebView 的原生滚动条像素表现不同。**Mac 原生滚动条位置 = NOT RUN**，必须由 CLOSE-QA 实机确认。

---

## 2. 任务 B：阶段操作入口整合

### 2.1 变更

- 详情按钮组由 8 个降为 6 个：删除「调整阶段…」与「返工一步」，保留唯一的「推进阶段…」。
- 面板（复用已通过 QA-05 的 `ConfirmDialog`，单层、无嵌套）：
  - 「推进」组：下一阶段一行，默认选中，标注「下一阶段」；已有最后阶段时显示「已在最后一个阶段，没有可推进的下一阶段；请用「完成」结束订单。」
  - 「返工」组：所有更早阶段，逐行标注「返工」或阻塞原因；已在第一阶段时显示「已在第一阶段，没有可返工的目标。」
  - 底部说明：「一次只推进一个阶段；确认后只写入一次合法领域动作，取消不改动任何数据。」
  - 确认按钮文案随选择变化：「确认推进」/「确认返工」。
- 入口禁用条件只用「有没有路可走」判断（`stageEntryBlockedReason`），**不用「还能不能推进」**：最后一个阶段仍可打开面板返工。三种禁用原因写进 `title`：终态、未开工、当前没有阶段。
- 「开始制作」改为仅在实际可用时才是 primary，避免与「推进阶段…」并排两个高亮。
- 受控越级：本轮不实现、不显示不可用入口、不改事件枚举/schema/CSV。

### 2.2 特殊状态覆盖

| 状态 | 行为 |
|---|---|
| 未开工 | 入口禁用，原因「订单尚未开工，不能推进或返工」 |
| 已开工 / 中间阶段 | 推进 + 更早阶段返工均可用 |
| 最后制作阶段 | 入口可用，无推进项，仅返工 |
| 已完成 / 已取消 | 入口禁用，原因「已完成或已取消的订单不能推进或返工」 |
| Revision 冲突 | 走既有 `applyStageMove` 的冲突分支：刷新列表与详情并提示，无部分写入 |
| 完成 / 取消 | 仍为独立按钮与独立确认，不进入阶段面板 |

---

## 3. 任务 C：阶段真实写入（领域层，独立临时库）

新文件 `src-tauri/tests/stage_write_e2e.rs`，每个用例用 `tempfile` 新建空环境；断言直接查 `orders` / `order_events` / `order_stages`，并用新连接重读。

| 用例 | 断言要点 | 结果 |
|---|---|---|
| `advance_writes_one_stage_one_event_and_one_revision` | 阶段 +1；`revision` +1；DB 行同步；事件恰好 +1 且为 `stage_advanced`/`forward`，前后阶段 ID 正确；无多余推进事件；`order_stages` 行数不变；新连接重读一致 | PASS |
| `rework_to_earlier_stage_keeps_history_and_is_persisted` | 跨两级返工到第 1 阶段；`revision` +1；历史前缀不变；新事件 `stage_reworked`/`backward`/注记「多阶段返工」；阶段表不变；重读一致 | PASS |
| `rejected_moves_leave_no_partial_write` | 未开工推进/返工拒绝；越级返工拒绝；跨模板目标拒绝；旧 revision 冲突 `CONFLICT`；最后阶段不能再推进；完成后推进与返工均拒绝 —— 每步后 `revision`/阶段/事件数不变 | PASS |
| `advance_follows_the_orders_own_template` | 自定义三步模板建单，推进落在「线稿」，事件序列 `created/work_started/stage_advanced` | PASS |

命令：`cargo test --test stage_write_e2e --test lifecycle`
结果：`4 passed` + `23 passed`（既有生命周期套件未回归）。

### 3.1 取消

「打开面板后取消、零写入」是 UI 行为，由前端测试 `OrdersPage.stageOps.test.tsx` 覆盖（`calls.length === 0`，对话框关闭）。领域层无对应命令，不虚构。

---

## 4. 自动化结果

| 项目 | 结果 |
|---|---|
| `npx tsc --noEmit` | 通过（无输出） |
| `npm run build` | `✓ built in 115ms` |
| `npx vitest run` | **362 passed / 41 files** |
| `npm run layout:check` | **27/27 通过** |
| `cargo test --test stage_write_e2e --test lifecycle` | 4 + 23 passed |

新增前端测试 8 项（`OrdersPage.stageOps.test.tsx`）：入口唯一、默认选中下一阶段并只调一次推进、返工带目标阶段、取消零写入、最后阶段仍可返工、未开工禁用、终态禁用、超长阶段名不溢出。

### 4.1 断言数量说明

`layout:check` 仍是 **27** 项（不是任务书里写的 29）。本轮新断言写在既有 9 条「路由×宽度」记录内部（滚动几何），未新增 `record()`，所以总数不变。上一轮 UX-05 Phase B 记录过 29 → 27 的减少，本轮未再变动。

`styles.layout.test.ts` 25 项（新增 1 项「滚动视口不承担横向留白」），断言点从 `.main` 改为 `.main-inner`。

---

## 5. 截图清单（Blink，非 WKWebView）

| 文件 | 页面 | 主题 | 宽度 | 前后 | 来源 |
|---|---|---|---|---|---|
| `01-订单卡片-900.png` | 订单·卡片 | 浅色 | 900 | 修改后 | 真实应用 + 假 IPC 夹具 |
| `02-右缘-900-修复后.png` | 订单·卡片右缘特写 | 浅色 | 900 | 修改后 | 同上 |
| `03-右缘-900-修复前复现.png` | 同上 | 浅色 | 900 | **复现**（运行时把 `html` 槽位加回，不是历史截图） | 同上 |
| `04-阶段面板-900.png` | 订单·详情「推进阶段…」面板 | 浅色 | 900 | 修改后 | 同上 |

深色主题：本轮未产出可用截图（`PROBE_DARK` 早前已证实不生效），深色一致性仅由 CSS 变量与既有测试守卫，**未做像素验收**。

---

## 6. 未完成事项与风险

1. **Mac 实机未验收**：滚动条贴边、面板渲染、真实提交都只有 Blink/jsdom 证据。
2. **Mac UI 真实提交 = NOT RUN**：没有建立可丢弃的独立 UI 测试环境，因此未在 UI 里点下「确认推进」。领域层写入已单独验证，不能替代实机操作。
3. **面板「返工」组无截图**：尝试从列表切到多阶段订单失败（点击行未切换选中），该截图放弃，只保留单元测试证据。
4. **原生滚动条像素差异**：Blink 覆盖式滚动条与 WKWebView 原生滚动条不同，需实机确认。
5. **`.main-inner` 是新增 DOM 层级**：容器查询已随之迁移，27 项几何检查通过；但它改动了所有页面的内容容器，属于本轮唯一的结构性风险。
6. 受控越级（`stage_skipped`）仍未实现，按裁定等本收尾轮之后单独进行。
7. 正式库本轮未打开，schema 仍为 v3；用户 QA 数据未触碰。

---

## 7. 提交

见交付说明中的 commit hash（代码与文档分两次提交）。
