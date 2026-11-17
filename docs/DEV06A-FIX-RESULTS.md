# DEV-06A-FIX 结果报告：Cmd+Q 保护与多草稿安全

- 日期：2026-11-17
- 工程：`/Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk`（`master`，未推送）
- 结论：`DEV06A-CLOSE-01` **根因已定位到框架源码并修复**（换掉绑定 `terminate:` 的默认 Quit）；
  `DEV06A-SAFE-01` **确认是真实缺陷，已修复**（逐份保存而非只存一份）。
  两项都**未经真实 Cmd+Q 按键验证**，等你实机复测。

---

## 1. 你的实机结果（本轮裁定依据）

| 编号 | 项目 | 结论 |
|---|---|---|
| A | 红色关闭按钮 → 取消后草稿保留 | PASS |
| B | 红色关闭按钮 → 放弃后无订单落库 | PASS |
| C | 红色关闭按钮 → 保存并关闭、重启后订单存在 | PASS |
| D | Cmd+Q → 直接退出，无任何提示 | **FAIL** |
| E | 已有订单修改 → 保存并关闭、重启后修改存在 | PASS |

D 是真实失败。我不把它解释为操作问题，也不把它归因于"系统限制"了事——
下面有源码级的证据说明它为什么会绕过。

---

## 2. CLOSE-01 根因（源码证据）

### 2.1 结论

**Cmd+Q 走的是 `NSApplication terminate:`，它在 Tauri 2.12.5 里根本不经过
`RunEvent::ExitRequested`。** 我之前写的 Rust 闸门是死代码，一次都没执行过。

### 2.2 三处证据

| # | 位置 | 事实 |
|---|---|---|
| 1 | `muda-0.20.0/src/platform_impl/macos/mod.rs:944` | `PredefinedMenuItemType::Quit => Some(sel!(terminate:))` —— 默认菜单的 Quit 直接调用 AppKit 的终止选择器 |
| 2 | `tao-0.37.2/src/platform_impl/macos/app_delegate.rs` | AppDelegate 只注册了 `applicationWillTerminate:`，**全文件没有 `applicationShouldTerminate:`**（grep 计数 0）。没有这个钩子，系统按 `NSTerminateNow` 直接退出 |
| 3 | `tauri-runtime-wry-2.12.3/src/lib.rs:4262` 与 `:4302` | `ExitRequested` 只有两个产生点：①窗口全部销毁（`TaoWindowEvent::Destroyed` 且窗口集为空）②`Message::RequestExit`（即 `AppHandle::exit()`） |

Cmd+Q 不经过 ①（窗口没销毁），也不经过 ②（没人调用 `exit`），所以
`lib.rs` 里那个 `if let RunEvent::ExitRequested { .. } { api.prevent_exit() }` 从未命中。
应用被系统直接杀掉了，前端连事件都没收到。

### 2.3 修复前的实际链路

```text
Cmd+Q
  → 默认菜单 Quit → NSApplication terminate:
      → tao 没有 applicationShouldTerminate: → NSTerminateNow
          → 进程结束（无 RunEvent、无前端事件、无确认框）
```

### 2.4 修复方式

自建 macOS 菜单（`src-tauri/src/infra/menu.rs`），Quit 换成**自定义菜单项**：

- 不再绑定 `terminate:`，accelerator 仍是 `CmdOrCtrl+Q`；
- 点击后 `on_menu_event` → `app.emit("app://exit-requested")`；
- 前端早已监听该事件，弹出与红色按钮**完全相同**的确认框；
- 确认后 `confirm_close` 打开闸门并 `app.exit(0)`，第二次 `ExitRequested` 因闸门已开而正常退出。

**编辑菜单必须一起重建**：macOS 的 Cmd+C/V/X/A/Z 来自 Edit 菜单，
只留 App 菜单会让所有输入框失去复制粘贴。菜单结构：App（关于/Hide/Quit）+
编辑（撤销/重做/剪切/复制/粘贴/全选）+ 窗口（最小化/关闭）。

### 2.5 修复后的链路

```text
Cmd+Q
  → 自定义菜单项 "quit"（Cmd+Q）
      → on_menu_event → emit app://exit-requested
          → 前端 requestClose("quit")
              ├─ 有草稿 → 确认框（保存并关闭 / 放弃并关闭 / 取消）
              │     ├─ 保存成功 → invoke confirm_close → 闸门开 → app.exit(0)
              │     └─ 保存失败 → 停在框内，进程不退
              ├─ 无草稿 → 直接 invoke confirm_close → 退出
              └─ 已有其它模态 → 排队，栈空后再问
```

`RunEvent::ExitRequested` 的闸门**继续保留**，作为第二条网：窗口全关、
Dock「退出」以外由 `AppHandle::exit` 触发的退出仍然会经过它。

### 2.6 仍然存在的边界（不隐瞒）

- **Dock 图标右键「退出」**：macOS 仍走 `terminate:`。要拦它必须自己实现
  `applicationShouldTerminate:`（给 NSApp delegate 动态加方法），本轮没做，
  因为产品要求的是「菜单栏退出」与 Cmd+Q，这两条已被覆盖。
  这条记为已知限制，见第 9 节。
- **系统强制结束 / 断电**：不拦，也不做任何"能保住草稿"的承诺。

---

## 3. SAFE-01：确认存在，已修复

### 3.1 复现（代码层）

`src/App.tsx` 原实现：

```ts
const guard = activeGuard();     // 只取"最后登记且 dirty"的那一个
const error = await guard.save();
await finishClose(kind);          // 存完这一个就退出
```

`activeGuard()` 只返回一个。所以"订单详情改了标题 + 新建面板填了标题"同时存在时，
只会保存其中一个，另一个随窗口关闭静默丢失。**这是真实缺陷，不是理论风险。**

### 3.2 修复

1. `unsavedRegistry` 新增 `dirtyGuards()`：返回**全部**仍有草稿的 guard，内层优先。
2. `App.handleSaveAndClose` 改为逐份保存：

```ts
for (const guard of dirtyGuards()) {
  if (!dirtyGuards().some((item) => item.id === guard.id)) continue;  // 已被上一份带走
  const error = await guard.save();
  if (error) { setCloseError(`${guard.label}：${error}`); return; }    // 停下，不关闭
}
await finishClose(kind);   // 全部成功才关
```

3. 每份 guard 带 `label`（订单资料 / 新建订单 / 客户资料 / 新建客户 / 流程模板 / 新建模板 / 工作时区），
   对话框在多于一份时直接列出："会丢失 2 处未保存的修改：新建订单、订单资料"。
4. 「放弃修改并关闭」也改为处置**全部**草稿（`for (const g of dirtyGuards()) g.discard()`），
   不再只清一份。
5. 保存过程中若某份 guard 随组件卸载（例如新建成功后自动关闭面板），循环会跳过它，
   不会对已消失的表单重复提交。

### 3.3 明确的行为契约

| 情况 | 行为 |
|---|---|
| 两份都脏，都保存成功 | 全部落库后退出 |
| 一份成功一份失败 | **不退出**；错误里写明是哪一份；未处理的草稿仍在保护中 |
| 用户选放弃 | 全部草稿丢弃后退出（这是明确授权，不是静默） |
| 用户选取消 | 一份都不动，窗口保持 |

---

## 4. 自动化测试与结果

```text
cargo test                → 280 passed / 0 failed
cargo check --all-targets → 通过，0 warning
npm run test              → 122 passed / 0 failed（17 个文件）
npx tsc --noEmit          → 通过
npm run build             → ✓ built in 119ms
```

本轮新增/扩充：

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| `src/App.close.test.tsx` | 18（+8） | 原有 10 条（无草稿直关、拦截、保存后关、失败不关、放弃、取消、连续关闭、模态排队、Cmd+Q 确认、Esc 层级）+ 新增 5 条多草稿（两份都保存且内层优先、一份失败停止且另一份不被放弃、放弃清空全部、取消后两份仍在、内层已卸载不重复保存）+ 3 条退出路径（无草稿直退、两份都保存、保存失败不退出） |
| `src/lib/unsavedRegistry.test.ts` | 5 | 新增 `dirtyGuards()` 行为由多草稿用例间接覆盖 |
| `src-tauri/src/infra/menu.rs` | 1 | 只有 `quit` 会触发退出请求 |

### 4.1 关于"应用级 Quit 的真实接线"

必须说清楚证据等级：

- **已证明**：自定义菜单安装代码在启动时执行（`[minidesk] menu installed quit_id=quit ...` 见第 5 节）；
  菜单事件分发逻辑有单元测试；Rust 退出闸门有单元测试；前端对 `app://exit-requested`
  的响应有 3 条集成测试。
- **未证明**：真实按下 Cmd+Q 时 macOS 是否把按键交给我们的菜单项。
  这需要真实按键，我做不到（`osascript` 返回 -1728，无辅助访问）。
  所以 Cmd+Q 标 **NOT VERIFIED**，等你按一次。

---

## 5. 实机启动验证

```text
[minidesk] env ready mode=qa scenario=seeded identifier=dev.artflow.minidesk.qa
           path=.../dev.artflow.minidesk.qa/seeded ...
[minidesk] menu installed quit_id=quit accelerator=CmdOrCtrl+Q kind=custom
```

（第一行证明进了 QA；第二行证明默认菜单被替换成自定义菜单——这正是 CLOSE-01 的修复点。）

> 附带排错记录：本轮第一次启动失败，`Port 1421 is already in use`——上一轮留下的 vite 进程。
> 清理后重启成功。这条对你也适用：启动失败先 `lsof -ti:1421 | xargs kill -9`。

---

## 6. 红色关闭按钮的回归

A/B/C/E 四条行为**代码路径没有改动**：`onCloseRequested` 与 `preventDefault` 未修改，
`finishClose` 的关闭动作未修改。改的只是"保存时保存几份"和"Cmd+Q 怎么进来"。

对应自动化：原有 10 条关窗用例全部保留并通过（其中 3 条即 A/B/C 的等价断言）。
E（已有订单修改 → 保存并关闭）由"订单资料"guard 的 save 路径覆盖。

**实机 A/B/C/E 已由你 PASS，本轮不要求重做**；但因 `handleSaveAndClose` 变了，
建议在下一轮 Cmd+Q 测试时顺带确认一次"保存并关闭"仍正常（第 7 节步骤 5）。

---

## 7. 你实机需要做的最短流程

### 7.1 准备（从打开终端开始）

`Command + 空格` → 输入 `终端` → 回车。

```bash
cd /Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk
lsof -ti:1421 | xargs kill -9 2>/dev/null
npm run qa:clean
```

> 用 clean 而不是 seeded：要验证"放弃后没有落库"，不能被预置订单干扰。
> clean 里可能还有你上次建的测试单，这不影响本轮判断（第 5 步会看新增的那张）。

确认进 QA：终端有 `mode=qa scenario=clean`，窗口标题含「QA 测试环境」。

### 7.2 Cmd+Q 保护（CLOSE-01，5 步）

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | 订单页 →「新建」→ 标题输入 `退出测试-A` | 面板出现 |
| 2 | 按 `Cmd + Q` | **弹出「退出前有未保存的修改」**，三个按钮。这一条就是 D 的复测点 |
| 3 | 点「取消，继续编辑」 | 窗口还在，`退出测试-A` 仍在输入框里 |
| 4 | 再按 `Cmd + Q` → 点「放弃修改并关闭」 | 应用退出 |
| 5 | 重新 `npm run qa:clean` → 看订单列表 | 没有 `退出测试-A` |

再验一次保存路径：

| 步骤 | 操作 | 预期 |
|---|---|---|
| 6 | 「新建」→ 标题 `退出测试-B` → `Cmd+Q` → 「保存并关闭」 | 应用退出 |
| 7 | 重新启动 | 列表里有 `AF-2026-0001`「退出测试-B」 |
| 8 | 打开它，改标题为 `退出测试-B2` → `Cmd+Q` → 「取消」 | 标题仍是 `退出测试-B2`，应用没退 |

### 7.3 多草稿（SAFE-01，5 步）

单窗口页面结构下能同时脏的组合是：**订单详情 + 新建面板**（其它页面互斥，切页会先经过离页保护）。

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | 订单页，打开任意一张订单，把标题改成 `多草稿-详情`（不保存） | 详情表单变脏 |
| 2 | 点「新建」，标题输入 `多草稿-新建` | 现在有两处草稿 |
| 3 | 点红色关闭按钮 | 提示「关闭窗口会丢失 **2 处**未保存的修改：新建订单、订单资料」 |
| 4 | 点「保存并关闭」 | 应用退出 |
| 5 | 重新启动 | ①列表里新增了一张 `多草稿-新建`；②原订单标题变成 `多草稿-详情`。**两个都在，才算通过** |

再验一次失败/取消：

| 步骤 | 操作 | 预期 |
|---|---|---|
| 6 | 重复 1–2，点关闭后选「取消」 | 两处输入都还在 |
| 7 | 重复 1–2，点关闭后选「放弃修改并关闭」，重启 | 订单标题**没有**变，也没有新增订单 |

### 7.4 菜单栏退出

点屏幕左上角菜单「ArtFlow miniDesk QA」→「退出 ArtFlow miniDesk」，
应与 Cmd+Q 完全一致（同一确认框）。

### 7.5 无草稿退出

不填任何东西，直接 `Cmd+Q` → 应立即退出，不弹框。

### 7.6 停止与报告

正常路径就是退出应用；若卡住：

```bash
pgrep -fl artflow-minidesk
kill <PID>
```

报告给我四样：终端 `env ready` 与 `menu installed` 两行、你点了什么、期望、实际。

---

## 8. 数据指纹与隔离

| 项 | 本轮开工前 | 收工后 |
|---|---|---|
| 正式代际 | `gen-c00a879220964299af7adcef8b9fc1c5` | 同 |
| 正式订单 / 客户 / 模板 / 附件 | 4 / 1 / 2 / 2 | 4 / 1 / 2 / 2 |
| 正式事件（完成） | 23（4） | 23（4） |
| 正式 schema | v3 | v3（**无迁移**） |
| QA seeded | 12 单 | 未重建、未改动 |
| QA clean | 1 张你建的测试单 | 未重置（第 7 节会让你自己清） |
| 旧 Web 工程 / TV 实验工程 | 未触碰 | 未触碰 |

本轮没有新增数据库字段：退出闸门是进程内 `AtomicBool`，菜单是运行时对象。

---

## 9. Git 提交与剩余风险

```text
48291b8 fix(close): intercept Cmd+Q with a custom menu item
edb136b fix(close): save every dirty form before closing
3b31860 docs: DEV-06A-FIX root cause, multi-draft fix and re-test steps
```

剩余风险：

1. **Dock 右键退出仍可能绕过保护**（`terminate:` 路径）。要么接受，要么下一轮实现
   `applicationShouldTerminate:`（需要 unsafe 给 NSApp delegate 加方法，风险与收益需评估）。
2. **Cmd+Q 未实机验证**，等你按一次。
3. 多草稿的"逐份保存"是串行提交：若第一份成功、第二份失败，第一份已经落库。
   这是有意的（部分成功优于全部丢弃），对话框会说明失败的是哪一份；用户可选择放弃后退出。
4. 表单之间是否存在"实际不可能同时脏"的组合，我只对订单详情+新建面板做了可执行验证；
   其它页面切换会先触发离页保护，逻辑上互斥，但没有逐个写测试证明。
5. `@tauri-apps/api/core` 的静态/动态双重导入仍有一条 Vite 提示，未处理（体积问题）。
