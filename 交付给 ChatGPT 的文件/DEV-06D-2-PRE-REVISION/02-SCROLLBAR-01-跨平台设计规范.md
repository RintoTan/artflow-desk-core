# SCROLLBAR-01 全站跨平台低存在感滚动条 · 设计规范

**状态：** 设计 + 技术可行性结论。**本轮未修改任何业务 CSS，未在 WKWebView / WebView2 实机验证。**
**状态板：** `prototypes/dashboard-timeline-review.html?view=scrollbar`
**证据：** `screenshots/滚动条设计状态联系表.png`；截图原件在 ZIP 内 `screenshots/raw/12-滚动条板-1400.png`

---

## 1. 目标与非目标

目标：滚动条不抢卡片、订单、图片的注意力；但**任何时候都不永久隐藏**，不牺牲可用性。

非目标：

- 不追求"两平台像素一致"（做不到，见 §4）。
- 不自绘滚动条（见 §6 为什么否决）。
- 不改任何 `overflow` 行为、不接管滚动逻辑。

---

## 2. 现状审计（只读）

| 项 | 实测 |
|---|---|
| `::-webkit-scrollbar` | **0 处**（`grep -c` = 0） |
| `scrollbar-width` / `scrollbar-color` | **0 处** |
| `scrollbar-gutter` | 5 处：`.main { stable }`、`.order-rows / .clients-page .order-rows / .sqe-* / .tz-* { auto }`、`.settings-* { stable }` |
| `color-scheme` | 仅深色主题下 `[data-theme="dark"] { color-scheme: dark }` |
| 带 `overflow: auto/scroll` 的滚动容器 | **11 处**（见 §7） |

结论：现状是"完全交给系统"。深色主题下出现的深灰轨道是 `color-scheme: dark` 下的**原生**滚动条，不是残留的自定义样式（FIX-C 的结论在本轮复核中仍然成立）。

---

## 3. 四状态规范

| 状态 | 触发 | 拇指宽度 | 拇指不透明度 | 轨道 | 过渡 |
|---|---|---|---|---|---|
| 静止 | 无操作 ≥ 600ms | 4px | 14%（浅）/ 16%（深） | 透明 | 180ms ease-out 收窄 |
| 悬停 | 指针进入滚动容器 | 6px | 32% / 34% | 透明 | 120ms |
| 滚动中 | scroll 事件期间 + 600ms | 10px | 55% / 58% | 透明 | 90ms 展开 |
| 拖动 | 指针按在拇指上 | 10px | 74% / 78% | 6% 强调色 | 0（即时） |

- 圆角：`999px`；拇指内缩 2px（`border: 2px solid transparent; background-clip: padding-box`）。
- 轨道绝不填成整条深色矩形 —— 这是本次要消掉的观感。
- `prefers-reduced-motion: reduce` 时取消宽度/透明度过渡，只做瞬时切换（**必须自己写**，系统不会替你做）。
- 数值是设计基线，字母级微调留到实机验收。

---

## 4. 平台能力（带一手来源）

| 能力 | 事实 | 来源 |
|---|---|---|
| `scrollbar-width: thin` | 标准属性。Chrome/Edge **121**、Firefox 64、Safari **18.2**；Baseline 2024 | [MDN scrollbar-width](https://developer.mozilla.org/en-US/docs/Web/CSS/scrollbar-width) |
| `scrollbar-color` | 标准属性。Chrome/Edge 121、Firefox 64、Safari **26.2**（不是 18.2） | [MDN scrollbar-color](https://developer.mozilla.org/en-US/docs/Web/CSS/scrollbar-color)、[WebKit 26.2](https://webkit.org/blog/17640/webkit-features-for-safari-26-2/) |
| 与伪元素的优先级 | `scrollbar-width/color` 不为 `auto` 时，UA **忽略** `::-webkit-scrollbar-*`（方向和常见说法相反） | 同上 |
| `::-webkit-scrollbar` | **非标准**（MDN 标注 "Not part of any standard"）；Blink + WebKit 支持，Firefox 不支持 | [MDN ::-webkit-scrollbar](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Selectors/::-webkit-scrollbar) |
| 设了伪元素宽度 → 强制经典滚动条 | Blink 文档明写 "an overlay scrollbar is always displayed, effectively turning it into a classic scrollbar" | [Chrome scrollbar styling](https://developer.chrome.com/docs/css-ui/scrollbar-styling) |
| `scrollbar-gutter: stable` | Chrome 94 / Firefox 97 / Safari 18.2；**overlay 下不预留、属性无效果** | [MDN scrollbar-gutter](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/scrollbar-gutter) |
| Chromium Fluent 滚动条 | Windows/Linux **非 overlay** 版随 Chromium **133** 默认开启，flag `FluentScrollbar`，17px → 15px；overlay 版开启方式当时"仍在决定" | [blink-dev Intent](https://groups.google.com/a/chromium.org/g/blink-dev/c/vabF61VwINk/m/X7J1jbghEgAJ)、[chromestatus](https://chromestatus.com/feature/5693137379917824) |
| WCAG 1.4.11 | 条款正文未出现 "scrollbar"；"由 UA 决定且作者未修改"可豁免 → **一旦作者上色，滑块按 UI 组件对待，≥ 3:1** | [Understanding 1.4.11](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) |
| WCAG 2.5.7 拖拽 | 豁免 UA 自带滚动条；自建滚动机制则转为作者责任 | [Understanding 2.5.7](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html) |
| forced-colors | `scrollbar-color` 被强制为 `auto`，`box-shadow/text-shadow` 变 `none` → 靠阴影做"低存在感"的滑块在 Windows 高对比度下会消失 | [MDN forced-colors](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/forced-colors) |

### 4.1 本轮实测（Blink，macOS，headless Chrome）

- 给滚动容器加 `scrollbar-color`：`offsetWidth − clientWidth` 从 **0 → 15**，即 **overlay 变成 15px 常驻占位**（原型状态板底部有实测打印）。
- 加 `scrollbar-width: thin` 同样转为常驻（细）轨道。
- 不加任何样式时，页面级占位 0（macOS overlay），无头截图中会出现系统灰色胶囊（只在截图里常驻，真实 WKWebView 静止时隐藏）。

**这条实测是本次设计分叉的依据**：在 macOS 上"上色"和"保持 overlay"不可兼得。

### 4.2 因此：平台分治

| 平台 | 策略 | 理由 |
|---|---|---|
| **macOS WKWebView** | **不写任何滚动条样式**，保留系统 overlay；深色由 `color-scheme` 决定拇指色 | 定制会把 overlay 变成常驻 15px，直接违背"低存在感"；且 `scrollbar-color` 要 Safari 26.2，覆盖不到旧系统 |
| **Windows WebView2** | `scrollbar-width: thin` + `scrollbar-color`（Chromium 121+）；需要圆角/内缩时再叠 `::-webkit-scrollbar`（二选一，不能同时指望） | Windows 滚动条本来就常驻占位（Fluent 15px），定制**不损失** overlay，收益是"轨道透明 + 细拇指" |

这条分治是**唯一同时满足"低存在感"和"两平台都可实现"的方案**；统一成一套必然在某一侧退化成"更丑的原生深灰轨道"或"macOS 上多出一条 15px 常驻条"。

### 4.3 未证实（不得写进实现假设）

- macOS 系统设置"自动 / 滚动时 / 始终"与 `::-webkit-scrollbar` 的交互：**没有权威来源**。Apple 支持页抓取只返回导航壳，WebKit 博客也未明说。需要在 Mac 实机用 `clientWidth` 差值实测。
- WebView2 是否遵循 Windows"自动隐藏滚动条"（设置 → 辅助功能 → 视觉效果）：Microsoft Learn 未检索到文档。

---

## 5. 回退策略

1. 默认（无 JS、无自定义属性）：系统滚动条原样 —— 功能永远可用。
2. `@supports (scrollbar-width: thin)` 内才加细轨道；不支持就走原生。
3. 高对比度 / `forced-colors: active` 下全部退回原生（不抵抗系统）。
4. 任何情况下**禁止** `scrollbar-width: none` 作为全站方案（可访问性风险，MDN 明确警告）。

---

## 6. 被否决的方案

| 方案 | 否决理由 |
|---|---|
| `scrollbar-width: none` 全站隐藏 | 用户无法发现滚动区域；违反 2.1.1 的风险；移动端/触控板用户失去唯一可见提示 |
| 自绘滚动条（div + 拖拽逻辑） | 要自己实现拖拽、键盘、吸附、惯性，WCAG 2.5.7 转为作者责任；收益仅为"像素级统一"，风险不成比例 |
| 全站强制 `::-webkit-scrollbar` | 非标准；Firefox 不支持；且会把 macOS overlay 变成常驻；一旦设了 `scrollbar-color` 还会被压制 |
| 用 `scrollbar-gutter: stable` 消除抖动 | overlay 下无效；只在经典滚动条平台起作用（现状已在 `.main` 使用，保留） |

---

## 7. 覆盖范围清单（11 个滚动容器）

| 容器 | 现状 | 本轮结论 |
|---|---|---|
| `.main`（页面主滚动） | `overflow-y:auto` + `scrollbar-gutter: stable` | 保持原生（macOS overlay / Windows 系统） |
| `.order-rows`（订单列表） | `overflow-y:auto`，`gutter: auto` | macOS 原生；Windows 细轨道 |
| `.clients-page .order-rows` | 同上 | 同上 |
| `.board` / `.board-cards`（看板） | `overflow:auto` | 同上；横向滚动条同样按平台分治 |
| `.table-wrap`（表格） | `overflow:auto` | 同上 |
| `.chart-scroll`（统计图表横滚） | `overflow-x:auto` | 同上 |
| `.action-menu-inner` | `overflow:auto` | 菜单内滚动，保持原生（避免菜单变宽） |
| `.stage-adjust-list` | `overflow:auto` | 同上 |
| `.pick-list`（导出选单） | `overflow:auto` | 同上 |
| `.tz-list`（时区选择器） | `overflow:auto` | 同上 |
| `nav`（侧栏导航） | `overflow-y:auto` | 保持原生；侧栏窄，细轨道会挤文字 |

未来新增：时间线轨道（`DEV-06D-2`，本轮原型**保持原生 overlay**，用右侧渐隐 + 状态行"可见 …"做替代提示）、日历（`DEV-06D-3`）、画廊（`DEV-06D-4`，瀑布流本身不用滚动条，但查看器需要）。

---

## 8. 无障碍

- 键盘：不改 `overflow`，方向键 / PageUp/Down / Home/End 全部保留。
- 发现性：macOS overlay 静止不可见时，用**内容裁切 + 右侧渐隐 + "可见 … ~ …" 文案**提示还有内容（时间线已实现）。
- 对比度：一旦上色，拇指对相邻背景 ≥ 3:1（Windows 档：`rgba(44,111,181,.42)` 叠在白/深底上，实测需在实机用取色器确认，**本轮未测**）。
- 拖动目标：不自绘，命中区由系统决定（macOS 约 11px，Windows 15px），都 ≥ 12px。
- 高对比度：不抵抗 `forced-colors`。
- 减少动效：`prefers-reduced-motion` 下取消 90–180ms 过渡。

---

## 9. 验收方法（Mac / Windows 各一次）

1. `document.documentElement.clientWidth` 与 `window.innerWidth` 差值：0 = overlay，>0 = 经典占位。
2. 系统"显示滚动条"三档（自动 / 滚动时 / 始终）各测一次：记录差值、拇指颜色、是否遮挡内容。
3. 在时间线轨道上横向滚动，确认不会出现"常驻 15px 条把行挤窄"。
4. Windows 下切高对比度主题，确认滚动条退回系统样式且仍可操作。
5. 触控板惯性滚动时观察是否有闪烁（overlay 淡入淡出）。

以上 5 项在本次均为 **NOT RUN**。
