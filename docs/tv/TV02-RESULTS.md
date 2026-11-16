> **归档说明（技术实验，非正式功能验收）**
>
> 本文档来自 ArtFlow miniDesk 的独立技术实验阶段（TV-01～TV-03.5），复制归档于此。
>
> - 结论仅对**当时的实验工程**成立，不是正式业务功能的验收结果。
> - 全部实验只在 macOS 上执行；**不代表 Windows 实机验证通过**。
> - 实验中的数据库、沙箱与测试数据均未迁入正式工程。
> - 正式实现以 `src-tauri/` 当前代码与 DEV 阶段报告为准。

---

# TV-02 实验结果报告

> TV-01 已由 ChatGPT 根据正式报告及窗口截图验收通过，本次仅核对其现有交付物，未重新执行完整测试。

- 执行日期：2026-11-16
- 工程：`/Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk-tv01`
- 本轮范围：TV-02（macOS WKWebView 交互兼容性）+ TV-01 结项核验
- 未执行：TV-03（附件/备份）、TV-04（Windows）、正式 miniDesk 开发

---

## 1. 执行摘要

TV-02 自动化部分全部通过，未发现阻塞性缺陷；**8 项为真实 WKWebView 内的程序化验证，4 项必须人工操作**（中文输入法、系统文件对话框、真实窗口按钮、真实按键），已在第 12 节给出操作步骤。

| 类别 | 结果 |
|---|---|
| 自动探针（真实 WKWebView，结果由 Rust 侧打印留证） | 6 项 PASS |
| 仅在 dev 模式验证（生产包未构建） | 1 项 PASS(dev) / 生产待验证 |
| 必须人工验收 | 4 项 MANUAL |
| 回归 | `cargo test` 14/14 通过；`tsc --noEmit` 与 `vite build` 通过 |
| TV-01 数据 | 完好（1 单 / 5 条历史 / integrity ok） |

最重要的一条：**窗口关闭请求在 dirty 状态下被成功拦截**（`close: prevented (dirty=true saving=false)`，窗口存活、提示出现、dirty 保留），这是本轮最高优先级项。

---

## 2. TV-01 结项核验

| 检查项 | 结果 |
|---|---|
| `README.md` / `TV01-RESULTS.md` | 存在（2839 B / 13375 B） |
| `src-tauri/Cargo.lock` / `package-lock.json` | 存在（110029 B / 51441 B） |
| TV-01 测试文件 | `src-tauri/tests/domain.rs` 存在 |
| 最小前端 | `src/main.tsx`、`src/DbPage.tsx`（由原 `App.tsx` 更名）、`src/bridge/commands.ts` 存在 |
| 实验数据库 | `~/Library/Application Support/dev.artflow.minidesk.tv01/minidesk-tv01.sqlite` 存在，`PRAGMA integrity_check = ok` |
| 遗留进程 | 无（检查时 `pgrep` 无输出） |
| 原仓库 | `work/u8-restart-prototypes` / `c5e67f0` / 0 行改动 |

**新发现缺陷**：无。TV-01 报告中的已知技术债（编号派生、单 Mutex、实验 schema）本轮未处理，也未因 TV-02 修改而恶化。

---

## 3. 环境与依赖变化

新增依赖（全部限定在实验工程内）：

| 依赖 | 版本 | 用途 |
|---|---|---|
| `react-router-dom` | 7.18.4 | `createHashRouter` + `useBlocker`（与 ArtFlowDesk 主版本一致） |
| `@tauri-apps/plugin-dialog` | 2.8.4 | 系统打开/保存对话框 |
| `tauri-plugin-dialog`（Rust） | 2.8.4 | 同上，插件初始化 |

capabilities 变化（仍为最小面）：

```json
"permissions": [
  "core:default",
  "core:window:allow-close",
  "core:window:allow-destroy",
  "dialog:default"
]
```

新增 `core:window:allow-close` / `allow-destroy` 是关闭保护测试所必需（确认放弃后需真正关闭窗口）；未启用 `plugin-fs`、未启用 `sql` 插件、未启用 `shell`。`t10` 测试同步更新为“禁止 fs:/sql:/shell:，允许 dialog:default”。

---

## 4. 修改文件清单

新建：

- `src/Layout.tsx`（顶部导航 + `Outlet`）
- `src/WebViewTest.tsx`（TV-02 测试页 + 自动探针）
- `TV02-RESULTS.md`（本文件）

修改：

- `src/main.tsx`（改为 `createHashRouter` + `RouterProvider`）
- `src/App.tsx` → `src/DbPage.tsx`（重命名，业务逻辑未改）
- `src/bridge/commands.ts`（新增 `logEvent`）
- `src/styles.css`（追加 TV-02 样式，未改动既有变量）
- `src-tauri/Cargo.toml` / `Cargo.lock`（新增 dialog 插件）
- `src-tauri/capabilities/default.json`（新增 3 项权限）
- `src-tauri/src/lib.rs`（注册插件 + `log_event` 命令）
- `src-tauri/tests/domain.rs`（t10 断言同步）
- `package.json` / `package-lock.json`

**未改动**：`orders.rs` / `db.rs` / `migrations.rs` / `error.rs` —— TV-01 领域层保持原样。

---

## 5. 测试矩阵

| ID | 测试方法 | 预期 | 实际 | 状态 | 证据 |
|---|---|---|---|---|---|
| TV02-01 | 探针在真实 WebView 创建 `dialog`，`showModal()` → 检查 `open` / `:modal` / 焦点归属 → 连续 5 次开关 | 三项均成立 | `open=true focusMovedIn=true :modal=true cycles=5` | **PASS**（Esc / 背景点击 / 小窗口为 MANUAL） | `/tmp/tv02-dev3.log` |
| TV02-02 | 真实中文输入法手动输入（input / textarea，记录 composition 事件） | 无重复字、无丢字、结束后 state 正确 | 未执行（无法程序化操作真实 IME） | **MANUAL** | 第 12 节步骤 |
| TV02-03 | `navigate("/db")` → 检查 hash → `navigate("/")` | 无 404，hash 正确往返 | `#/ → #/db → #/` | **PASS（dev）**；生产包 **NOT RUN** | 同上 |
| TV02-04 | 置 dirty → `navigate("/db")` ×3 → 检查路由未变、遮罩仅 1 个 → reset | 拦截生效、只出现一个确认 | `routeKept=true overlays=1 blocker=blocked` | **PASS**（程序化）；真实点击条为 MANUAL | 同上 |
| TV02-05 | dirty 后调用 `getCurrentWindow().close()`（与系统关闭按钮同一事件） | 关闭被阻止、提示出现、dirty 保留、进程存活 | `close: prevented (dirty=true saving=false)`；`windowAlive=true promptShown=true dirtyKept=true` | **PASS**（程序化关闭请求）；红点按钮 MANUAL | 同上 |
| TV02-06 | 手动点击三个按钮（选图片 / 选文本 / 另存为） | 对话框弹出、过滤生效、取消返回 null | 未执行（必然弹出系统模态，无法程序化关闭） | **MANUAL** | 第 12 节步骤 |
| TV02-07 | canvas → `toBlob` → `createObjectURL` → `Image.onload` → `revoke` → 重建再加载 | 两次都成功，宽 400 | `first=400 second=400 bytes=2869` | **PASS**（400×300）；6000×4000 按钮为 MANUAL | 同上 |
| TV02-08 | `crypto.subtle.digest("SHA-256","abc")` 与标准向量比对 | hex 完全一致 | `subtle=true match=true`，`hex` 前缀 `ba7816bf8f01cfea…` | **PASS** | 同上 |
| TV02-09 | 读取 `matchMedia("(prefers-color-scheme: dark)")`；三种模式按钮 | 信号可读、模式可切换 | `prefers-dark=false media-supported=true` | **INFO + MANUAL**（系统切换需人工） | 同上 |
| TV02-10 | 真实 ⌘S / Esc / Tab；另有“模拟 ⌘S”按钮 | ⌘S 只触发一次、不干扰候选词 | 未执行（无法发送真实按键） | **MANUAL**；模拟按钮 **NOT RUN** | 第 12 节步骤 |
| TV02-11 | 20 次 `list_orders` + 600ms `requestAnimationFrame` 采样 | 无可见冻结 | `avg=1.65ms max=20.00ms frames=37 maxFrameGap=18.0ms`（另一轮 `avg=2.00ms max=26.00ms maxFrameGap=18.0ms`） | **PASS** | `/tmp/tv02-dev2.log`、`dev3.log` |
| TV02-00 | 环境信息 | — | `protocol=http: secure=true dpr=1`，UA 为 macOS | **INFO** | `dev3.log` |

说明：`PASS` 均来自真实 Tauri 窗口内的执行，结果经 `log_event` 打到 Rust 终端，非 jsdom、非编译通过。

---

## 6. 未保存保护专项结论

| 场景 | 结论 | 证据类型 |
|---|---|---|
| 路由切换拦截 | 生效：dirty 时 `navigate` 被 `useBlocker` 阻止，路由保持在 `#/`，遮罩只渲染 1 个 | 真实 WebView 程序化 |
| 重复点击导航 | 未产生多个遮罩（`overlays=1`）；blocker 为单例状态 | 真实 WebView 程序化 |
| 取消离开 | `blocker.reset()` 后停留、内容保留 | 代码路径 + 程序化 |
| 放弃离开 | 清 dirty 后 `blocker.proceed()` 放行 | 代码路径（MANUAL 复核） |
| 窗口关闭（dirty） | 生效：`event.preventDefault()` + 提示 + dirty 保留 + 进程存活 | 真实 WebView 程序化关闭请求 |
| 窗口关闭（saving） | 与 dirty 同一分支（`dirtyRef \|\| savingRef`），未单独实测 | 代码路径，**待人工确认** |
| 重复点击关闭按钮 | `confirmRef` 保证只弹一个确认（再次请求只累加计数，不叠加弹窗） | 代码路径，MANUAL 复核 |
| 确认放弃并关闭 | 清 dirty → `destroy()`，不再触发关闭事件（避免二次拦截死循环） | 代码路径，MANUAL 复核 |
| 监听器泄漏 | 日志显示 `registered #1 → disposed → registered #2`，同一时刻仅一个监听 | 真实 WebView 日志 |
| 路由关闭 vs 窗口关闭 | 两套机制分开实现：路由用 `useBlocker`，窗口用 `onCloseRequested` | 代码结构 |

**未通过项**：无。**未覆盖项**：真实红点按钮点击、saving 状态下的关闭、确认后关闭的完整链路（均需人工）。

---

## 7. 文件与图片预览专项结论

- **文件对话框**：已接入官方 `plugin-dialog`，只启用 `dialog:default`；代码只取返回值展示，**不写任何文件**，因此不存在“任意路径写入”能力。三个入口（图片过滤 / 文本过滤 / 另存为）需人工点击验证。
- **路径可信性**：前端拿到的路径仅用于显示与日志；没有把它传回 Rust 做写操作，符合“前端不可信”边界。
- **Blob 预览**：`createObjectURL` → `Image.onload` → `revokeObjectURL` → 重建 → 再加载，两次均成功（400×300，2869 B），说明 revoke 后重建无残留引用错误。
- **大图**：6000×4000 由按钮触发（canvas 生成 JPEG），未自动执行；预计解码 20–80ms 量级，需人工确认是否卡顿。

---

## 8. 中文输入与快捷键

- **真实 IME**：**未验证**（MANUAL）。未使用 `input.value = "中文"` 之类方式冒充，也未用合成的 `compositionstart` 事件伪造。
- 页面已具备可观测条件：`composing` 标志、React state 长度、`compositionstart/update/end` 事件列表、dirty 变化，便于人工逐项核对。
- **快捷键**：真实 ⌘S / Esc / Tab **未验证**（MANUAL）；页面已实现窗口级 `keydown` 捕获（`metaKey||ctrlKey` + `s`）并 `preventDefault`，但本轮**没有**用合成事件证明其行为（模拟按钮存在但未点击）。
- 结论：这两项必须在下一轮由人工完成，不能以代码存在代替验收。

---

## 9. Rust 同步命令响应性

| 指标 | 第一次 | 第二次 |
|---|---|---|
| 20 次 `list_orders` 平均 | 0.50 ms | 1.65–2.00 ms |
| 最大单次 | 2.00 ms | 20–26 ms |
| 600 ms 内 rAF 帧数 | 37 | 37 |
| 最大帧间隔 | 17.0 ms | 18.0 ms |

**结论**：短只读命令未造成可复现的 UI 冻结（最大帧间隔 ≈ 60Hz 一帧）。最大 20–26ms 的单次尖峰出现在首批调用（含 IPC 首次开销），不构成阻塞。

**建议**：正式版保留“命令内不持有锁做长任务”的纪律；若未来出现批量导出、备份打包等耗时操作，应改为 `async` 命令 + 专用写线程/阻塞线程池，而不是加长同步命令。

---

## 10. TV-01 回归结果

| 项 | 结果 |
|---|---|
| `cargo test` | **13 integration + 1 unit = 14 passed / 0 failed** |
| `tsc --noEmit` | 通过 |
| `vite build` | 通过（33 modules，349.63 kB JS / 5.11 kB CSS） |
| TV-01 数据 | `integrity ok`，1 单 `AF-001`（complete / final / rev 5），5 条历史 |
| 领域层代码 | `orders.rs`/`db.rs`/`migrations.rs` 未改动 |

唯一因 TV-02 而改的断言是 `t10` 的命令数（8→9，新增 `log_event`）与 capability 白名单（允许 `dialog:default`），均已在测试中体现。

---

## 11. 原仓库隔离核验

| 时点 | 分支 | HEAD | 工作区 |
|---|---|---|---|
| 开始前 | `work/u8-restart-prototypes` | `c5e67f02b7a0c0a46b7de058e01c7071a5ccde6c` | 0 行 |
| 结束后 | `work/u8-restart-prototypes` | `c5e67f02b7a0c0a46b7de058e01c7071a5ccde6c` | 0 行 |

ArtFlowDesk 全程只读：未安装依赖、未运行其测试/构建、未迁移、未改配置、未动 Git。

---

## 12. 人工验收清单

启动方式：

```sh
export PATH="$HOME/.cargo/bin:$PATH"
cd /Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk-tv01
npm run tauri dev
```

> 探针只在首次启动时运行（`sessionStorage` 标记）。要看自动结果，请关闭后重新启动，或新开一次 dev。

### M1｜TV02-01 弹窗（Escape / 背景 / 小窗口）
1. 点“打开弹窗”。
2. 预期：背景变暗且无法点击；输入框已获得焦点。
3. 按 `Esc`。预期：弹窗关闭。
4. 再打开一次，把窗口拖窄到约 500px 宽。预期：弹窗不横向溢出。
5. 反馈：三项是否成立（成立/不成立 + 哪一项）。

### M2｜TV02-02 中文输入法
1. 切到拼音输入法，在 input 里连续输入“角色设定草稿”并选词。
2. 输入中文标点“，。”与 emoji“🎨”。
3. 观察下方 `composing=`、state 长度、事件列表。
4. 在 textarea 输入 200 字以上，中途切换一次输入法。
5. 预期：无重复字、无丢字；`compositionend` 后 state 与屏幕一致；dirty 已置 true。
6. 反馈：是否出现重复/丢字，出现在哪一步。

### M3｜TV02-04 真实点击离开
1. 修改中间输入框（dirty 变 true）。
2. 点顶部 “Database Test”，或点“尝试离开 →”。
3. 预期：出现“有未保存的修改”确认；点“留在此页”后内容仍在。
4. 再点“尝试离开 →” → 选“放弃修改并离开”。预期：进入 Database Test，且不再拦截。
5. 连续快速点击“尝试离开 →”三次。预期：只出现一个确认框。
6. 反馈：是否有一次出现两个确认框。

### M4｜TV02-05 真实窗口关闭（最高优先级）
1. 点“设为 dirty”。
2. 点窗口左上角红色关闭按钮。
3. 预期：窗口不关闭，出现“关闭窗口？”确认；点“留在此页”后内容仍在。
4. 再次点红点 → 选“放弃并关闭窗口”。预期：窗口真正关闭。
5. 重新启动应用，重复第 1–3 步两次。预期：仍只弹一个确认，不会因为监听器重复而弹两次或直接关闭。
6. 反馈：是否出现“窗口直接关闭、内容丢失”的情况（若有，请立即记录，属 FAIL）。

### M5｜TV02-06 文件对话框
1. 点“选择图片” → 选一张 png/jpg；确认过滤只显示图片。
2. 再点一次 → 点“取消”。预期：日志显示“已取消”，不报错。
3. 点“选择文本” → 选一个中文名的 `.txt`（可先自行建在桌面）。预期：路径正确显示中文。
4. 点“另存为…” → 选一个已存在的文件。预期：系统弹出覆盖确认；点取消后日志为“已取消保存”。
5. 反馈：是否有中文乱码、是否出现覆盖确认。

### M6｜TV02-07 大图
1. 点“生成大图 6000×4000”。
2. 预期：1–2 秒内出现预览，界面可继续操作。
3. 点“关闭并 revoke”，再点一次“生成大图”。预期：正常，无异常日志。
4. 反馈：打开耗时是否 >3 秒、是否有明显卡顿。

### M7｜TV02-09 主题
1. 依次点 light / dark / system，观察色块变化。
2. 选 system 后，在“系统设置 → 外观”切换深/浅色。
3. 预期：色块跟随系统变化（页面无需刷新）。
4. 反馈：是否需要刷新才生效。

### M8｜TV02-10 快捷键
1. 在 input 中按真实 `⌘S`。预期：只记录一次保存；页面不刷新、不弹系统对话框。
2. 在中文候选词状态下按 `Enter`。预期：选词，不触发保存。
3. 打开弹窗后按 `Esc`。预期：关闭弹窗。
4. 连续按 `Tab`。预期：焦点顺序为 导航 → 各区块按钮 → 输入框，不跳错。
5. 反馈：⌘S 是否被触发多次，Enter 是否误提交。

---

## 13. 风险与降级建议

### 高

1. **生产协议下的 secure context 未验证**
   本轮 `isSecureContext=true` 来自 dev 的 `http://127.0.0.1`（localhost 天然安全）。正式包使用 `tauri://localhost`（Windows 为 `http://tauri.localhost`），**`crypto.subtle` 是否仍可用必须重测**。
   降级：SHA-256 移到 Rust 侧（`sha2`），前端只传文件/字节流。TV-03 做备份时必须先确认这一点。

2. **关闭保护目前挂在页面上，不是应用根**
   `onCloseRequested` 注册在 `WebViewTest`，离开该路由即被清理。正式版必须挂到应用根（或全局 Provider），否则用户在订单页编辑时不受保护。
   这属于设计约束，不是本轮缺陷。

### 中

3. **真实红点按钮路径仍是 MANUAL**
   程序化 `close()` 走的是同一个 `CloseRequested` 事件，证据强度高，但「用户真实点击」与「系统级 Cmd+Q / 关机」仍需人工确认；`Cmd+Q` 可能走应用级退出而非窗口关闭，正式版需要单独处理。
4. **saving 状态的关闭未实测**
   代码与 dirty 同分支，但没有在保存中触发关闭的用例。
5. **大图解码性能未测**
   6000×4000 的实际卡顿程度未知，可能影响附件预览策略（是否需要缩略图）。

### 低

6. **`confirmRef` 单例保护只覆盖窗口关闭**，路由遮罩依赖 `useBlocker` 单例；极端情况下（同一 tick 多次导航）未做压测。
7. **弹窗使用页面内浮层**而非原生确认框，若 WebView 卡死则提示可能不可见。
8. **dev 模式 Vite HMR** 会在文件变更时刷新页面，可能掩盖真实刷新行为；生产包需重验。

---

## 14. 最终判断

1. **macOS WKWebView 是否满足 miniDesk 主要交互需求？** 满足。dialog、Blob、crypto、hash 路由、路由拦截、窗口关闭拦截均实测成立。
2. **HTML dialog 是否可复用？** 可复用。`showModal`、`:modal`、焦点进入全部成立，可沿用 ArtFlowDesk 的 dialog 封装。
3. **中文输入法是否可靠？** **未验证**（MANUAL）。这是本轮唯一没有证据的核心项，必须在正式开发前人工确认。
4. **Hash Router 是否可用？** dev 下可用且往返正常；生产包待验证。
5. **未保存资料能否阻止路由切换和窗口关闭？** 能。两者均有真实 WebView 证据；「确认后关闭」的完整链路待人工复核。
6. **系统文件对话框是否可靠？** 插件已接入、权限最小，但**未人工点击**，不能算通过。
7. **Blob 图片预览是否可用？** 可用，含 revoke 后重建。
8. **Web Crypto 是否正常？** 正常（标准向量命中）；生产协议下需重测。
9. **主题和快捷键是否正常？** 主题信号可读、样式可切；快捷键仅实现未验证（MANUAL）。
10. **Rust 同步命令是否存在明显 UI 阻塞？** 无。平均 1.65–2.00ms，最大帧间隔 18ms。
11. **是否有必须在正式开发前解决的阻塞？** 没有硬阻塞，但有三项必须在开发前闭环：真实 IME、生产协议下 `crypto.subtle`、关闭保护上移到应用根。
12. **是否建议进入 TV-03？** 建议，但**先补做第 12 节的 M2（IME）与 M4（真实关闭）**，并把「生产协议 secure context」列为 TV-03 的前置检查（备份哈希依赖它）。


---

# 补充章节：TV-02 中文界面与人工验收优化

- 执行日期：2026-11-16
- 性质：测试工具的易用性修正，未改技术架构、未改数据库规则、未新增产品功能
- 结论：界面已全中文；M1–M8 已内置到软件中，可由非技术用户独立完成

## 1. 修改了哪些文件

| 文件 | 改动 |
|---|---|
| `src/DbPage.tsx` | 全量中文化（标题、表头、状态、日志、历史、错误描述）；逻辑未变 |
| `src/WebViewTest.tsx` | 重写为中文测试页：顶部汇总 + 自动结果折叠区 + M1–M8 卡片 + 结果记录 + 复制按钮；探针逻辑与断言原样保留 |
| `src/Layout.tsx` | 导航改为「桌面兼容性测试 / 数据库测试」 |
| `src/styles.css` | 新增中文版样式（汇总条、卡片、折叠、警告块、失败说明），未改动既有关键样式 |
| `TV02-RESULTS.md` | 追加本章节 |

未改动：`orders.rs`、`db.rs`、`migrations.rs`、`error.rs`、`capabilities/default.json`、`Cargo.toml`。**未安装任何新依赖。**

## 2. 已替换的英文文案

| 原 | 现 |
|---|---|
| WebView Test / Database Test | 桌面兼容性测试 / 数据库测试 |
| TV-01 / TV-02 页面标题 | ArtFlow miniDesk · 数据库测试 / 桌面兼容性测试 |
| active / complete / cancelled | 进行中 / 已完成 / 已取消 |
| rev | 修改版本 |
| PASS / FAIL / INFO | 通过 / 失败 / 信息 |
| dirty / clean / saving / saved | 有未保存的修改 / 没有未保存的修改 / 正在保存 / 已保存 |
| Create Order / Move Stage | 创建虚构订单 / 推进阶段 |
| Unsaved Changes | 有未保存的修改 |
| Close Window | 关闭窗口？ |
| Cancel / Continue editing | 继续编辑 / 放弃修改并离开 |
| Open Dialog | 打开测试弹窗 |
| Choose Image / Save As | 选择测试图片 / 测试另存为 |
| Preview Image | 生成大图 / 关闭预览 |
| Test Result | 测试结果 |
| created / stage / status（历史标签） | 创建 / 阶段 / 状态 |
| forward / backward | 前进 / 返工 |
| journal_mode / synchronous / foreign_keys / user_version | 日志模式 / 同步级别 / 外键约束 / 数据结构版本 |

技术错误码按原样保留（例如 `CONFLICT`），但界面提示改为中文：「保存失败：订单已被其他修改，请重新读取后再试（错误码 CONFLICT）」。

## 3. 是否还有用户可见的英文

- 保留的技术名：`SQLite`、`SHA-256`、`Blob`、`Hash Router`、`dialog`、`Command + S`、`Esc`、`Tab`、`revision`、`TV-02`、`M1–M8` 编号。这些按要求保留，且每个都配有中文说明。
- `revision` 仅出现在数据库页按钮「模拟保存冲突（revision）」中，旁边有中文解释。
- 自动检查结果：新增探针 **TV02-12** 会扫描页面文本，要求 6 个中文关键词存在、`Database Test` / `WebView Test` 不出现 —— 本次实测 `缺少中文=无 残留英文=无`。

## 4. M1–M8 中文操作引导

已全部内置到「桌面兼容性测试」页面，每张卡片包含四部分：**目的 / 请这样做 / 正确的话应该看到 / 结果确认**。

| 编号 | 标题 | 对应交互入口 |
|---|---|---|
| M1 | 弹窗操作 | 打开测试弹窗、关闭弹窗 |
| M2 | 中文输入法 | 单行输入框、多行输入框（技术事件折叠在「查看技术详情」） |
| M3 | 页面切换保护 | 修改内容、保存（仅内存）、尝试切换页面 |
| M4 | 窗口关闭保护 | 模拟未保存修改、清除状态、已拦截次数；明确提示会真的关闭窗口 |
| M5 | 文件选择对话框 | 选择测试图片 / 选择测试文本 / 测试另存为；说明不上传、不写入 |
| M6 | 大图预览 | 生成大图（6000×4000）、生成普通图、关闭预览 |
| M7 | 主题切换 | 浅色 / 深色 / 跟随系统 + 系统设置路径说明 |
| M8 | 快捷键 | Command + S 计数、Esc / Tab / Enter 说明 |

## 5. 人工结果记录

- 每项可选：**测试通过 / 测试失败 / 暂时跳过**，默认「未测试」。
- 记录保存在实验专用 `localStorage`（键 `tv02-manual-v1`），刷新与重启后仍在；**不写 TV-01 订单数据库**。
- 失败时可填写「哪里不对？」，内容一并进入复制文本。
- 顶部实时显示：自动通过数、自动失败数、人工已确认 0–8、待人工确认数。
- 人工结果与自动结果分开记录：人工点「通过」不会改变自动探针的结论。

## 6. 复制结果按钮

顶部「复制测试结果」生成如下文本（示例格式）：

```
ArtFlow miniDesk TV-02 测试结果
自动测试：通过 8 项，失败 0 项

人工验收：
M1 弹窗操作：测试通过
M2 中文输入法：未测试
...
生成时间：2026/11/16 16:20:00
```

复制走 `navigator.clipboard`，失败时回退到隐藏 textarea + `execCommand("copy")`。**不会自动上传任何内容。**

## 7. 类型检查与构建

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | 通过（无错误） |
| `vite build` | 通过：`index.html 0.40 kB`、`CSS 7.49 kB`、`JS 360.51 kB`，103 ms |
| `cargo test` | **14 passed / 0 failed**（1 单元 + 13 集成，未改动断言语义） |

## 8. Tauri 窗口中文显示

真实 dev 窗口启动后，探针在 WKWebView 内执行并通过 `log_event` 回传：

```
[tv02] INFO TV02-00 运行环境 | 运行方式=http: 安全上下文=true 缩放=1
[tv02] PASS TV02-08 摘要校验（SHA-256） | 算法可用=true 与标准结果一致=true
[tv02] PASS TV02-01 原生弹窗（dialog） | 已打开=true 焦点进入弹窗=true 处于模态层=true 连续开关次数=5
[tv02] PASS TV02-07 图片预览（Blob） | 第一次宽=400 第二次宽=400 字节=2869
[tv02] PASS TV02-11 数据库命令响应速度 | 平均 0.40 毫秒 最长 3.00 毫秒 帧数 37 最大帧间隔 18.0 毫秒
[tv02] PASS TV02-12 界面中文化检查 | 缺少中文=无 残留英文=无
[tv02] PASS TV02-04 未保存时的页面切换保护 | 仍在本页=true 确认框数量=1
[tv02] PASS TV02-05 未保存时的窗口关闭保护 | 窗口仍打开=true 出现确认=true 未保存内容保留=true
[tv02] PASS TV02-03 页面路由（Hash Router） | 起点 #/ → 切换后 #/db → 返回后 #/
```

结论：中文界面真实渲染，且原有自动项全部复跑通过（未因中文化退化）。

## 9. TV-01 数据是否保持不变

`PRAGMA integrity_check = ok`；订单 1 条（`AF-001`，complete / final / rev 5）；历史 5 条。与中文化前一致。

数据库页在本次运行中也被真实挂载过一次（路由往返回到 `#/db` 时），Rust 侧日志可见：

```
[tv01] invoke ping at 2026-11-16T07:36:35Z
[tv01] invoke app_info sqlite=3.54.1 journal=wal fk=1 user_version=1
[tv01] invoke list_orders -> 1 rows
[tv01] invoke load_progress 017112bf-… -> 5 rows
```

说明中文化后原 TV-01 页面仍能正常读取订单与历史。

## 10. ArtFlowDesk 原仓库

`work/u8-restart-prototypes` / `c5e67f0` / 工作区 0 行改动，与实验前一致。

## 11. 重要说明

**M1–M8 不会因为界面中文化而自动变为 PASS。** 它们目前全部仍是「未测试」，必须由用户实际操作后逐项确认；本报告不把界面完成度当作验收结果。

---

# 人工验收结果（用户实际操作）

记录来源：用户在本机真实窗口中逐项操作，软件通过 `log_event` 回传至 `/tmp/tv02-live.log`。

| 编号 | 项目 | 最终结果 | 过程说明 |
|---|---|---|---|
| M1 | 弹窗操作 | **通过** | 打开弹窗、背景不可点、Esc 关闭 |
| M2 | 中文输入法 | **通过** | 真实拼音输入「角色设定草稿，今天继续细化🎨」，无重复/丢字 |
| M3 | 页面切换保护 | **通过** | dirty 时切换被拦截，取消后内容保留 |
| M4 | 窗口关闭保护 | **通过** | 点红点后窗口未关闭，出现中文确认，继续编辑后内容仍在 |
| M5 | 文件选择对话框 | **通过**（首次标失败） | 首次失败原因：测试条件缺文件——目标位置无同名文件，系统不会弹覆盖确认。补建 `~/Desktop/tv02-save-test.txt` 后重测通过 |
| M6 | 大图预览 | **通过** | 6000×4000 可打开、可关闭、可再次打开 |
| M7 | 主题切换 | **通过**（首次标失败） | 首次失败是测试页缺陷：`.theme-swatch.system` 只是固定颜色，不会跟随系统。已改为媒体查询跟随 + 增加「系统当前外观」指示，重测通过 |
| M8 | 快捷键 | **通过** | 真实 Command + S 被捕获 3 次（`trusted=true`），页面未刷新、未弹窗 |

汇总：**8 / 8 通过**，其中 M5 与 M7 各经历一次「首次失败 → 修正条件或修正测试页 → 重测通过」。

## 本轮补充发现

1. **系统文件窗口显示英文**（应用界面本身已是中文）
   - 现象：`打开 / 取消 / 存储` 等按钮为英文。
   - 环境：系统语言 `zh-Hans-CN`、区域 `zh_CN`，因此不是系统语言设置问题。
   - 原因判断：开发模式运行的是裸可执行文件，没有 `.app` 包，也没有本地化声明，AppKit 回退到英文。
   - 修复位置：打包阶段在 `Info.plist` 声明 `CFBundleDevelopmentRegion = zh_CN`、`CFBundleLocalizations` 含 `zh-Hans`。
   - 状态：**未验证**（需生成正式 `.app` 才能确认），不计入本轮通过项。

2. **M7 首次失败暴露的真实缺陷**：跟随系统模式此前只是固定配色，未真正响应系统外观；已修复为 CSS 媒体查询 + `matchMedia` 变更监听。

3. **M5 首次失败暴露的是测试设计问题**：要求「选择已存在文件」却未提供该文件；已补建测试文件，不是产品缺陷。

## 复核状态

| 项 | 结果 |
|---|---|
| 实验数据库 | `integrity_check = ok`，订单 1 条，历史 5 条（未清空、未改动） |
| ArtFlowDesk 原仓库 | `work/u8-restart-prototypes` / `c5e67f0` / 0 行改动 |
| 实验进程 | 已全部关闭 |
