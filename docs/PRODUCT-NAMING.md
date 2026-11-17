# 产品命名决策与改名清单

- 决策日期：2026-11-17
- 状态：**命名已确认；工程展示名称尚未更新**（按 §5 排到"下一次低风险界面维护"）
- 本轮动作：只归档决策 + 把改名清单落到文件:行，**没有改任何代码或配置**

---

## 1. 命名结论

| 产品 | 名称 | 定位 | 平台 |
|---|---|---|---|
| 本仓库（桌面客户端） | **ArtFlow Desk Core** | 本地离线委托管理客户端 | macOS，后续 Windows |
| Web 项目（另一个仓库） | **ArtFlow Desk** | Web 端接稿、公开展示与订单管理 | Web |

两个产品同属一个品牌家族，但**工程、数据、发布流程保持独立**。

原名对应关系：`ArtFlow miniDesk` → `ArtFlow Desk Core`；`ArtFlowDesk`（Web）→ `ArtFlow Desk`。

视觉品牌（Orbit / Layers / Wave A 六份 SVG、Arctic Blue、Arctic Line 导航图标）沿用，
本次不重做任何品牌图形。

## 2. 为什么这一轮不动代码

DEV-06C 刚收尾，命名属于"展示文案"而非功能。§5 已明确把它排到下一次低风险界面维护，
所以本轮只产出这份可执行的清单，避免在功能轮里顺手改字符串、把验收面搅乱。

## 3. 内部身份：冻结，不随改名变动

这些是"应用身份"，不是"品牌名称"。改动它们会改变数据落点或破坏兼容：

| 项 | 当前值 | 为什么不能动 |
|---|---|---|
| Tauri identifier | `dev.artflow.minidesk` | **数据目录就是由它派生的**：`~/Library/Application Support/dev.artflow.minidesk/`。改了 = 新目录 = 用户看到空台账 |
| QA identifier | `dev.artflow.minidesk.qa` | 同上，QA 数据在 `…/dev.artflow.minidesk.qa/`；且 `tauri.qa.conf.json` 的 assetProtocol scope 用 `$APPDATA` 指向它 |
| 数据目录布局 | `generations/gen-<uuid>/database.sqlite`、`state/active.json`、`state/highwater.sqlite`、`environment.json` | 代际机制与编号高水位都在里面，重建等于清空历史 |
| SQLite schema | v3 | 改名不涉及迁移 |
| 订单编号格式 | `AF-YYYY-NNNN` + 高水位 | 高水位在数据目录里，不是配置项 |
| Seeded / Clean 隔离 | 独立 identifier + `.qa-root` 标记 + 反向守卫 | 动 identifier 会让守卫失效 |
| 已保存设置 | `app_settings`（主题、强调色、图标变体、时区） | 跟着数据库走，不动就还在 |
| 附件引用 | 相对路径 + 代际目录 | 同上 |

结论：**只改"人类读到的字符串"，不碰 identifier、目录、schema。**

## 4. 待改的用户可见名称（逐项）

按"一次低风险维护"能做完的顺序排列。

### 第一批：纯展示，零数据风险

| # | 位置 | 现值 | 改法 |
|---|---|---|---|
| 1 | `src/App.tsx:291` 品牌名 | `<strong>ArtFlow miniDesk</strong>` | → `ArtFlow Desk Core` |
| 2 | `index.html:6` 文档标题 | `ArtFlow miniDesk` | → `ArtFlow Desk Core` |
| 3 | `src-tauri/tauri.conf.json:3` `productName` | `ArtFlow miniDesk` | → `ArtFlow Desk Core`（决定 `.app` 名与 Finder 显示名） |
| 4 | `src-tauri/tauri.conf.json:15` 窗口标题 | `ArtFlow miniDesk` | → `ArtFlow Desk Core` |
| 5 | `src-tauri/tauri.qa.conf.json:3` `productName` | `ArtFlow miniDesk QA` | → `ArtFlow Desk Core QA`（安装包名，避免两个 .app 撞名） |
| 6 | `src-tauri/tauri.qa.conf.json:14` 窗口标题 | `ArtFlow miniDesk — QA 测试环境` | → `ArtFlow Desk Core — QA 测试环境`（§3 建议值） |
| 7 | `src/App.tsx:352` QA 横幅 | `QA 测试环境（预置场景）…` | 文案里补品牌：`ArtFlow Desk Core — QA 测试环境（预置场景）` |
| 8 | `src/pages/StatusPage.tsx:64` | `QA 测试环境 · …` | 同上风格 |
| 9 | `src-tauri/src/infra/menu.rs:30` | `退出 ArtFlow miniDesk` | → `退出 ArtFlow Desk Core` |
| 10 | `src-tauri/src/infra/menu.rs:34` | 应用子菜单标题 `ArtFlow miniDesk` | → `ArtFlow Desk Core`（macOS 打包后由 CFBundleName 覆盖，dev 下用这个） |

注：应用「关于」面板用的是 `PredefinedMenuItem::about`，名字取自 bundle，改 `productName` 即自动跟随，不用单独写。

### 第二批：错误与提示文案（在 Rust 里，需要一起改并重跑相关测试）

| # | 位置 | 现值片段 |
|---|---|---|
| 11 | `src-tauri/src/store/environment.rs:175` | 「请使用较新版本的 ArtFlow miniDesk」 |
| 12 | `src-tauri/src/store/migrations/mod.rs:56` | 「请使用较新版本的 ArtFlow miniDesk」 |
| 13 | `src-tauri/src/infra/lock.rs:44` | 「另一个 ArtFlow miniDesk 进程正在使用这个数据目录」 |
| 14 | `src-tauri/src/backup/zip_read.rs:207` | 「不是 ArtFlow miniDesk 的备份包」 |
| 15 | `src-tauri/src/lib.rs:166` | `.expect("ArtFlow miniDesk 启动失败")` |
| 16 | `src-tauri/src/domain/export.rs:78` | CSV 表头 `ArtFlow miniDesk 统计汇总` —— **见 §5.1，单独裁定** |

### 第三批：文档与注释

| # | 位置 | 处理 |
|---|---|---|
| 17 | `README.md:1` 标题、`DEV-CONVENTIONS.md`、`docs/*.md` 正文 | 改标题与首段，历史报告**保持原样**（它们记录的是当时的名称） |
| 18 | `src-tauri/src/lib.rs:1` 模块注释、`scripts/make-icon-variants.mjs` 注释 | 顺手改，无风险 |
| 19 | `src-tauri/Cargo.toml:4` `description` | 可改；**包名不改**（见 §5.2） |

## 5. 四项需要你裁定的边界

### 5.1 CSV 表头要不要跟着改

`domain/export.rs` 的汇总表头写的是 `ArtFlow miniDesk 统计汇总`。这是**导出文件的内容**，
DEV-06C 刚把"CSV 字段、编码、转义、防注入"冻结为不可变契约。

两个选择：

- **A. 不改**：导出文件的列结构不变，只留一个已经过时的品牌串在表头里；
- **B. 改**：更像"完成标准"，但属于**契约变更**，需要你明确授权，并接受"新旧导出文件的表头不同"。

我倾向 B，但必须由你点头 —— 我不会在"改名"的名义下偷偷改导出内容。

### 5.2 `package.json` / `Cargo.toml` 的包名要不要改

`artflow-minidesk`（npm）、`artflow-minidesk`（cargo package）、`minidesk`（lib 名）、
`minidesk-probe`（额外二进制）。改 lib 名会波及所有 `use minidesk::…` 的 Rust 测试文件
（十几个），收益为零、回归面很大。

建议：**保持原样**。它们是内部标识，用户在界面上永远看不到。

### 5.3 六份图标 SVG 里的 `<title>`

`src/assets/app-icons/*.svg` 的 `<title>` 是 `ArtFlow miniDesk — Orbit` 之类。这是**你提供的原始素材**，
且这些 SVG 只以 `<img alt="">` 引用，`<title>` 不会显示给用户，也不会被读屏念出来。

建议：**不动素材**。若你希望改名，那属于修改品牌源文件，应单独走一次（并会连带改
`appIcon.test.ts` 里的素材指纹断言）。

### 5.4 仓库目录名

仓库目录仍叫 `ArtFlow-miniDesk`。改目录名不影响应用数据（数据在 `~/Library`），
但会打断 `qa_seed` 输出里的路径提示与任何人本地的脚本路径。

建议：**保持**，除非你打算连仓库一起搬。

## 6. 改名后的验收（等实施时照做）

1. 用现有正式数据启动改名后的应用 → 台账仍是 **4 单 / 1 客户 / 2 模板 / 2 附件 / 23 事件**；
2. 数据目录仍是 `~/Library/Application Support/dev.artflow.minidesk/`，**没有**出现新的空目录；
3. 设置页里主题、强调色、应用图标仍是上次保存的选择；
4. 新建一张订单 → 编号接着高水位往下发（不是从 0001 重来）；
5. QA 场景 `seeded` / `clean` 仍各自隔离，正式库不受影响；
6. 附件能正常打开（引用未断）；
7. 窗口标题、侧栏品牌名、菜单「退出 …」、关于面板、Finder 里的 `.app` 名一致。

第 2 条是这次命名调整唯一真正的风险点：**只要不动 identifier，它就不会发生。**
一旦有人"顺手"把 identifier 改成 `dev.artflow.deskcore`，用户打开就是空台账 —— 旧数据还在，
但在新路径下"看不见了"，这是最容易被误报成"数据丢失"的事故。

## 7. 排期

| 时点 | 内容 |
|---|---|
| DEV-06C（本轮） | **只归档决策**，不改代码，不扩大功能范围 |
| 下一次低风险界面维护 | 第一批（10 处纯展示）+ 第二批（`export.rs` 视 §5.1 裁定） |
| DEV-08（Mac 打包） | 核对 `.app` 名、Finder 显示名、`CFBundleName`、数据目录兼容 |
| DEV-09（Windows） | 沿用统一品牌名，单独验证平台安装身份与卸载行为 |
