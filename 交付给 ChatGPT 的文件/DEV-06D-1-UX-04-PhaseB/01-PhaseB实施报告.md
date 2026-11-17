# ArtFlow Desk Core — DEV-06D-1-UX-04 Phase B 实施报告

- 日期：2026-11-18
- 状态：`DEV-06D-1` = **OPEN / PARTIALLY ACCEPTED**（等 QA-03 实机）
- 自动化：vitest **358 passed / 40 files**；`tsc` 通过；`layout:check` **29/29**；`build` **通过**（106ms，仅 INEFFECTIVE_DYNAMIC_IMPORT 警告，为既有 Tauri API 动态导入提示）
- Rust `cargo check` 通过（未改领域逻辑，仅偏好白名单）

## 1. 头部 = HEAD-B+

- 一级固定：标题 + 数量 ｜ 视图切换 ｜ 新建（主按钮，保留）。
- 二级：搜索框（`flex: 1 1 240px`，上限受列宽约束，不再独占整行）+ 来源下拉 + 状态胶囊 + 密度 + 导出（次级靠右）。
- **没有生效筛选时不空占一行**：状态/来源提示只在生效时出现（`filter-note` 条件渲染），清除按钮随之出现。
- 未采用 HEAD-A 的"与 UI-03 几乎相同"的分层，也未直接复制 B 原型的"搜索独占整行"。

## 2. 看板总览：真正的自适应混合（修正 BOARD-A 的偏差）

上一轮 BOARD-A 原型实际是"两列阶段网格"，与描述不符；本轮实现纠正：

- **窄容器（实测 < 1000px）**：`.board-overview` 为纵向 flex，**每个阶段占完整横向区域**，卡片在该区域内部用 `grid-template-columns: repeat(auto-fill, minmax(200px, 1fr))` 排列 → 900px 下 2 列卡片、530px 下 1 列。
- **宽容器（≥ 1000px）**：`.board-overview-wide` 为 `repeat(auto-fill, minmax(240px, 1fr))` 的阶段网格，**保留 240px 最小列宽**，不够就换行。
- 两种都是**纵向滚动**，总览内无横向滚动（断言校验 `scrollW ≤ clientW + 2`）。
- 总览不切片：全部阶段 × 全部筛选后订单都在 DOM 里；终态订单进「已结束（N）」独立分区，不算阶段列。

## 3. 总览 / 聚焦双模式

- 子模式切换在**看板内容区顶部**（`.board-modes`），不与全局三视图混淆。
- 偏好键 `board_mode`（overview/focus）已加入 Rust 白名单与值域校验，**未新增数据库迁移**（settings 是 key/value 表）。
- 聚焦模式保留阶段导航，修复双向切换（见 04）。

## 4. 卡片重设计

- 标题 **两行**（`-webkit-line-clamp: 2`）并保留 Tooltip 全文。
- 层级：标题 → 客户/金额（左右）→ 交付日/风险标签（左右）→ 操作（`→ 下一阶段` + `阶段操作`）。
- 风险与状态标签 `white-space: nowrap` + `flex: 0 0 auto` + `word-break: keep-all`，**不内部断字**；放不下时整组换行。
- 「阶段操作」按钮 `flex: 0 0 auto`，不再被压成「阶…」（截图发现并修复）。
- 未靠放大卡片掩盖溢出：高度由内容决定，标题截断在卡片内完成。

## 5. 其余修复

- 底部留白改为滚动内容内的 `::after` 空隙（`.board-cards` / `.table-scroll` / `.order-rows` 各 22px）。
- 滚动条内缩：抽屉改为 `padding-right: 8px` + 子元素 `margin-right: 12px`，留白由内容层负责、滚动条贴近视口边缘；`.main` 保留 `scrollbar-gutter: stable`（否则页头宽度在 585/570 之间跳，几何断言会失败）。
- 显式阶段操作已用测试固化：菜单项要么是合法单步动作、要么禁用并给原因；点确认前 `onApply` 不被调用。

## 6. 未完成 / 需实机确认

1. **无头夹具中默认落在「聚焦」**（探针读数 `board.mode = 聚焦`），代码默认是 `overview`，未定位夹具原因；**首次进入是否为总览需 QA-03 确认**（与 UI-02 的 table 默认问题同类）。
2. **深色截图未生效**：`PROBE_DARK=1` 本轮未得到暗色画面（`themeBg = None`），深色下看板/卡片/标签对比度**未验证**。
3. 底部留白只做了 CSS + 结构改动，**未逐张截图核对滚到底的观感**。
4. 表格仍为 UI-03 的四列自适应，本轮未再改。
5. 空阶段「暂无订单」占位、已结束分区在窄窗下的密度，未单独截图评审。

## 7. 数据安全

正式库未打开、未迁移（仍 v3）；未改 identifier / 高水位 / 生命周期模型；QA 未重建；未推送远程；DOCK-01 仍 OPEN/P1。
