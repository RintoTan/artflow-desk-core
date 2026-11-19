# DEV-06B-FINAL-FIX 结果报告

- 日期：2026-11-17
- 范围：窄窗口真实布局、UI-01～UI-05 统一、主题回归
- 状态：**布局根因已用真实排版引擎定位并修复，九种组合实测通过**；
  像素观感仍 **NOT VERIFIED**，等你截图

---

## 1. 上一轮的响应式修复为什么在实机无效

上一轮我只验证了"规则存在"（CSS 文本断言），没有验证"规则生效后的几何"。

真实原因是：**容器查询确实生效了，单栏也切换了，但网格第一行只按 40px 排。**

`.orders-list` 是 `overflow: hidden` 的弹性滚动容器。这种元素对网格轨道的
**内在高度贡献只有它不滚动的那部分**（表头 40px），而 `.orders-layout` 又是
`align-items: start`（不拉伸）。于是：

- 轨道（row）按 40px 计算；
- 元素本身按 `max-height` 画成 320px；
- 下一行的详情从 `40 + 14 = 54px` 处开始 —— 落在列表内部，形成重叠。

我上轮写的 `position: static` 与 `max-height` 只解决了"粘性定位"，没有解决"轨道塌陷"。

---

## 2. 实际计算布局证据

工具：`scripts/layout-probe.mjs` —— 无头 Chrome（Blink）打开真实 Vite 页面，
注入 Tauri IPC 假数据，读取计算样式与 `getBoundingClientRect()`。

### 2.1 修复前，900px 订单页

```text
grid-template-columns: 593px          ← 单栏已生效
grid-template-rows: 40px 1454.19px    ← 第一行只有 40px
.orders-list  y=95  h=320  bottom=415 position: static
.orders-detail y=149 h=1454           ← 从列表内部开始
重叠面积: 266px（纵向）
```

### 2.2 对照实验（同页面，只改一条属性）

| 改动 | 轨道 | 列表 | 详情顶 | 纵向重叠 |
|---|---|---|---|---|
| 现状 | `40px 1454px` | 95→415 | 149 | **266px** |
| `align-items: stretch` | 40px | 被压成 40px | 149 | 0（但列表没了） |
| 列表 `overflow: visible` | `320px` | 95→415 | 429 | 0 |
| 去掉 `max-height` | 40px | 95→545 | 149 | 396（更糟） |

`overflow: visible` 一行就让轨道变成 320px —— 确认根因是"滚动容器的内在高度贡献"，
不是容器查询没命中，也不是 specificity。

---

## 3. 最终修复

```css
@container workspace (max-width: 780px) {
  .orders-layout {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto;   /* 显式两行，避免沿用两栏时的轨道定义 */
    align-items: stretch;            /* 不让 start 把轨道尺寸交给内在贡献 */
  }
  .orders-list {
    position: static;
    height: 42vh;                    /* 确定高度：轨道按它排，元素也按它画 */
    max-height: 42vh;
    min-height: 220px;
  }
}
```

要点：**既然内在贡献不可靠，就给它一个确定高度**。`@supports` 退化路径同样改成
确定高度 + `align-items: stretch`。

断点不变（内容区 780 / 560），因为它们本来就命中正确；错的是命中之后的尺寸来源。

---

## 4. 三个页面的实测结果

`node scripts/layout-check.mjs`（需要先 `npm run dev`）：

```text
PASS /orders    @1400 — 列 320px 751px，列表高 472，详情顶 97
PASS /orders    @900  — 列 585px，列表高 320，详情顶 431
PASS /orders    @530  — 列 415px，列表高 272，详情顶 390
PASS /clients   @1400 — 列 320px 766px，列表高 215，详情顶 97
PASS /clients   @900  — 列 600px，列表高 320，详情顶 431
PASS /clients   @530  — 列 430px，列表高 272，详情顶 390
PASS /templates @1400 — 列 320px 766px，列表高 215，详情顶 97
PASS /templates @900  — 列 585px，列表高 320，详情顶 431
PASS /templates @530  — 列 415px，列表高 272，详情顶 390

九种组合全部通过（无重叠、无横向溢出）
```

判定口径：三页共用 `.orders-layout`，所以同时验证；每项断言三条——
列表与详情矩形不重叠、`documentElement.scrollWidth <= 视口宽`、导航命中高度 ≥ 44。

> 与 WKWebView 的差异：Blink 与 WebKit 在 flex/grid 细节上偶有差别，
> 但"是否单栏 / 是否重叠 / 是否横向溢出"这类结构性结论一致。像素仍需人眼。

---

## 5. UI-01～UI-05 具体改动

### UI-01 视觉对齐

- 侧栏导航改为 `图标盒(24×24) + 图标(20×20) + 10px 间距 + 文字`；
  图标盒固定尺寸，**文字起点不再随图标外形跳动**（齿轮与列表的视觉重心不同）。
- `.nav-item` 统一 `display:flex; align-items:center; min-height:44px`。
- `.nav-label` 单行省略，避免长名称把侧栏撑开。
- 折叠按钮的箭头也放进同一个图标盒，展开/折叠时基线一致。

### UI-02 安全距离与留白

| 位置 | 之前 | 现在 |
|---|---|---|
| `.main` 内边距 | 26 / 30 / 34 | **28 / 34 / 40** |
| `.panel` 内边距 | 18 / 20 / 20 | **20 / 22 / 22** |
| `.field` 上间距 | 14 | **16** |
| 两栏间距 | 14 | 保持（窄屏时由堆叠替代） |

右侧滚动条与卡片之间由 `.main` 的 34px 内边距提供安全距离；这个值是**内边距**不是固定宽度，
所以窄窗口不会被它撑破（实测 530px 下 `pageScrollWidth = 530`）。

### UI-03 折叠按钮降权

改为 ghost：`background: transparent`、`border: 1px solid transparent`、
默认 `--text-faint`；hover 出现 `--neutral-soft` 背景；`:focus-visible` 走强调色描边。
**视觉体积变小，命中区仍是 44px 高**（折叠态最小 44×44）。

### UI-04 控件统一

新增令牌 `--control-h: 34px`、`--control-h-sm: 28px`：

- `.btn`：`min-height: var(--control-h)`、`padding: 0 14px`、统一圆角与 13px 字号，
  新增 `:focus-visible` 描边；
- `.btn-primary / .btn-danger`：文字色分别用 `--accent-contrast` / `--danger-contrast`，
  hover 用 `brightness(0.92)` 不再是写死的深蓝/深红；
- `.field input`：`width: 100%`、`min-width: 0`、`min-height: var(--control-h)`、统一内边距；
- 状态标签、提示条沿用已有 `--chip-*` / `--tone-*` / `--warn-soft` 令牌，未新增颜色。

### UI-05 订单标题溢出与换行

| 位置 | 规则 | 实测 |
|---|---|---|
| 列表 | `-webkit-line-clamp: 2` + `overflow-wrap: anywhere` + `title` 悬停提示 | 长中文标题 `h=36`（两行），`scrollHeight=36`，无溢出 |
| 详情 | `.detail-title` 加 `overflow-wrap: anywhere`、`word-break: break-word`、`min-width:0` | 连续无空格串也能断行 |
| 输入框 | `width:100%`、`min-width:0` | 长标题编辑不再撑破表单 |

标题长度限制（业务规则）未改动，也不截断已保存的真实标题——只在显示层截断。

---

## 6. 深浅主题回归

VIS-01/02/03 的修复仍在位（`--sidebar-bg`、`--tone-*-bg`、`--panel-quiet-bg`、
`--chip-*`、`--danger-contrast`），本轮**没有重写**。

本轮新增的都是尺寸/间距/排版属性，没有引入新的写死浅色背景——
`styles.theme.test.ts` 的"非令牌块不得出现浅色背景"断言继续通过。

---

## 7. 测试与证据等级

```text
npm run test              → 177 passed / 0 failed（24 个文件）
npx tsc --noEmit          → 通过
npm run build             → ✓ built in 102ms
cargo check --all-targets → 通过
cargo test                → 282 passed（Rust 未改，沿用上轮结果）
node scripts/layout-check.mjs → 9/9 PASS（真实排版引擎）
```

新增：

| 文件 | 内容 |
|---|---|
| `scripts/layout-probe.mjs` | 无头 Chrome + Tauri 假数据，输出计算样式与矩形 |
| `scripts/layout-check.mjs` | 九种组合断言：无重叠、无横向溢出、命中高度 |
| `src/styles.layout.test.ts` | 13 条规则守卫（含本轮新增 5 条：控件高度令牌、输入框宽度、标题截断、ghost 按钮、图标盒） |

### 证据等级

| 等级 | 内容 |
|---|---|
| **真实几何 PASS** | 九种组合的矩形、轨道、横向溢出（Blink 实测） |
| **规则 PASS** | CSS 断言 13 条 + 主题 4 条 |
| **功能 PASS** | 177 条组件/集成测试（含关窗、快捷键、KEY-01 滚动、CSV、统计） |
| **NOT VERIFIED** | WKWebView 下的真实像素、观感、滚动条覆盖、系统深浅切换外观 |

---

## 8. 仍需你 Mac 实机确认

1. 900px 订单页：列表与详情不再互相覆盖；
2. 900px 客户页、模板页：同上；
3. 530px：内容仍可操作，无整页横向滚动条；
4. 1400px：恢复左右两栏；
5. 侧栏展开/折叠：图标与文字对齐、点击区域够大、折叠按钮不再抢眼；
6. 全局按钮/输入框/状态标签观感是否一致；
7. 长标题：列表两行截断、详情自然换行、编辑框不溢出；
8. 深色下：侧栏、KPI 卡、提醒说明、状态标签；折叠态也看一眼。

---

## 9. 你的最短操作步骤

```bash
cd /Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk
lsof -ti:1421 | xargs kill -9 2>/dev/null
npm run qa:seeded
```

| 步 | 操作 | 期望 |
|---|---|---|
| 1 | 窗口拖到约 900px，进「订单」 | 列表在上、详情在下；详情第一张卡片不压在列表上 |
| 2 | 切到「客户」「流程模板」 | 同样上下堆叠 |
| 3 | 拖到约 530px | 仍能滚动操作，右侧无横向滚动条 |
| 4 | 拖回 1400px | 自动恢复左右两栏 |
| 5 | 点侧栏底部「折叠」 | 按钮本身很低调；折叠后图标居中、悬停显示名称 |
| 6 | 看新建订单面板的输入框与按钮 | 高度一致、圆角一致、焦点有描边 |
| 7 | 找一张长标题订单（QA 里 AF-2026-0003） | 列表两行后省略，悬停可见全名；详情完整换行 |
| 8 | 设置里切深色，重复 1–2 和 5 | 深色下侧栏与卡片文字清晰 |

截图建议：900px 订单页、900px 模板页、530px 订单页、折叠态深色侧栏、长标题详情。

---

## 10. 正式数据隔离

| 项 | 结果 |
|---|---|
| 活动代际 | `gen-c00a879220964299af7adcef8b9fc1c5`（未变） |
| schema | v3（无迁移） |
| 订单 / 客户 / 模板 / 附件 | 4 / 1 / 2 / 2 |
| 事件（completed） | 23（4） |
| QA seeded / clean | 未重建、未清空 |

本轮只在 `npm run dev` 的 Vite 页面上做几何测量（页面数据来自内存假数据，
不读写任何数据库），未启动正式应用，未触碰 QA 数据文件。

---

## 11. Git 提交

```text
11e5ab2 fix(layout): stop the stacked list from sitting on top of the detail
36fb43b feat(ui): icon boxes, ghost collapse control and a title tooltip
6211e15 test(layout): measure real geometry in Chrome instead of asserting on CSS text
<docs> 本报告与状态更新
```

样式与控件规范改在同一个 `styles.css` 里，所以第一次提交同时包含轨道修复与控件令牌。

未推送。

---

## 12. DOCK-01

保持 **OPEN / P1 / v1.0 发布阻断**。本轮未修改退出流程、未注入原生钩子、
未做草稿持久化。
