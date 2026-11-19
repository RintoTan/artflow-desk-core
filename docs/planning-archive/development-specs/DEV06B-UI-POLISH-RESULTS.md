# DEV-06B-UI-POLISH 结果报告

- 日期：2026-11-17
- 范围：窄窗口订单列表有效高度、长标题提示、导航图标居中与文字对齐、折叠按钮位置
- 前提：上一轮 L1～L4 / V1 已由你实机确认 PASS，本轮**没有推翻**任何一条已修好的布局
- 状态：四项问题均已按实测原因修复；几何 **13/13 PASS**（Blink 真实排版），
  功能 **199 个前端测试 + 282 个 Rust 测试 PASS**；
  WKWebView 像素观感仍 **NOT VERIFIED**，等你截图

---

## 1. 四项问题的具体原因

### 1.1 UI-06 窄窗口订单列表可视高度过小

不是"42vh 太小"，而是**这 42vh 是给整张卡片的，而卡片有一笔固定开销**。

900px 窗口、800px 高时实测：

```text
.orders-list    总高 320px
  panel-head    45px
  list-tools    34px   （搜索框 + 密度按钮）
  filter-row    25px   （全部/活动/已完成/已取消）
  order-rows   122px   ← 真正的可滚动区
  list-hint     17px
  内边距+外边距  77px
一行 78px → 一屏 1.5 行
```

530px 窗口同一份数据：可滚动区只剩 **57px**，一屏**连一行都放不下**。

所以"继续调大 vh"只会把卡片撑得更高，可滚动区几乎不变 —— 这正是你要我避免的做法。

另外查到一个**遗留冲突**：`@media (max-width: 980px)` 里还留着上一轮的
`grid-template-columns: 1fr` 和 `.orders-list { max-height: 40dvh }`。
它在文件里排在容器查询之后，把 `max-height` 覆盖成 40dvh（800px 高时正好 320px，
与实测吻合），而且只给 `max-height` 不给 `height` —— 正是"列表压住详情"那一类组合。
更糟的是它按**窗口宽**判断：窗口 950px + 侧栏折叠（内容区 814px）时，容器查询说两栏、
它说单栏，两边打架。这条规则已删除。

### 1.2 UI-05 长标题悬停看不到完整名称

原生 `title` 挂载位置是对的（`.order-row-title` 上有 `title={order.title}`），
但那个 span 同时是 `display: -webkit-box` + `-webkit-line-clamp: 2` + `overflow: hidden`，
并且嵌在 `<button>` 里。WKWebView 在这个组合下不弹原生 tooltip —— 你的截图已经证明了。

写应用内气泡时还撞到第二个坑：**line-clamp 的盒子量不出溢出**。

```text
被截断的 span： rectH=36  scrollHeight=36  Range 行数=2
克隆掉行数限制后：rectH=55                       ← 只有它说得出真话
```

`scrollHeight` 恒等于裁剪后的高度，`Range.getClientRects()` 也只返回保留的那两行，
所以判断"是否被截断"必须用同宽、去掉行数限制的克隆量一次。

### 1.3 UI-01 折叠导航图标没有视觉居中

CSS 里 `.nav-item` 被定义了两次：前面是 `display: flex; align-items: center; gap: 10px`，
后面一条 `display: block` 同权重、位置更靠后，**把 flex 整个废掉**。
于是折叠态的 `justify-content: center` 不生效，图标按块级 inline 布局贴在左边：

```text
折叠态，修复前：item 44×45  boxX=12  itemX=12  → 水平偏移 -10px，垂直 -2px
```

`gap: 10px` 同样失效，展开态文字起点紧贴图标盒（间隙 0px，视觉上只剩 SVG 的 2px 内缩）。

### 1.4 UI-01 展开导航文字不齐 / UI-03 折叠按钮悬在半腰

- 展开态每行高 **45px**（`padding: 9px 12px` + 19px 行高，把 `min-height: 44` 顶破），
  图标盒比行中心**高 2px**，文字比行中心**低 4px**。
- 折叠按钮实测 y=553、bottom=593，侧栏底 800、版本区顶 735：**离底 207px、离版本区 142px**。
  原因是 `.sidebar-collapse` 和 `.sidebar-foot` **各自都有 `margin-top: auto`**，
  flex 会把剩余空间平分给两个 auto margin（284px → 各 142px），按钮就停在半腰。
- 另外 `.sidebar-collapse` 后面还有一条 `min-height: 40px`，把展开态的命中高度从 44 偷偷改成 40。

---

## 2. 修改的 CSS / 组件与交互行为

### 2.1 订单列表高度（`src/styles.css` + `OrdersPage.tsx`）

```css
/* 只给"列表体"确定高度，卡片高度由内容决定，不再裁剪 */
.orders-page.orders-layout { grid-template-rows: max-content auto; }
.orders-page .orders-list {
  height: auto; max-height: none; min-height: 0;
  overflow: visible; padding: 16px 18px 16px;
}
.orders-page .order-rows {
  flex: 0 0 auto;
  /* 两个约束取小：34dvh 给"更多订单"；60dvh-190px 防止矮窗口里卡片占满整屏 */
  height: max(180px, min(34dvh, calc(60dvh - 190px)));
}
/* ≤560px 容器：max(160px, min(30dvh, calc(58dvh - 190px))) */
```

- 190px 不是拍的：它等于本页卡片的固定开销（内边距 32 + 表头 53 + 搜索 34 + 筛选 25 + 说明 17 + 间距），实测 459−272 = 187。
- `grid-template-rows` 第一行**必须显式 `max-content`**：留 `auto` 时这张"高度由内容决定"的卡片只贡献 34px
  （实测 `auto → 34px`，`max-content → 458.5px`），内容照样画 459px，于是又压住详情。
- 删除 `@media (max-width: 980px)` 单栏规则（原因见 1.1）。
- `.orders-page` 是订单页根节点新增的类名，**客户页与模板页不做任何改动**，仍是 42vh。

### 2.2 长标题提示（新增 `src/components/TitleTooltip.tsx`）

- `TruncatedTitle`：只在"克隆量出的完整高度 > 按钮盒高度"时才考虑弹；
- 450ms 显示延迟；`pointerleave` / `blur` / 任意滚动 / resize / Esc / 窗口失焦都立刻收起；
- `createPortal` 到 `document.body` + `position: fixed`，因此不被 `.main` / `.order-rows` 的 overflow 裁切；
- `pointer-events: none`，不挡点击、拖动把手和键盘导航；
- 键盘：焦点落在整行的 `<button>` 上，组件监听该按钮的 `focus`/`blur`，并临时挂 `aria-describedby`；
- 定位 `placeTooltip()`：优先下方，放不下翻上方，左右贴 8px 边距；
- 样式走 `--tooltip-bg/--tooltip-fg/--tooltip-shadow`，深浅两套反向配色；
- 订单行同时**移除了原生 `title` 属性**，避免 Chrome 下弹两个气泡。

### 2.3 导航（`src/services` 无关，纯 CSS + `App.tsx`）

```css
.nav-item {                       /* 只保留这一条，删掉后面的 display:block */
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  column-gap: 10px; align-items: center;
  min-height: 44px; padding: 0 12px;
}
.shell-sidebar-collapsed .nav-item { grid-template-columns: 24px; justify-content: center; padding-inline: 0; }
```

- 图标列固定 24px，文字起点与图标形状、名称长短无关；
- 折叠态只剩一列 24px + `justify-content: center`，图标盒中心 = 命中区中心；
- `≤720px` 的媒体查询原来靠 `font-size: 0` + `::first-letter` 露出一个字（文字框仍占位），改成隐藏 `.nav-label` 并同样单列居中；
- 折叠后文字消失，补了 `aria-label={item.label}`，否则可访问名会跟着消失。

### 2.4 侧栏底部（`App.tsx` + `styles.css`）

```html
<div class="sidebar-bottom">
  <button class="sidebar-collapse">…</button>
  <footer class="sidebar-foot">…</footer>
</div>
```

```css
.shell { grid-template-rows: minmax(0, 1fr); }   /* 行可收缩，矮窗口不把底部顶出去 */
nav { min-height: 0; overflow-y: auto; padding: 2px; margin: -2px; }
.sidebar-bottom { margin-top: auto; display: flex; flex-direction: column; gap: 4px; flex: 0 0 auto; }
```

- 按钮与版本信息共享一个 auto margin，不再各分一半；
- 分隔线留在 `.sidebar-foot` 的 `border-top`（按钮 → 分隔线 → 版本）；
- 删掉 `min-height: 40px` 的覆盖，展开态与折叠态都是 44px；
- 导航项多/窗口矮时导航自己滚，底部组始终可见。

---

## 3. 订单列表高度：改善前后实测

同一份种子数据（4 张订单，单行 78px），无头 Chrome 真实排版：

| 场景 | 卡片高 | **可滚动区** | 一屏完整行数 | 详情起点 | 重叠 |
|---|---|---|---|---|---|
| 900×800 修复前 | 320 | **122** | 1 | 431 | 0 |
| 900×800 修复后 | 459 | **272** | 3 | 570 | 0 |
| 530×800 修复前 | 272 | **57** | 0 | 390 | 0 |
| 530×800 修复后 | 427 | **240** | 3 | 545 | 0 |

高度自适应（900px 宽）：

| 视口高 | 可滚动区 | 完整行数 | 卡片占视口 |
|---|---|---|---|
| 1000 | 340 | 4 | 53% |
| 800 | 272 | 3 | 57% |
| 700 | 230 | 2 | 60% |
| 600 | 180 | 2 | 61% |

卡片占比被 60dvh 那一条约束压住，不会随着"加高度"一路涨到占满整屏。

---

## 4. 导航与折叠按钮实测

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 展开态行高 | 45px（不一致） | 44px（7 项全同） |
| 展开态文字起点 | 52px，与图标盒间隙 0 | 62px，7 项完全相同 |
| 图标盒垂直偏移 | −2px | 0 |
| 折叠态图标水平偏移 | −10px | 0（7 项全 0） |
| 折叠态命中区 | 44×45 | 44×44 |
| 折叠按钮（展开） | 40px 高，y=553，离底 207px | 44px 高，y=689–733，离底 67px、离版本区 4px |
| 折叠按钮（折叠） | 44×44，y=740–784 | 同左，仍在底部 |

矮窗口（1400×400，导航必然放不下）：

```text
nav         y=82  h=189  clientH=189  scrollH=324  overflow-y=auto   ← 自己滚
折叠按钮     y=289–333
版本区       y=337–384（窗口高 400，仍在窗口内）
```

修复前同一场景：按钮 y=424、版本区 472–519，**整个底部组被顶到窗口外**。

---

## 5. Tooltip 在真实应用中的待验证事项

已经用 Blink 量到的：

```text
被截断 36px → 完整 55px，气泡 420×89，placement=bottom，父节点 body，
pointer-events=none，overflow-wrap=anywhere，在视口内；滚动后消失
```

**尚未验证（需要你在 WKWebView 里看）**：

1. 悬停延迟 450ms 的手感是否合适（Blink 无法替代体感）；
2. 气泡在 WKWebView 的字体度量下换行位置是否一致（中英混排尤其）；
3. 靠近窗口底部时翻转到上方的观感；
4. 触摸板上"扫过列表"时是否仍会闪现（设计上 450ms 延迟 + 离开即收，但需要真实指针设备确认）。

---

## 6. 测试与自动化结果

| 检查 | 结果 | 证据级别 |
|---|---|---|
| `npm run layout:check` | **13/13 PASS** | 真实几何（Blink 排版） |
| `npm run test` | **199 passed / 26 files** | 功能 |
| `npx tsc --noEmit` | 干净 | 类型 |
| `npm run build` | 通过（103ms） | 构建 |
| `cargo check --all-targets` | 干净 | 编译 |
| `cargo test` | **282 passed** | 功能 |

几何检查从 9 项扩到 13 项，新增：

- `/orders @900`、`@530` 的**可滚动区下限**（240 / 200）与"一屏至少 2 行"；
- 列表卡片不超过视口的 66%；
- 展开态 7 项的图标盒垂直偏移 ≤1px、文字起点**完全一致**、行高一致；
- 折叠态 7 项的图标盒水平/垂直偏移 = 0，命中区 44×44；
- 折叠按钮贴底（距底 40–120px、不与版本区重叠）；
- 1400×400 时导航退化为滚动容器、按钮与版本区仍在窗口内；
- 长标题气泡：出现、在视口内、挂在 body、不拦截指针、滚动后收起。

规则级（jsdom 里只断言 CSS 文本，属于"规则 PASS"，不代表看起来对）新增 9 条，
见 `src/styles.layout.test.ts` 的 `DEV-06B-UI-POLISH 规则守卫`。
功能级新增 13 条：`TitleTooltip.test.tsx`（10）、`OrdersPage.title.test.tsx`（3）。

**Blink 与 WKWebView 的差异仍然存在**，以上几何结论不能当作像素结论。

---

## 7. 正式数据指纹（未变）

```text
generation  gen-c00a879220964299af7adcef8b9fc1c5
schema      v3
orders      4      clients 1     stage_templates 2
attachments 2      events  23    completed 4
```

只读查询（`file:...?mode=ro`）核对，未做任何写操作。本轮全部验证在
`tempfile`、Vite dev server 的假 IPC 与只读查询中完成。

---

## 8. 本地 Git 提交（未推送）

```text
d7b5d49 test(layout): assert list scroll area, nav centring and tooltip in real geometry
cfd03b1 fix(ui): measured list height, centred nav icons and a real title tooltip
```

---

## 9. 下一轮最短实机验收流程

打开正式应用（或 QA 预置场景）后，按顺序做这五件事：

1. **窄窗口列表高度**：把窗口拖到约 900px 宽，看订单列表能不能一屏看到 3 张；
   再用方向键把光标移到最后一张，列表应自动滚动。
2. **长标题**：找一张两行截断的订单，鼠标停 0.5 秒以上 —— 应出现气泡、显示完整标题；
   按下 Tab 让焦点落到该行，气泡同样应出现；滚动列表时气泡应立刻消失。
3. **折叠导航居中**：点侧栏底部"折叠"，七个图标应落在 44×44 方格正中，左右留白相等。
4. **展开导航对齐**：再展开，确认七个文字的左边缘在同一条竖线上，
   且"工作台/流程模板/历史统计/数据环境"长短不同也不会让文字起点跳动。
5. **底部按钮**：折叠按钮应紧贴版本信息上方（中间只有一条分隔线）；
   把窗口高度压到 400px 左右，按钮和版本信息仍应留在窗口内、导航自己滚动。

任何一项不符，把截图和"哪一项"发回来即可，我不需要你说改哪里。

---

## 10. 未处理 / 仍然开放

- **DEV06A-DOCK-01 = OPEN / P1 / v1.0 发布阻断**：Dock 右键"退出"仍绕过未保存保护。
  需要 unsafe 注入 `applicationShouldTerminate:`，本轮未授权、未实施。
- 展开 ↔ 折叠的宽度过渡是 160ms，但图标列由双列变单列是瞬时切换。
  没有做过渡动画：`grid-template-columns` 在两种列数之间不可插值，
  强行加动画只会产生跳变。是否需要一个淡入淡出，请你决定。
- 订单列表的密度（紧凑/舒适）会影响一屏行数，本轮按舒适密度（78px/行）验收。
