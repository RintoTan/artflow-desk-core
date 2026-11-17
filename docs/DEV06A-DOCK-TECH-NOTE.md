# DEV06A-DOCK-01 技术评估：Dock 退出与人工菜单退出

- 状态：**OPEN / P1 发布阻断**
- 结论：**在不使用 unsafe 原生钩子的前提下，无法拦截 Dock 图标右键「退出」。**
  本轮只做调查与设计，未实施任何 unsafe 方案。

---

## 1. 当前各退出入口的真实状态

| 入口 | 触发机制 | 是否经过未保存保护 | 证据 |
|---|---|---|---|
| 红色关闭按钮 | WKWebView `CloseRequested` → JS `onCloseRequested` | **是** | 用户实机 A/B/C/E PASS |
| Cmd+Q | 自定义菜单项（`quit`，Cmd+Q）→ `app://exit-requested` | **是** | 用户实机 R1/R2/R3 PASS |
| 菜单栏「ArtFlow miniDesk QA → 退出」 | 同一个自定义菜单项 | **是（逻辑同 Cmd+Q）** | 代码同一路径；实机未单独抽查 |
| **Dock 图标右键「退出」** | AppKit 默认 `NSApplication terminate:` | **否** | 见第 2 节 |
| Apple Event `quit`（`osascript -e 'quit app …'`） | 同上，走 `terminate:` | **否** | 同一条路径 |
| 强制退出（⌥⌘⎋ / `kill -9`） | 系统级 | 否（本来就不拦） | — |

Dock 的普通「退出」不是强制退出，所以它属于**真实的数据丢失风险**。

---

## 2. 为什么框架拦不住

### 2.1 依赖层证据

| 依赖 | 版本 | `applicationShouldTerminate:` |
|---|---|---|
| tao | 0.37.2（crates.io 最新稳定版，2026-10-23 更新） | **0 处** |
| tauri-runtime-wry | 2.12.3 | **0 处** |
| tauri | 2.12.5 | **0 处** |
| muda | 0.20.0 | Quit 菜单项绑定 `sel!(terminate:)` |

`tao` 只实现了 `applicationWillTerminate:`（5 处引用），那是**终止已经决定之后**的通知，
拿不到否决权。没有 `applicationShouldTerminate:`，AppKit 按 `NSTerminateNow` 直接结束进程。

`tao` 的最新版就是 0.37.2，**不存在"升级依赖即可解决"的路径**。

### 2.2 所以

- 自定义菜单只能覆盖"从我们菜单发出的退出"；
- Dock 菜单由 AppKit 自己构造，发送的是 `terminate:`，我们的菜单与 `RunEvent` 都不参与；
- 这不是配置问题，也不是调用时机问题，是**框架没有暴露这个生命周期**。

---

## 3. 可选方案（均未实施）

### 方案 A：unsafe 注册 `applicationShouldTerminate:`（能力最强，风险最高）

做法：取 `NSApp.delegate` 的类，用 `class_addMethod` 动态添加
`applicationShouldTerminate:`，实现里返回 `NSTerminateCancel` 并发事件给前端；
用户确认后再调用 `reply(toApplicationShouldTerminate: true)` 结束。

需要说清的风险点：

| 项 | 说明 |
|---|---|
| 签名/ABI | `extern "C" fn(id, SEL, id) -> NSInteger`（`NSApplicationTerminateReply` 是 `NSInteger`） |
| 线程约束 | 必须在主线程执行；AppKit 回调本身在主线程，注册也应在主线程 |
| delegate 生命周期 | tao 的 delegate 在运行期存在；若被替换或销毁，方法虽在类上但对象可能已变 |
| 重复注册 | `class_addMethod` 对已存在的方法返回 false，需要判重，避免覆盖他人实现 |
| 多窗口 | 本应用单窗口，逻辑简单；多窗口需定义"哪个窗口的草稿" |
| 系统关机/注销 | 同一回调也会被调用；直接 cancel 可能阻塞系统关机，需要超时后放行 |
| 失败回退 | 注册失败必须静默降级为当前行为，不能把自己搞崩 |
| 卡死风险 | 一旦 cancel 后没有 reply，系统会一直等，**应用可能无法退出**——这是最需要防的 |

最小测试方案（如果获批）：

1. 单元：注册函数幂等，第二次调用不重复添加；
2. 集成：`osascript -e 'quit app …'` 触发 → 前端收到事件 → 取消 → 进程仍在；
3. 集成：同样触发 → 保存/放弃 → 进程退出；
4. 回归：菜单退出与 Cmd+Q 不受影响；正常关闭不被卡住；
5. 异常：注册失败时应用仍能正常启动与退出。

**本轮不实施**：需要用户/ChatGPT 明确批准。

### 方案 B：替换 NSApp.delegate

自建 delegate 把 `applicationShouldTerminate:` 与 tao 需要的窗口事件一起实现。
风险高于 A（要复刻 tao 的 delegate 行为），**不建议**。

### 方案 C：隐藏 Dock 菜单的「退出」

无公开 API。私有 API 不可用。

### 方案 D：接受风险并明示

在文档与首次启动提示里写明"Dock 退出不会保护草稿"，让用户改用红色按钮或 Cmd+Q。
成本为零，但风险仍在，不能算修复。

### 方案 E：把草稿持久化（根治方向，超出本轮）

真正能覆盖"任何异常退出都不丢"的做法不是拦退出，而是**边编辑边落盘草稿**
（本地临时草稿表或文件），下次启动提示恢复。
它可以同时覆盖 Dock 退出、崩溃、断电——但这些属于故障恢复范畴，
需要新表/新文件与恢复 UI，**不属于 DEV-06A，也不在本轮授权内**。

---

## 4. 建议

1. **短期**：保持 DOCK-01 为 OPEN / P1，发布前必须由用户决定
   "接受（方案 D）"还是"批准方案 A"。
2. **中期**：若批准 A，按第 3 节的最小测试方案实现，并写死超时兜底
   （cancel 后 30 秒内无用户响应 → 自动放行退出，避免卡死）。
3. **长期（推荐）**：方案 E 的草稿自动保存，能覆盖所有退出与崩溃路径，
   比逐个堵入口更可靠。

---

## 5. 本轮结论

- 已确认：Dock 退出走 `terminate:`，当前保护覆盖不到。
- 已排除：升级依赖（tao 已是最新）、公开 API、菜单级拦截。
- 未实施：任何 unsafe 钩子。
- 因此 **DEV-06A 不能宣称"所有退出方式都已保护"**。
