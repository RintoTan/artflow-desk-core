# UI-NAV-ICON-REFINE 结果报告

- 日期：2026-11-17
- 范围：侧边栏七项导航图标整体重绘为「Arctic Line」，替换原齿轮等图标
- 状态：已实现并通过针对性回归；**WKWebView 实机观感待你确认**
- 未触碰：应用品牌图标（Orbit / Layers / Wave A）、主题系统、布局结构、业务逻辑、数据库

---

## 1. 七个图标的设计与实现位置

实现位置：**`src/components/NavIcon.tsx`**（新增）。七个图标共用一套几何描述与一处描边参数，
不再像原来那样把七段 `d` 字符串散落在 `App.tsx` 里。

| # | 导航项 | 造型 | 笔画数 |
|---|---|---|---|
| 1 | 工作台 | 圆角面板 + 一条竖分隔 + 右栏一条横分隔 = 三个区块，表达总览 | 3 |
| 2 | 订单 | 一张圆角卡片 + 两行"文字"（第二行更短），不用剪贴板夹子 | 3 |
| 3 | 客户 | 前方完整人物（头 + 肩弧）+ 右后方略小人物，只保留头与肩 | 4 |
| 4 | 流程模板 | 三个等大节点斜向串联，两段短连线 | 5 |
| 5 | 历史统计 | 三根渐高的圆角柱 + 基线 | 4 |
| 6 | 设置 | 三条横向滑轨 + 三个位置错开的竖向把手（**不再用齿轮**） | 6 |
| 7 | 数据环境 | 数据库柱体：顶部椭圆 + 两条侧边 + 一道中缝，无锁具/盾牌 | 4 |

统一规范（写死在组件里，七个图标一致）：

```text
viewBox 0 0 24 24     内容限制在 3.2–20.8 安全区
stroke 1.8            stroke-linecap: round    stroke-linejoin: round
fill: none            stroke: currentColor
```

三处取舍需要你知道：

1. **流程模板用斜向串联而不是横向三点。** 横向三个等大圆点在 20px 下会被读成省略号「⋯」，
   第一版就是这么画的，截图一看就不对。斜向串联是"一条路径经过三个步骤"，语义更准。
   代价是它也可能被读成"分享/连接"——这是我在七个里最没把握的一个，见 §6。
2. **历史统计没有单独的折线。** 你写的是"柱形与简短趋势线的组合"，但 20px 下，
   折线要么压在柱子上（糊），要么浮在柱子上方 2px（会被当成两根无关的图形）。
   柱高本身已经承担了趋势语义，所以只留柱形 + 基线。**如果你坚持要折线，我加一行即可**，但会牺牲清晰度。
3. **设置用竖向把手而不是圆形旋钮。** 圆旋钮压在轨道上必须给轨道留缺口，20px 下那 1.4px 的缺口
   会先糊掉；竖向把手与圆头端点同构，一眼就是"滑杆"。

线宽说明：1.8 是 **24 网格里的单位**，在 20px 显示时实际约 1.5px。如果你在 Retina 上觉得偏细，
把 `strokeWidth` 改成 2.0 即可（七个图标同时变，不会失衡）。

## 2. 改动文件

| 文件 | 改动 |
|---|---|
| `src/components/NavIcon.tsx` | **新增**：七个图标的几何数据 + 统一渲染器 |
| `src/components/NavIcon.test.tsx` | **新增**：17 条规则守卫 |
| `src/App.tsx` | 删掉本地 `ICON_PATHS` 与内联 `NavIcon`（−40 行），改为引用组件 |
| `scripts/layout-probe.mjs` | 探针加 `PROBE_DSF` / `PROBE_CLIP`（高清与局部截图用） |
| `docs/assets/ui-nav-icon/*.png` | 三张审查截图 |

**没有改动**：`src/styles.css`（`.nav-item` / `.nav-icon-box` / 行列结构一行未动）、
`src-tauri/**`、`lib/theme.ts`、`lib/appIcon.ts`、`bridge/commands.ts`、任何路由与选中逻辑。

## 3. 截图

| 状态 | 文件 |
|---|---|
| 浅色 + 展开（选中「设置」） | `docs/assets/ui-nav-icon/nav-light-expanded.png` |
| 深色 + 展开（选中「订单」） | `docs/assets/ui-nav-icon/nav-dark-expanded.png` |
| 折叠态（深色） | `docs/assets/ui-nav-icon/nav-collapsed.png` |

渲染环境：本机 Chrome（Blink）headless，设备像素比 2，裁切到侧栏区域。
**这是 Blink，不是 WKWebView**：字重、抗锯齿、亚像素对齐会有差异，最终观感仍需你在 Mac 上看。

## 4. 实际测试结果

| 检查 | 结果 |
|---|---|
| `npm run layout:check` | **13/13 PASS**（未改动断言，全部沿用） |
| `npm run test` | **254 passed / 31 files**（本轮 +17） |
| `npx tsc --noEmit` | 干净 |
| `npm run build` | 通过（101ms） |
| Rust | **未运行**：本轮没有改 Rust，测试与迁移都未触及 |

新增的 17 条测试（`src/components/NavIcon.test.tsx`）：

- 七个名称就是七个，不多不少；
- 每个图标都是 `viewBox 0 0 24 24` + `stroke-width 1.8` + round 端点 + `fill: none` + `currentColor`；
- 每个图标**不得**出现 `defs / linearGradient / radialGradient / filter / image / use`（挡住渐变与位图混入）；
- 每个图标至少 3 条笔画（20px 下不至于糊）；
- 所有绝对锚点落在 2.5–21.5 安全区内（几何越界会失败）；
- `aria-hidden="true"` + `focusable="false"`（纯装饰，可访问名由导航文字提供）。

## 5. DEV-06B 布局回归检查

本轮**没有改** `.nav-item`、`.nav-icon-box`、`.nav-icon` 的任何 CSS，也没有改行高、侧栏宽度或 grid 列。
`layout:check` 的读数与改动前逐项相同：

```text
7 项导航：命中区 44×44，图标盒偏移 (0, 0)，文字起点全部 62px，行高全部 44px
折叠态：7 项 boxOffsetX = 0、boxOffsetY = 0
折叠按钮：44px 高，紧贴版本区上方 4px
1400×400：导航 189/324px 自行滚动，按钮 289–333，版本区底 384（仍在窗口内）
900 / 530：列表与详情无重叠、无横向溢出
```

七项路由与选中逻辑未动：`NAV` 数组的 `to` / `label` / `end` 一行未改，
`NavLink` 的 `aria-label={item.label}` 与 `title` 保留，折叠后仍有可访问名。

## 6. 需要你看一眼再决定的两点

1. **流程模板**是七个里隐喻最弱的一个（可能被读成"分享/连接"）。
   如果你不满意，我可以换成"三个横向步骤块 + 连接线"，或"纵向步骤条"，两者我都有现成几何。
2. **设置的手感**：把手把轨道切成三段视觉，比齿轮轻盈很多；如果你希望把手更粗或更短，改两个数字即可。

其余五个（工作台、订单、客户、历史统计、数据环境）我按"一眼能认出来"的标准验收过。

## 7. 正式数据只读指纹（未变）

```text
generation  gen-c00a879220964299af7adcef8b9fc1c5
schema      v3
orders 4   clients 1   stage_templates 2   attachments 2   events 23   completed 4
```

`file:...?mode=ro` 只读查询。未写正式库、未清空 QA、未推送远程。

## 8. 本地 Git 提交（未推送）

```text
b0d566f feat(nav): redraw the seven sidebar icons as one Arctic Line set
（含三张审查截图；本轮没有 Rust 与业务逻辑改动）
```

## 9. 最短实机验收

1. 打开应用，看侧边栏七项：**没有齿轮**，第三个是滑杆。
2. 点「设置」看选中态：图标与文字同时变强调色，图标不歪。
3. 点「折叠」：七个图标应各自居中在 44×44 方格内，左右留白相等。
4. 切到深色：图标应为浅色线条，不出现灰糊。
5. 展开、缩小窗口到约 900px 与 530px：导航行为应与之前一致。
