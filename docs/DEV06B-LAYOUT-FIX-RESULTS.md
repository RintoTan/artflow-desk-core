# DEV-06B-LAYOUT-FIX 结果报告

- 日期：2026-11-17
- 范围：窄窗口布局（LAYOUT-01～04）、导航图标统一（SIDEBAR-01）、折叠命中区域（SIDEBAR-02）
- 状态：**代码与规则层已验证，真实像素 NOT VERIFIED**，等你按第 9 节截图验收

---

## 1. 根因：三个页面共用同一个写死的两栏网格

`OrdersPage`、`ClientsPage`、`TemplatesPage` 的根容器都是同一个类：

```css
.orders-layout {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);   /* 没有任何降级 */
  gap: 14px;
}
```

配套的左侧列表：

```css
.orders-list {
  position: sticky;
  top: 0;
  max-height: calc(100dvh - 60px);
  overflow: hidden;
}
```

窗口约 900px 时，主内容区实际只有 ≈620px（900 − 232 侧栏 − 60 内边距），
右栏被压到 ≈286px。而右栏里的 `.actions`（并排按钮）、`.facts`（多段信息）、
`.form-grid`（最小 200px 一列）都塞不进去，于是：

1. 右栏内容溢出到自己那一格之外 → 与左侧粘性列表**视觉重叠**；
2. `.orders-list` 是 `position: sticky` 且高度按整个视口算，滚动时压在详情上方；
3. 按钮与标签被 `.panel` 的圆角/内边距裁掉（`overflow` 没显式处理，靠浏览器默认裁切）。

所以不是三个页面各自写错，而是**共用的网格没有窄宽度方案**。

---

## 2. 响应式方案与断点依据

### 2.1 用内容宽度，不用窗口宽度

```css
.main {
  container-type: inline-size;
  container-name: workspace;
}
```

理由：侧栏可以折叠。窗口 1000px 时，展开侧栏内容区约 720px（放不下两栏），
折叠后约 880px（放得下）。用 `@media` 只看窗口宽会在"折叠了但窗口没变"时判断错，
所以把判定挂在**主内容区自身的宽度**上（容器查询）。

### 2.2 两个断点

| 断点（内容区宽） | 处理 |
|---|---|
| ≤ 780px | 两栏 → 单栏上下堆叠；`.orders-list` 取消 sticky，限高 `42vh` |
| ≤ 560px | 列表进一步压到 `34vh`；`.form-grid` 强制单列 |

数值依据：列表固定 320 + 间距 14 + 详情可用最小 ≈440（一行两个按钮 + 表单两列）
= 774，取整 780。低于此值强行两栏必然裁切。

### 2.3 兼容退化

```css
@supports not (container-type: inline-size) {
  @media (max-width: 1120px) { /* 同样改成单栏 */ }
}
```

即使运行时 WebView 不支持容器查询，也会走窗口宽度判断，不会保持重叠状态。

### 2.4 明确没做的事

- 没有 `overflow-x: hidden` 或 `overflow: hidden` 掩盖问题（测试里有反向断言）；
- 没有 absolute 定位；
- 没有缩小字号；
- 没有强制横向滚动；
- 单栏模式下**不切换页面状态**：列表仍在、详情仍在，表单草稿不丢，
  离页保护与关窗保护完全不受影响（它们挂在路由与 registry 上，与布局无关）。

---

## 3. 三个页面的修复范围

| 页面 | 改动 |
|---|---|
| 订单 | 单栏堆叠；列表取消 sticky 与视口高度；详情列宽不再被压缩 |
| 客户 | 同上（共用 `.orders-layout`，自动获得） |
| 模板 | 同上 |

三页共用同一套规则，因此后续新增同结构页面也会自动降级。

---

## 4. 导航图标与命中区域

### 4.1 图标体系

- 统一 24 网格线性图标，`stroke-width: 1.8`、圆角端点与连接；
- 显示尺寸 20×20（原 16×16）；
- 7 个语义：`LayoutDashboard` / `ClipboardList` / `Users` / `Layers` / `ChartColumn` / `Settings` / `Database`；
- 全部内联 SVG（`aria-hidden="true"`，名称由 `.nav-label` 与 `title` 提供），
  没有混用图标字体、Unicode 或 emoji。

选中态沿用原有的浅蓝底 + 强调色文字，没有新增装饰。

### 4.2 命中区域

| 元素 | 尺寸 |
|---|---|
| 展开时 `.nav-item` | 高 ≥ 44px（宽随侧栏 232px） |
| 折叠时 `.nav-item` | 最小 44×44，图标居中 |
| 折叠按钮 | 折叠时最小 44×44；展开时高 ≥ 40px |
| 图标 | 20×20，在按钮内居中 |

裸标签自动满足：`min-width/min-height` 是布局属性，jsdom 读不到计算值，
所以用 CSS 规则断言（见第 6 节），真实命中尺寸仍需肉眼/截图确认。

### 4.3 自动紧凑

**没有做**"窄窗口自动折叠侧栏"。理由是它会和用户手选的折叠偏好打架，
而本轮的要求已经用单栏降级解决了内容重叠；自动折叠属于新的交互决策，
不在授权范围内。折叠状态仍只由用户操作改变，存在 `localStorage`。

---

## 5. 深浅主题回归

VIS-01/02/03 的修复已在当前代码里（提交 `e51a857`），本轮**没有重新改那三处**。

核对项：

- `.sidebar` → `var(--sidebar-bg)`，深色为独立深色渐变；
- KPI 的 `.tone-*` → `var(--tone-*-bg)`，深色版本单独取值；
- `.panel-quiet`（提醒说明）→ `var(--panel-quiet-bg)`；
- 订单状态标签 `--chip-*` 有深色值；
- 本轮新增/修改的规则（容器查询、`.nav-icon`、命中区域）都是**尺寸类**，不含颜色，
  不引入新的主题冲突。

`styles.theme.test.ts`（4 条）继续通过，`styles.layout.test.ts`（8 条）新增。

---

## 6. 自动化测试

```text
npm run test              → 172 passed / 0 failed（24 个文件）
npx tsc --noEmit          → 通过
npm run build             → ✓ built in 107ms
cargo check --all-targets → 通过（Rust 未改）
cargo test                → 282 passed / 0 failed
```

新增 9 条：

| 文件 | 用例 | 断言 |
|---|---|---|
| `src/styles.layout.test.ts` | 8 | `.main` 是 inline-size 容器；780px 块里两栏改单栏且解除 sticky；560px 块里表单单列；存在 `@supports` 退化路径；`.main`/`.orders-layout` 无 `overflow: hidden`；`.nav-item` ≥44 高；折叠态 44×44；图标 20px |
| `src/App.sidebar.test.tsx` | +1 | 8 个 `svg.nav-icon`（7 导航 + 折叠箭头），`stroke-width=1.8`，`aria-hidden`，每个链接都含图标 |

### 证据等级（必须说清）

- **规则层 PASS**：上述断言证明"降级规则确实存在且写法正确"。
- **像素层 NOT VERIFIED**：jsdom 不做排版，我也没有录屏/辅助访问权限，
  无法证明 900px 下真的不重叠。任何"没有元素重叠"的 DOM 断言都会是假的，所以没写。
- 兼容性风险：容器查询需要较新的 WebKit；已有 `@supports` 退化路径，但我
  **无法在本机验证 WebView 的 `CSS.supports("container-type: inline-size")` 返回值**。

---

## 7. 正式数据隔离

| 项 | 结果 |
|---|---|
| 活动代际 | `gen-c00a879220964299af7adcef8b9fc1c5`（未变） |
| schema | v3（无迁移） |
| 订单 / 客户 / 模板 / 附件 | 4 / 1 / 2 / 2 |
| 事件（completed） | 23（4） |
| QA seeded / clean | 未重建、未清空 |

本轮只改 `src/styles.css`、`src/App.tsx`（图标数据）与测试文件。

---

## 8. Git 提交

```text
<fix(layout)>    单栏降级与 sticky 解除
<feat(nav)>      Lucide 风格图标与 44px 命中区域
<test/docs>      布局规则守卫与报告
```

---

## 9. 你的最短截图验收

```bash
cd /Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk
lsof -ti:1421 | xargs kill -9 2>/dev/null
npm run qa:seeded
```

| 步骤 | 操作 | 期望 |
|---|---|---|
| 1 | 窗口拖到约 900px 宽，进「订单」 | 列表在上、详情在下；**没有**互相压住；按钮完整可见 |
| 2 | 同上，进「客户」/「流程模板」 | 同样上下堆叠，不重叠 |
| 3 | 把窗口拖到约 530px 宽 | 仍能操作：列表可滚、详情可滚，没有整页横向滚动条 |
| 4 | 拖回 1400px 宽 | 自动恢复左右两栏 |
| 5 | 折叠侧栏（此时内容区变宽） | 若仍不够宽就保持单栏——**不该因为窗口没变而误判** |
| 6 | 折叠状态下点几个图标 | 命中区域明显变大（44×44），图标 20px 居中，悬停有名称提示 |
| 7 | 切深色，重复 1–2 | 单栏下背景/文字仍然协调，不出现浅底浅字 |

截图请包含：900px 的订单页、900px 的模板页、530px 的订单页、折叠侧栏的深色状态。

---

## 10. 已知限制

1. 单栏模式下列表最多占 42vh（560px 以下 34vh）：这是为了留出详情空间，不是裁切。
2. 没有做"列表/详情互相切换"的显式模式（只在窄屏堆叠）。如果需要"点开订单后隐藏列表"
   这种交互，属于下一轮设计。
3. 未做窗口宽度自动折叠侧栏（理由见 4.3）。
4. 容器查询的 WebView 支持未经实机确认。
