# DEV-06B-ICON-02 结果报告

- 日期：2026-11-17
- 范围：三套应用图标的浅色 / 深色两版 + 跟随主题自动切换
- 状态：六份资源与联动逻辑已实现并通过自动化；**WKWebView 实际观感仍 NOT VERIFIED**，等你实机确认
- 未做：Dock 运行时图标（本轮不授权，`DEV06A-DOCK-01` 保持 OPEN）

---

## 1. 六份 SVG 清单

全部由 `scripts/make-icon-variants.mjs` 从三份原始文件派生。脚本在写文件前会做一次硬校验：
把色值抠掉之后，变体与原始文件必须**逐字节相同**，否则直接报错退出——所以"只改了颜色"不是承诺，是每次生成都被强制检查的条件。

| 文件 | sha256（前 16 位） | 字节 |
|---|---|---|
| `orbit.svg`（原始，未改） | `5218e4f5c709ab74` | 1449 |
| `orbit-light.svg` | `2d62c562dc421174` | 1449 |
| `orbit-dark.svg` | `844f8ffe2fa7c09b` | 1449 |
| `layers.svg`（原始，未改） | `05db6057b2c8ca89` | 1654 |
| `layers-light.svg` | `75094dac4027aa68` | 1654 |
| `layers-dark.svg` | `7ec04fb4604436e7` | 1654 |
| `wave-a.svg`（原始，未改） | `93507b45a060d08f` | 1456 |
| `wave-a-light.svg` | `2023c140821b0b0a` | 1456 |
| `wave-a-dark.svg` | `c81035da03a0de2a` | 1456 |

同尺寸字节数完全相同，也侧面印证了结构没变（只换了 7 位色值字面量）。

原始三份保留不动，作为追溯来源；命名保持你给的 `-light` / `-dark` 后缀。

## 2. 明暗配色方案

浅色基准：Arctic Blue（`--bg #F5F8FC`、强调色 `#2C6FB5`）。
深色基准：miniDesk 深色主题（`--bg #0F151B`、`--sidebar-bg #1A232D`、`--surface #182028`）。

### Orbit

| 角色 | 原始 | 浅色 | 深色 |
|---|---|---|---|
| 背景渐变 | `#E5F4FF` → `#CFE9FC` | `#EFF7FF` → `#D8ECFB` | `#1B2836` → `#111A22` |
| 轨道 A | `#3178CA` → `#64B5EC` → `#A0DFFD` | `#2A6BB8` → `#4F9FDD` → `#6FB3E0` | `#6FB3EE` → `#8FCBF7` → `#BFE6FF` |
| 轨道 B | `#A084F5` → `#B1A9F7` → `#7FB8F6` | `#8E6FE8` → `#9E93F0` → `#5E97D8` | `#B9A6FF` → `#C8BDFF` → `#9FCDFB` |
| 星形 | `#154583` → `#3169BA` | `#113A6E` → `#2A5CA6` | `#E8F2FF` → `#BFD9F6` |

深色版把星形反过来做成亮色：原图星形是"深色点缀"，在深色底上会消失。

### Layers

| 角色 | 原始 | 浅色 | 深色 |
|---|---|---|---|
| 背景渐变 | `#183B67` → `#102749` | `#E9F3FD` → `#D5E7F8` | `#1B3556` → `#132A48` |
| 六边形线框 | `#B2D9FD` | `#5C8CBC` | `#A8D2F7` |
| 顶层（原为近白） | `#FAFEFF` → `#C9E2FF` | `#4A86C0` → `#3E7AB8` | `#FBFEFF` → `#CEE5FF` |
| 中层 | `#C8B6FF` → `#8D9DEB` | `#6A62BC` → `#5A6FB8` | `#CFBEFF` → `#94A3F0` |
| 底层 | `#6BC9F5` → `#76A9ED` | `#2F6E9E` → `#265C88` | `#74D0F7` → `#7FB2F2` |
| 节点 | 填充 `#F8FCFF` / 描边 `#D4EEFF` | `#4A79B0` / `#FFFFFF` | 同原始 |

浅色版把"顶层最亮"改成"顶层中间调、底层最深"：浅底上没法保留一块近白菱形，
只能靠**明度阶梯**维持三层可分（顶 `#4A86C0` > 中 `#6A62BC` > 底 `#2F6E9E`，对比底色均 ≥ 3:1）。
六边形线框在原图是浅蓝，浅底上几乎看不见，因此单独加深到 `#5C8CBC`。

### Wave A

| 角色 | 原始 | 浅色 | 深色 |
|---|---|---|---|
| 背景渐变 | `#1D4674` → `#112B4F` | `#E9F2FC` → `#D4E6F8` | `#204B7A` → `#122E52` |
| 左笔画 | `#8CDCFB` → `#F0FBFF` | `#2E7BC0` → `#1D4F86` | `#9FE2FD` → `#F2FCFF` |
| 右笔画 | `#79C4FA` → `#B2A9FF` | `#3E86CE` → `#6F63C0` | `#84CBFB` → `#B9B0FF` |
| 波浪线 | `#FCFCFF` → `#ABCCFF` → `#CDB7FF` | `#2F6FAE` → `#5B8FC8` → `#7A6BC4` | 同原始 |
| 端点圆（2 处） | `#F9FCFF` | `#1F4E7E` | 同原始 |

浅色版的端点圆改成深蓝：原图是白色圆点，浅底上等于没有；**只改了 fill 的值，没有加 stroke 或改半径**。

## 3. 主题联动机制

```text
theme 模块（唯一的状态源）
  ├─ saved  / preview（setPreview、clearPreview、persistTheme）
  ├─ systemPrefersDark()（唯一一处 matchMedia 监听）
  └─ subscribeTheme(listener)  ← 预览、保存、放弃、系统切换都走这一条 notify
        │
        ├── useAppearance()  →  resolveTheme(currentChoice().mode, systemPrefersDark())
        └── App / SettingsPage → <AppIconImage appearance={...} />
```

- **没有第二套监听器**：`useAppearance()` 直接复用 `subscribeTheme`，`useSyncExternalStore` 只在主题 store 通知时重算一次。
- **用预览状态而不是已保存模式**：`currentChoice()` 返回 `preview ?? saved`，所以点「深色」按钮（未保存）图标立刻变深色；点「放弃修改」`clearPreview()` 之后自动回到浅色。
- **跟随系统**：`mode === "system"` 时 `resolveTheme` 读 `systemPrefersDark()`；系统切换会触发 theme 的 notify，图标随之更新。
- **手动指定不受系统影响**：`mode` 是 `arctic` / `dark` 时根本不读 `prefersDark`（`resolveTheme` 里就短路了），所以系统换外观不会改动图标明暗。
- **不写库**：图标与主题的联动完全在渲染层，`ui.icon_variant` 只在点「保存设置」时写一次，主题变化不触发任何 `invoke`。

持久化的仍然只有 `orbit | layers | wave-a` 一个键，没有新字段，schema 仍是 v3。

## 4. 界面

- 三张卡仍在，主图跟随**当前生效外观**；
- 卡内新增一组静态对照：`[浅色缩略] 浅色 [深色缩略] 深色`，只做展示，不构成第二套设置开关；
- 「32px 实际大小」一行也跟随当前外观；
- 保存 / 放弃 / 恢复默认 / 未保存草稿保护全部沿用上一轮逻辑，没有新增状态；
- Dock 提示文字保留，并明确写「应用内 Logo 会根据选择和主题变化，Dock 与 Finder 中的图标不随此设置变化」。

## 5. PNG 生成结果

`scripts/build-app-icons.mjs` 现在扫 9 份 SVG（3 原始 + 6 变体）× 4 个尺寸 = **36 张 PNG**：

```text
src/assets/app-icons/png/
  orbit-{1024,256,64,32}.png          ← 原始（安装包图标来源）
  orbit-light-…  orbit-dark-…
  layers-…       layers-light-…  layers-dark-…
  wave-a-…       wave-a-light-…  wave-a-dark-…
```

- 全部由无头 Chrome 按页面坐标精确截图，透明背景；
- **安装包图标没有改动**：`icon.png` / `icon.icns` / `icon.ico` 仍取自原始 `orbit.svg`（`BUILD_ICON_SOURCE`），
  静态图标的最终策略按你说的留给 DEV-08；
- `--only=svg` 只出 PNG，`--only=icons` 才重建安装包图标，避免误改。

## 6. 32px 可读性

把 36 张里的 6 张 32px 按"原尺寸 + 4 倍像素放大"并排看过：

| 项 | 结论 |
|---|---|
| Orbit 浅色细线 | 轨道末端原来偏淡，已压深（`#A0DFFD→#6FB3E0`、`#7FB8F6→#5E97D8`），32px 下能看出双轨道交叉 |
| Orbit 深色轨道 | 与 `#1B2836` 背景分离清楚，是六份里可读性最好的一组 |
| Layers 浅色六边形线框 | 初版 `#6F9CC8` 偏淡，已加深到 `#5C8CBC`；三层菱形改明度阶梯后不再糊成一团 |
| Wave A 浅色字母 | 浅底上改用深蓝渐变，字母与波浪线都清楚 |

仍然是最弱的两个组合：**Layers 浅色**在 32px 下细节最多、**Orbit 浅色**对比度最低。
这是原始设计（细轨道、细线框）在 32px 的固有代价，我没有改线宽，只调了颜色。
Dock / Finder 里实际多大由系统决定，需要在实机看。

## 7. 回归结果

| 检查 | 结果 | 证据级别 |
|---|---|---|
| `npm run test` | **237 passed / 30 files**（本轮 +15） | 功能 |
| `cargo test` | **291 passed**（Rust 本轮无改动） | 功能 |
| `npm run layout:check` | **13/13 PASS** | 真实几何（Blink） |
| `npx tsc --noEmit` | 干净 | 类型 |
| `npm run build` | 通过（99ms） | 构建 |

新增/扩展的测试：

- `src/lib/appIcon.test.ts`（15）：六份资源互不相同、各自含真实 `<title>` 指纹、无外链/无 `<script>`、
  浅深两版背景亮度方向正确（防写反）、**同变体两版的 path/radius 数据完全一致**、
  非法标识在两种外观下都回退 orbit、预览切换外观不写库。
- `src/components/AppIconImage.test.tsx`（4）：取图正确、装饰性 `aria-hidden`、
  加载失败回退到**同一外观**的 Orbit（不能串色）、换外观后重试。
- `src/App.icon.test.tsx`（7，+4）：深色主题用深色版、主题预览立刻换图且不写库、
  跟随系统时系统切换同步换图、手动主题下系统变化不影响图标。
- `src/pages/SettingsPage.icon.test.tsx`（10，+2）：卡片主图跟随明暗、放弃草稿回浅色、
  每张卡有浅/深两个静态对照、主题模式仍只有一组三个按钮。

原有主题与图标保存逻辑全部照旧通过（`App.theme.test.tsx`、`SettingsPage.theme.test.tsx` 未改动）。

## 8. 正式数据指纹（未变）

```text
generation  gen-c00a879220964299af7adcef8b9fc1c5
schema      v3
orders 4   clients 1   stage_templates 2   attachments 2   events 23   completed 4
app_settings 中 ui.icon_variant 行数：0（本轮从未写入正式库）
```

只读查询（`file:...?mode=ro`）。QA 未重建，Seeded/Clean 未清空，未推送远程，未进入 DEV-06C。

## 9. 本地 Git 提交（未推送）

```text
（提交后补）
```

## 10. 最短 macOS 实机验收

1. 打开应用 → 设置 → 外观：三张卡应显示**浅色**版（当前是 Arctic Blue）。
2. 点「深色」按钮（**不要**点保存）：三张卡的主图、卡内「深色」缩略图、32px 那一行、
   以及左上角品牌图标，应**同时**变成深色版。
3. 点「放弃修改」：全部回到浅色版。
4. 点「跟随系统」→ 保存；然后在系统设置里切换「外观 浅色 / 深色」：
   整个应用与品牌图标应一起跟随，不需要重启。
5. 再把主题改成「Arctic Blue」→ 保存；重复第 4 步的系统切换：
   界面与图标**都不应**改变。
6. 深色状态下选 Wave A → 保存 → 重启：品牌图标应仍是深色版 Wave A。
7. 看一眼 32px：Layers 浅色与 Orbit 浅色是最弱的两个，确认你能接受。

任何一步不符，把截图和步号发回来即可。
