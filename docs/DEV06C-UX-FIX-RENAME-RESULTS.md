# DEV-06C-UX-FIX + PRODUCT-RENAME 结果报告

- 日期：2026-11-17
- 范围：A 时间轴迁入详情 / B 统计图窄窗适配 / C 展示名称改为 ArtFlow Desk Core
- 状态：三个工作包均已实现，自动化全绿；**WKWebView 实机观感待你确认**
- 未改动：`--chart-*` 之外的主题令牌、统计口径、CSV、schema、identifier、Dock 相关一切

---

## 1. 三个工作包的改动文件

### A｜时间轴迁移

| 文件 | 改动 |
|---|---|
| `src/components/ScheduleTrack.tsx`（新） | 详情页宽轨道：区间、今天、四类标记、越界箭头 |
| `src/components/ScheduleOverview.tsx`（新） | 「排期概览」面板：文字日期 + 轨道，只读 |
| `src/lib/scheduleBar.ts` | 新增 `scheduleWindowFor()`：按订单自身日期自适应窗口 |
| `src/pages/OrdersPage.tsx` | 列表移除轨道与占位；详情插入概览面板；`.facts` 去掉重复的日期 |
| `src/components/OrderScheduleBar.tsx` | **删除**（列表版轨道） |
| `src/styles.css` | 删除 `.sched*` 列表样式，新增 `.schedule-*` 详情样式 |
| `src/pages/OrdersPage.schedule.test.tsx` | 重写为详情版 9 条 |
| `scripts/layout-probe.mjs` / `layout-check.mjs` | 断言改为「列表无轨道、详情有轨道」 |

### B｜统计图窄窗适配

| 文件 | 改动 |
|---|---|
| `src/lib/useElementWidth.ts`（新） | 回调 ref + ResizeObserver 量内容宽度 |
| `src/pages/StatsPage.tsx` | 单排/两排自适应；每排独立轴；`ChartAxis` 抽成组件 |
| `src/styles.css` | `.chart-row` 结构、`[data-mode="split"]` 六等分网格 |
| `src/pages/StatsPage.chart.test.tsx` | +3 条两排测试 |

### C｜展示名称

见 `docs/PRODUCT-NAMING.md` §8 的完整清单（11 处前端/配置 + 5 处 Rust 文案 + README）。

## 2. 订单列表恢复情况

- 96×14 图形轨道与 `.sched-text` 降级占位**已删除**，`.order-row-meta-text` 包裹层也一并还原，
  订单行回到 DEV-06B 的层级：编号 / 标题 / 状态与风险徽标 / 阶段 / 客户 / 排序控件。
- 行高实测仍是 **78px**（舒适密度），搜索、筛选、拖拽、↑↓、方向键、自动滚动、长标题气泡、
  选中态、`?orderId=` 打开方式全部未动。
- `layout:check` 新增断言直接检查「列表里没有 `.schedule-track`」。

## 3. 订单详情「排期概览」

```text
排期概览                              [已逾期 / 三日内到期 / 未排期]
计划日期是人工排期，与制作进度无关；实际开工来自生命周期事件。

计划开始        计划交付        实际开工
2026-11-01      2026-11-20      2026-11-02 08:00

▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬          轨道：灰轨 + 蓝区间
        ○              │      ┃
                    今天

轨道只表示日期位置，不表示完成度。今天的位置按工作时区计算。
```

- 第一层是**可复制的文字日期**（`<dl>`），缺失写「未设置」/「尚未开工」，绝不编日期；
- 第二层是宽轨道：计划区间、今天（带文字标签）、实际开工（空心圆）、完成（实心点）、
  取消（空心方）、交付标记（颜色取 `deadlineState`，终态转中性）；
- 轨道 `aria-hidden`，**不是唯一信息源**；
- 面板标题旁是风险徽标，只读后端 `deadlineState`，前端不重算；
- 日期完全为空时整块显示「尚未设置计划排期」的中性空态，不画空轨道；
- 面板是独立只读 `<section>`，不在表单里，不会触发保存或离页提示。

**窗口不再固定 ±45 天**：`scheduleWindowFor()` 取该订单全部日期与"今天"的极值，两侧留 8% 余量；
跨度超过两年时以今天为中心截断，超出的日期用三角箭头标越界——比例始终真实，只是窗口有限。

## 4. 900px / 530px 几何实测

| 视口 | 列表行高 | 列表有轨道？ | 详情轨道宽 | 今天位置 | 一屏完整订单 | 重叠 |
|---|---|---|---|---|---|---|
| 1400 | 78 | 否 | 705px | 78% | — | 0 |
| 900 | 78 | 否 | 539px | 78% | 3 条 | 0 |
| 530 | 78 | 否 | 369px | 78% | 3 条 | 0 |

今天落在 78% 与手算一致：窗口 `10-30 … 11-22` 共 23 天，11-17 距起点 18 天 → 78.3%。

## 5. 12 个月图表：单排 / 两排切换

切换依据是**图表自身内容宽度**（`useElementWidth` 回调 ref + ResizeObserver），
不是窗口宽度——侧栏折叠、面板内边距都会改变它。

| 内容宽度 | 模式 | 排数 | 每月列宽 | 横向滚动 | 数值标签 |
|---|---|---|---|---|---|
| ≥ 640px | 单排 12 个月 | 1 | 42px 起 | 否 | 12 个月只标每列最大值 |
| < 640px | 两排各 6 个月 | 2 | 等分 | **否** | 每排 6 个月且列宽 ≥56px 时逐柱标，否则只标最大值 |

实测（12 个月）：

| 窗口 | 图表内容宽 | 模式 | 排数 | 月份数 | 横向滚动 | 整页横向溢出 | 两排刻度 |
|---|---|---|---|---|---|---|---|
| 1400 | 1039 | single | 1 | 12 | 否 | 无 | `0/5/10` |
| 900 | 539 | split | 2 | 12 | 否 | 无 | `0/5/10` + `0/5/10` |
| 530 | 369 | split | 2 | 12 | 否 | 无 | `0/5/10` + `0/5/10` |

**两排刻度一致的证据**：`layout-check` 直接比对两排 `.chart-axis` 的刻度文本序列，
必须完全相同；组件测试再验一次跨排比例——两排柱高之比等于数值之比（7:13 → 35%:65%），
不是各自归一化成 100%。

## 6. 截图

| 内容 | 文件 |
|---|---|
| 订单详情排期概览（浅色） | `docs/assets/dev06c-uxfix/orders-detail-light.png` |
| 订单详情排期概览（深色） | `docs/assets/dev06c-uxfix/orders-detail-dark.png` |
| 900px 两排图表 | `docs/assets/dev06c-uxfix/chart-900-two-rows.png` |
| 530px 两排图表 | `docs/assets/dev06c-uxfix/chart-530-two-rows.png` |
| 侧栏新品牌名 | `docs/assets/dev06c-uxfix/brand-name.png` |

均为本机 Chrome（Blink）headless，DPR 2。**不能代替 WKWebView。**

## 7. 用户可见名称修改清单

| 位置 | 现值 |
|---|---|
| 侧栏品牌 | `ArtFlow Desk Core` |
| 退出确认 | `退出 ArtFlow Desk Core 会丢失尚未保存的修改。` |
| QA 横幅 | `ArtFlow Desk Core — QA 测试环境（预置场景）· …` |
| `index.html` | `<title>ArtFlow Desk Core</title>` |
| 运行模式（环境页） | `ArtFlow Desk Core — QA 测试环境 · 预置场景（与正式数据隔离）` |
| `tauri.conf.json` | `productName: ArtFlow Desk Core`，窗口标题同 |
| `tauri.qa.conf.json` | `productName: ArtFlow Desk Core QA`，窗口标题 `ArtFlow Desk Core — QA 测试环境` |
| macOS 菜单 | 应用菜单 `ArtFlow Desk Core`，`退出 ArtFlow Desk Core` |
| Rust 文案 | `environment.rs` / `migrations/mod.rs` / `lock.rs` / `zip_read.rs` / `lib.rs` 共 5 处 |
| `Cargo.toml` `description` | `ArtFlow Desk Core — local-first commission desk …` |
| `README.md` | 标题 + 首段 + 更名说明 |

**未改**：`export.rs` 的 CSV 表头（按裁定保持原样，标记为「待单独裁定」）、
六份图标 SVG 的 `<title>`、`package.json` / `Cargo.toml` 包名、`minidesk` lib 名、
`minidesk-probe`、仓库目录名。

## 8. 内部 identifier 未变的证据

```text
src-tauri/tauri.conf.json      identifier = dev.artflow.minidesk
src-tauri/tauri.qa.conf.json   identifier = dev.artflow.minidesk.qa
~/Library/Application Support/  dev.artflow.minidesk  dev.artflow.minidesk.qa  dev.artflow.minidesk.tv01
```

三个目录与改动前完全一致，**没有新增空白正式目录**。`productName` 只影响 `.app` 与窗口标题，
数据目录由 identifier 派生。

## 9. 正式数据只读指纹（未变）

```text
generation  gen-c00a879220964299af7adcef8b9fc1c5
schema      v3
orders 4   clients 1   stage_templates 2   attachments 2   events 23   completed 4
```

`file:...?mode=ro` 只读查询。未新建测试订单、未动编号高水位、未重建 QA。

## 10. 测试结果

| 检查 | 结果 |
|---|---|
| `npm run layout:check` | **19/19 PASS**（原 18 项 + 排期/图表新断言，阈值未放宽） |
| `npm run test` | **315 passed / 36 files**（本轮 +6） |
| `npx tsc --noEmit` | 干净 |
| `npm run build` | 通过（101ms） |
| `cargo check --all-targets` | 干净 |
| `cargo test` | **291 passed**（本轮改了 Rust 文案，已全量重跑） |

新增/重写的测试：

- `OrdersPage.schedule.test.tsx`（9）：列表无轨道、详情双日期/单侧/空态/终态/风险色/装饰性；
- `StatsPage.chart.test.tsx`（+3）：窄容器两排 6+6 且顺序不乱、两排共刻度且跨排比例正确、
  宽容器仍单排 12 个月；
- `scheduleBar.test.ts` 保持 24 条（`scheduleWindowFor` 由详情测试间接覆盖）。

**两处需要说明的不完美**：

1. `commit bfa1024`（工作包 A）里包含了 B 的 `styles.css` 片段与探针断言——
   单个文件只能整体暂存，无法按 hunk 拆分。因此**单独 checkout 该提交时 `layout:check`
   的图表断言会失败**（那时 StatsPage 还没改）。最终树是绿的。
2. 侧栏品牌下方仍是短标签 `QA 测试环境`，完整名称在 QA 横幅与窗口标题里——
   26px 高度里重复一遍产品名只会挤掉环境信息。

## 11. 尚未完成的实机验收

1. WKWebView 里详情轨道 48px 高度的观感（尤其空心圆与今天竖线是否够清楚）；
2. 两排图表在 Retina 上 9.5px 数值标签的清晰度；
3. 530px 下六列标签 `26-01` 是否仍有余量（Blink 量到不重叠，WKWebView 字体度量可能不同）；
4. **打包后的 `.app` 名称、Finder 显示名、关于面板**——本轮没有产出正式 `.app`，
   按 §D4 不在本轮声称已验收，留到 DEV-08。

## 12. 本地 Git 提交（未推送）

```text
4d60f6b chore(branding): rename visible desktop product to ArtFlow Desk Core
d066dd0 fix(stats): make twelve-month chart responsive without horizontal overflow
bfa1024 fix(ui): move order schedule overview into details
```

## 13. 仍然开放

- **DOCK-01**：Dock 右键退出仍绕过未保存保护，登记保持 OPEN / P1。
  你已口头接受风险，但正式降级需单独书面裁定；本轮未改其状态，未做 unsafe 拦截。
- 运行时 Dock 图标切换：未实施，留给 DEV-08。
- CSV 品牌表头：按裁定保持原样，标记为待单独裁定。
- 建议实机顺序：先看详情轨道 → 再拖窄看两排 → 最后确认侧栏与窗口标题。
