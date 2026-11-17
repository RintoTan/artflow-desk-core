# DEV-06B-VIS-FIX 结果报告

- 日期：2026-11-17
- 范围：只修深色主题的三处视觉缺陷（VIS-01/02/03），未改主题架构、未加功能
- 状态：**自动化通过，像素级验证 NOT VERIFIED**，等你 Mac 截图复核

---

## 1. 根因

三处缺陷是**同一类错误**：结构性背景写死了浅色，文字却走主题令牌。

| 位置 | 原值 | 深色下的结果 |
|---|---|---|
| `.sidebar` | `linear-gradient(180deg, rgba(255,255,255,.92), rgba(237,243,250,.82))` | 侧栏仍是浅灰渐变，`--text` 已变浅色 → 浅底浅字 |
| `.panel-quiet`（工作台「提醒说明」） | `rgba(255,255,255,.66)` | 同上 |
| `.tone-warn / .tone-danger / .tone-accent`（KPI 卡片） | `linear-gradient(180deg, #fffaef / #fff6f4 / #f7fbff, var(--*-soft))` | 渐变顶端是近白，底端是深色 soft → 上半张卡片浅、文字浅 |

另外两处同类问题一并处理：

- `.risk-today`（`#fff1e6` + `#a55618`）、`.risk-unscheduled`（`#eef1f5` + `#5f6b78`）——深色下浅底浅字；
- `.btn-danger` 用 `color:#fff`，深色下 `--danger` 是 `#e2836f`，白字对比只有约 2.3:1。

### 为什么会漏

`.panel`、`.metric-card`、`.stat` 本来就是令牌化的，所以浅色没问题；
我上一轮换掉了 6 处硬编码，但**没有系统性扫描"结构性背景"这一类**，
只按 grep 到的少数几个值改了，漏掉了渐变与 tone 变体。

---

## 2. 修改

### 2.1 令牌（`src/styles.css`）

新增语义令牌，两套主题各自定义：

| 令牌 | 浅色 | 深色 |
|---|---|---|
| `--sidebar-bg` | 原浅灰渐变（外观不变） | `linear-gradient(180deg, #1a232d, #141c24)` |
| `--panel-quiet-bg` | `rgba(255,255,255,.66)` | `rgba(255,255,255,.035)` |
| `--tone-accent-bg` | `#f7fbff → --accent-soft` | `#1a2c3d → --accent-soft` |
| `--tone-warn-bg` | `#fffaef → --warn-soft` | `#2e2612 → --warn-soft` |
| `--tone-danger-bg` | `#fff6f4 → --danger-soft` | `#34211d → --danger-soft` |
| `--tone-warn-border` | `#e3cf9c` | `#6b5522` |
| `--chip-today-bg/text` | `#fff1e6` / `#a55618` | `#33261a` / `#e0a878` |
| `--chip-neutral-bg/text` | `#eef1f5` / `#5f6b78` | `#25313d` / `#a9b8c7` |
| `--danger-contrast` | `#ffffff` | `#2a120d` |

浅色取的是**原有字面量**，所以 Arctic Blue 外观没有任何变化（不是"重新配色"）。

### 2.2 使用点

- `.sidebar` / `.panel-quiet` / `.tone-*` / `.risk-*` 改为引用令牌；
- `.btn-danger` 文字改用 `--danger-contrast`；
- `.btn-primary:hover` / `.btn-danger:hover` 不再跳到写死的 `#2560a0` / `#9d3626`，
  改用 `filter: brightness(0.92)`——否则自定义强调色时悬停会变色，深色下也偏暗。

### 2.3 修不了的地方（先说清）

深色下"浅底浅字"能在 CSS 层面根除，但**具体观感**（层次是否够、渐变是否好看）
只能由人眼判断，我无法截图。

---

## 3. 回归守卫（新增）

`src/styles.theme.test.ts`，4 条，直接解析 `styles.css` 源码：

| 用例 | 防止什么 |
|---|---|
| 结构性令牌在两套主题里都定义且取值不同 | 新增令牌只写浅色、深色退回浅值 |
| 页面里用到的每个 `var(--x)` 都有定义 | 拼错令牌名导致回退成继承色 |
| 非 `:root` / 深色块里的 `background` 不得写浅色字面量（亮度 > 0.7，或透明度 > 0.4 的白色） | **正是本轮这三次缺陷的同类**再次出现 |
| `.sidebar` / `.panel-quiet` / `.tone-*` 必须使用语义令牌 | 有人把渐变抄回去 |

实现说明：

- 解析前剥离注释（注释里也有 `{` 与 `var()`）；
- 用 WCAG 相对亮度判断"浅色"，阈值 0.7；
- 半透明白（查看器按钮底 `rgba(255,255,255,0.06~0.18)`）按不透明度豁免，不算违规。

**这条守卫的边界**：它抓的是"写死浅色"，抓不到"令牌值本身选错了"
（比如深色的 `--surface` 被写成近白）。后者靠人眼与截图，不冒充已覆盖。

---

## 4. 自动化结果

```text
npm run test              → 163 passed / 0 failed（23 个文件）
npx tsc --noEmit          → 通过
npm run build             → ✓ built in 104ms
cargo check --all-targets → 通过
cargo test                → 282 passed / 0 failed（Rust 本轮未改）
```

前端 159 → **163**：新增 4 条样式守卫。其余 159 条（主题、侧边栏、关窗、快捷键、
KEY-01、CSV、统计、附件）全部保持通过。

真实启动：QA seeded 冒烟启动一次，`mode=qa` 正常，无运行时错误。

---

## 5. 正式数据隔离

| 项 | 结果 |
|---|---|
| 活动代际 | `gen-c00a879220964299af7adcef8b9fc1c5`（未变） |
| schema | v3（无迁移） |
| 订单 / 客户 / 模板 / 附件 | 4 / 1 / 2 / 2 |
| 事件（completed） | 23（4） |
| 正式库主题键 | 未写入（仍是空） |
| QA seeded / clean | 未重建、未清空 |

本轮只改 CSS 与测试文件，没有触碰数据层。

---

## 6. 待你实机复核（NOT VERIFIED）

1. 深色下侧边栏整体（背景、品牌名、未选中项、选中项、QA 标识、底部版本）是否可读；
2. 深色下工作台与统计的指标卡片（普通 / 强调 / 完成 / 提醒 / 逾期）文字与数字是否清晰；
3. 「提醒说明」面板正文是否可读；
4. 订单列表的「今天到期」「未排期」标签在深色下是否还能辨认；
5. 侧边栏折叠状态下深色是否同样正常；
6. 浅色 Arctic Blue 是否与之前完全一致（应当没有变化）。

复核方式：`npm run qa:seeded` → 设置里切深色 → 逐页看。截图发我。

---

## 7. 提交

```text
fix(theme): replace hard-coded light surfaces with dark-aware tokens
test(styles): guard against hard-coded light backgrounds
docs: DEV-06B-VIS-FIX report
```

未推送；未进入 DEV-06C。
