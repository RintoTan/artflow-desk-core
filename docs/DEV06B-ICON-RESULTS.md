# DEV-06B-ICON 结果报告

- 日期：2026-11-17
- 范围：三套 SVG 应用图标、设置页切换、品牌元素同步、Dock 图标可行性调查
- 状态：**应用内图标切换已实现并通过自动化**；macOS Dock 图标 **未实施**（需要未获授权的
  unsafe 原生桥接），界面已明确标示这一点；像素观感仍 **NOT VERIFIED**，等你 Mac 实机确认

---

## 1. 素材目录

三套 SVG 原样放入，**没有重新生成、没有改设计**，逐字节与源文件一致：

```text
src/assets/app-icons/
  orbit.svg     5218e4f5c709ab74be47d5df40a931a7dee77c353eb3b526256a7641a652db57
  layers.svg    05db6057b2c8ca89294935d29c40d59a2963c607a9cc2179ee8526f5ef69b84e
  wave-a.svg    93507b45a060d08f175ac98847331206c6a723710ba229458aa404f368780747
```

（上面是 `shasum -a 256` 的结果，与 `~/Desktop/artflow-*.svg` 完全一致。）

`orbit.svg` / `layers.svg` / `wave-a.svg` 都检查过：单一 `<svg>` 根节点、无 `<image>`、
无 `@font-face`、无 `xlink:href`、除 `xmlns` 命名空间外没有任何外链。
三套文件里都有 `id="bg"` 这类同名渐变，因此**只能以 `<img src>` 引用，不能内联进同一个文档**
（内联会让 `url(#bg)` 互相串台）。

PNG：你提到的 1024/256/64/32 位图在桌面上没有随 SVG 一起出现，所以我用同一份 SVG
**按尺寸栅格化**（不是重画）：

```text
src/assets/app-icons/png/{orbit,layers,wave-a}-{1024,256,64,32}.png
```

栅格化脚本 `scripts/build-app-icons.mjs`：无头 Chrome 按页面坐标精确截图，
背景设成全透明，圆角之外不带白底。

## 2. 设置行为

### 2.1 存储

| 项 | 值 |
|---|---|
| 键 | `app_settings.ui.icon_variant` |
| 合法值 | `orbit` / `layers` / `wave-a`（稳定标识，不是展示名） |
| 默认 | `orbit` |
| schema | **不变**，仍是 v3；只写 `app_settings` 一行 |

后端 `src-tauri/src/commands/app_icon.rs`：

- `ui_icon_get` → `{ variant, storedVariant, defaultVariant }`
- `ui_icon_set(variant)` → 只接受三个标识，其它一律 `INVALID`，**不写任何东西**
- 库里值损坏（如 `orbit-2024`）→ 读出 `orbit`，但 `storedVariant` 保留原值，且**不回写**
- 键缺失（旧版本）→ 读 `orbit`，同样不写

命令面从 48 条增加到 50 条，`tests/commands.rs` 白名单已同步（该清单是独立维护的，
不从注册列表自动生成）。

### 2.2 界面

「设置 → 外观 → 应用图标」：

- 三张预览卡，用真实 SVG（`<img src>`）而不是近似替代图，显示图标、名称、副标题；
- 选中卡显示 `已保存` 或 `未保存` 两种状态；
- 点卡片立刻预览：左上角品牌图标当场跟着换（`useSyncExternalStore` + 模块级 store）；
- 与主题共用同一条保存链路：「保存设置」才写库，「放弃修改」清预览，
  另设「恢复默认图标」把草稿改回 Orbit（仍需要保存才生效）；
- 三个草稿（主题 / 图标 / 时区）都会进离页保护，标签按实际改动动态拼出来
  （为此把 `useUnsavedGuard` 的 `label` 扩展成 `string | (() => string)`，
  之前它把标签冻结在挂载那一刻，保存掉主题后提示里仍写着「主题」）；
- 32px 实际大小预览一行，方便肉眼判断小尺寸辨识度。

### 2.3 品牌元素

只改**品牌图形**本身：`.brand-mark` 从「CSS 渐变方块」换成真实 SVG。
原来的 `background: linear-gradient(...)` + `border-radius` + 矩形内阴影已移除——
那会在一张自带圆角与渐变的图下面再画一个方角；现在只用 `filter: drop-shadow()`
（跟随 alpha，不盖住圆角）。

图标颜色与主题完全解耦：它是一个 `<img>`，不参与任何 token 计算，
所以订单状态色、错误提示色、强调色都不受影响（`styles.layout.test.ts` 里
有对应守卫，`App.theme.test.tsx` 继续通过）。

其它位置：全工程只有侧栏这一处渲染 Logo（`grep miniDesk` 只找到品牌文字与窗口标题）。

## 3. 测试结果

| 检查 | 结果 | 证据级别 |
|---|---|---|
| `npm run test` | **222 passed / 29 files**（本轮 +23） | 功能 |
| `cargo test` | **291 passed**（本轮 +9） | 功能 |
| `cargo check --all-targets` | 干净 | 编译 |
| `npx tsc --noEmit` | 干净 | 类型 |
| `npm run build` | 通过（105ms） | 构建 |

新增测试：

- `src-tauri/tests/app_icon.rs`（6）：缺键读 orbit 且不写库、选择后重开仍在、
  坏值回退但不改写、非法值被拒且无残留、不影响主题/时区、不动 schema 版本。
- `src-tauri/src/commands/app_icon.rs` 单元测试（3）：归一化、默认值钉死。
- `src/lib/appIcon.test.ts`（10）：归一化、默认值、预览不写库、保存失败保留预览、
  放弃回退、订阅通知；**素材指纹**——解析 data URI 后要求包含
  `ArtFlow miniDesk — Orbit/Layers/Wave A` 且不含外链，占位图会被这条挡下。
- `src/pages/SettingsPage.icon.test.tsx`（8）：三卡渲染与默认选中、点卡只预览、
  保存写库、放弃回退、恢复默认、保存失败提示、主题+图标同时成草稿、Dock 声明可见。
- `src/App.icon.test.tsx`（3）：启动按已保存变体渲染品牌图标、预览立刻反映、
  读取失败回退 Orbit 且界面照常。
- `src/styles.layout.test.ts`（+2）：品牌图标不再叠背景/圆角、卡片选中态不改尺寸。

### 3.1 32px 辨识度

用 32px 实际像素放大 4 倍（`image-rendering: pixelated`）核对：三套都还认得出
（Orbit 的双轨道、Layers 的六边形层叠、Wave A 的字母 A）。
需要说明的是 **Orbit 在 32px 下对比度最低**——浅蓝底 + 细轨道，缩到 32px 时轮廓偏淡；
Layers 与 Wave A 的深底在这种情况下更稳。这是设计本身的取舍，我没有改动它。

### 3.2 实机渲染

设置了页面在无头 Chrome（Blink）里截了两张：

- 浅色 / 侧栏展开：三张卡片一行排开，选中态为强调色描边 + 浅底，「已保存」在卡内；
- 深色 / 侧栏折叠：卡片底色走 `--surface` 与 `--accent-soft`，文字可读。

**Blink 不等于 WKWebView**，实际字号、卡片密度、SVG 渐变在 WKWebView 里的观感仍需你确认。

## 4. macOS Dock 图标：可行性结论（未实施）

### 4.1 官方 API 是存在的

`-[NSApplication setApplicationIconImage:]`（Swift 是 `NSApplication.shared.applicationIconImage`）
是 AppKit 的公开接口，可以更新**运行中进程**的 Dock 磁贴，传 `nil` 恢复安装包自带图标。
它要求主线程调用，参数是 `NSImage`。

### 4.2 但当前技术栈里没有安全通道

按源码核实（不是凭印象）：

| 事实 | 证据 |
|---|---|
| `tao 0.37.2` 在 macOS 上**忽略**窗口图标 | `src/platform_impl/macos/window.rs:1367` `fn set_window_icon(&self, _icon)` 函数体只有注释「macOS doesn't have window icons」 |
| `tauri 2.12.5` 没有 Dock 图标 API | 全仓 `rg "applicationIconImage\|dock_icon"` 无匹配；`set_dock_visibility` 只控制显示/隐藏 |
| 因此 `window.setIcon()` 在 macOS 上是**静默空操作** | 同上——它不会报错，也不会改 Dock，这正是你要求「不能拿它当证据」的原因 |

要走通只能在 Rust 侧 `objc2` + `msg_send!` 调 `setApplicationIconImage:`，
这是 **unsafe 原生桥接**，按本轮约束需要你单独授权，所以**没有实施**。

### 4.3 如果授权，实施范围与风险

范围（预计）：

1. 新增一个只做一件事的内部模块 `infra/dock_icon.rs`，暴露
   `fn set_dock_icon(png_bytes: &[u8]) -> Result<()>`，内部用 `NSData` + `NSImage::initWithData`；
2. 通过 `AppHandle::run_on_main_thread` 保证在主线程执行，命令本身仍在工作线程；
3. 命令 `ui_icon_dock_apply`（第 51 条命令）只在保存成功后调用；
4. 启动时若已保存变体 ≠ orbit，重新应用一次（运行时图标不持久化到安装包）。

风险：

- **unsafe ABI**：`msg_send!` 的选择器与类型签名没有编译期校验，写错是未定义行为；
- **线程**：AppKit 对象必须在主线程创建与使用，跨线程会崩；
- **内存**：`NSImage`/`NSData` 的生命周期要靠 `Retained` 管理，漏了就是野指针或泄漏；
- **失败是静默的**：`setApplicationIconImage:` 无返回值，失败通常表现为「没反应」，
  只能靠「设置后重新读回 `applicationIconImage` 比对」来判定，这本身又是一次 unsafe；
- **重启会丢**：运行时 Icon 不写入 `.app`，每次启动必须重新应用；
- **测试无法自动化**：CI 里没有 Dock，任何自动断言都只能证明「函数没崩」，
  不能证明「Dock 真的换了」——最终只能靠你实机看；
- **与 Finder 图标是两件事**：Dock 磁贴变了，Finder / 启动台里 `.app` 的图标仍然是
  安装包里的 `icon.icns`，用户很容易以为没生效。

我的建议：**先不做**。它只影响「Dock 里那个小图」这一件事，
而它和本轮只是同一个偏好的不同落点。建议放到 DEV-08 打包阶段一并处理，
那时才有真实的 `.app` 可以验证「磁贴 / Finder / 重启后」三处是否一致。
如果你仍希望现在做，我需要一句明确授权（unsafe + 主线程 + 只能人工验收），我再按上面 4 步实现。

**另外：`DEV06A-DOCK-01`（Dock 右键「退出」绕过未保存保护）与本项无关，保持 OPEN / P1。**
图标切换没有、也不会把它标成已修复。

## 5. Windows 与安装包

- 构建时图标固定为 **Orbit**，已重新生成：
  - `src-tauri/icons/icon.png`（1024，RGBA）
  - `src-tauri/icons/icon.icns`（`iconutil` 从 iconset 生成，10 个尺寸）
  - `src-tauri/icons/icon.ico`（16/24/32/48/64/128/256，PNG 条目，`file` 已确认 7 个图标）
- 三套 SVG → PNG / ICNS / ICO 的生成流程已固化为 `node scripts/build-app-icons.mjs`
  （`--only=svg` 只出 PNG，`--only=icons` 只重建安装包图标）。
- **不声称 Windows 能实时换图标**：Windows 需要 `WM_SETICON` / 任务栏刷新，
  且安装包图标由资源文件在链接期确定；本轮只预留了资源生成，没有实现也没有验证。
- 正式打包与双平台验收仍属于 DEV-08 / DEV-09。

## 6. 正式数据指纹（未变）

```text
generation  gen-c00a879220964299af7adcef8b9fc1c5
schema      v3
orders      4      clients 1     stage_templates 2
attachments 2      events  23    completed 4
app_settings 里不存在 ui.icon_variant（本轮从未写入正式库）
```

只读查询（`file:...?mode=ro`）核对。QA 数据未重建，正式订单未改动。

## 7. 本地 Git 提交（未推送）

```text
0cfcccc docs: DEV-06B icon report with Dock feasibility note and open items
179b63a feat(ui): pick between three app icons, preview then save
67c92de assets: three supplied SVG icons, rasterised PNGs and Orbit build icons
```

## 8. 下一轮最短实机验收流程

1. 打开应用 → 设置 → 外观，确认三张图标卡都在、Orbit 标着「已保存」。
2. 点「Layers」：**左上角品牌图标应立刻变**，但「已保存」标记消失，按钮变可点。
3. 点「放弃修改」：图标回到 Orbit。
4. 再点「Wave A」→「保存设置」→ 提示「设置已保存。」，卡片显示「已保存」。
5. 退出并重新打开：左上角应仍是 Wave A（Dock 图标**不会**变，这是预期）。
6. 点「恢复默认图标」→ 卡片回到 Orbit（此时应显示「未保存」）→ 保存。
7. 在 32px 预览行里看三套小图：确认 Orbit 在小尺寸下是否还能接受。

任何一项不符，把截图和「第几步」发回来即可。
