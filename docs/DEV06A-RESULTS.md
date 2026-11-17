# DEV-06A 窗口关闭保护与键盘操作 — 结果报告

- 日期：2026-11-17
- 工程：`/Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk`（`master`，未推送）
- 状态：**已实现，自动化通过；真实窗口行为等我无法点击，标 NOT VERIFIED。**
- 前置：QA-01 已归档关闭（见第 1 节）。

---

## 1. QA-01 关闭归档

| 文档 | 处理 |
|---|---|
| `docs/QA01-RESULTS.md` | 新增第 0 节：用户两轮实机验收 8 项结论、完成次数口径更正、相对/固定日期说明、旧机制废弃、模板下拉保留 |
| `docs/QA-SANDBOX.md` | 补"完成事件按月分布"正确预期（10 月 2 次 / 11 月 2 次，合计 4 次） |
| `docs/REMAINING-WORK.md` | QA-01 收口；DEV-06 拆分为 A/B/C；第 3、4 项改为"已实现，待用户实机验收" |

### 1.1 更正的内容

旧文档写「工作台本月完成次数应为 3」，**是错的**。`qa01-v1` 的实际口径：

| 月份 | 完成事件 | 来源 |
|---|---|---|
| 2026-10 | 2 | AF-2026-0001 第一次；AF-2026-0002 跨月完成稿 |
| 2026-11 | **2** | AF-2026-0001 第二次；AF-2026-0007 零元友情稿 |
| 合计 | 4 | 等于 `completed` 事件总数 |

错误来源：把"这张单完成过两次"当成"本月完成两次"，没有按月拆。
**没有改业务代码、没有伪造事件**——只改文档。

同时写明：相对日期（今天/2 天后/逾期 3 天）每次重建都跟着当天走；
固定历史事件（9 月创建、10 月完成）不随日期变化；而"本月"这个口径本身会随日历推进改变。

### 1.2 旧机制与模板下拉

- `AF_MINIDESK_QA_ROOT` 自由路径方案：**已废弃**，代码中不存在。
  现行机制是独立应用标识 `dev.artflow.minidesk.qa` + `seeded` / `clean` 场景。
- 新建订单「制作流程」下拉：**保留**（用户 T1 已确认），不再回退。

---

## 2. 关闭窗口保护的事件链路

### 2.1 两条入口，一个出口

| 触发 | 由谁拦 | 证据 |
|---|---|---|
| macOS 红色关闭按钮 | 网页层 `getCurrentWindow().onCloseRequested` → `event.preventDefault()` | `src/App.tsx:139`；`src/App.close.test.tsx` 断言 `preventDefault` 被调用 |
| Cmd+Q / 应用退出 | Rust `RunEvent::ExitRequested` → `api.prevent_exit()` + 发 `app://exit-requested` | `src-tauri/src/lib.rs:157`；`src-tauri/src/infra/close.rs` |
| 用户确认后 | 前端 `invoke("confirm_close")` → Rust 打开闸门并 `app.exit(0)` | `infra/close.rs::confirm_close`，已进命令白名单 |

为什么 Cmd+Q 必须走 Rust：macOS 的 Cmd+Q 是应用级退出，WebView 拿不到这个键，
JS 的 `onCloseRequested` 也不会触发。两条链路各自拦截、共用一个确认框和一个出口。

### 2.2 事件链（窗口关闭）

```text
用户点红色按钮
  → WKWebView CloseRequested
  → JS onCloseRequested
      ├─ closingRef 已置位（程序化关闭）→ 放行，不重复拦截
      └─ event.preventDefault()
          ├─ 已有其它模态打开 → 记入 pendingClose，等模态栈空再问
          └─ 否则 → 显示确认框（保存并关闭 / 放弃修改并关闭 / 取消）
                ├─ 保存并关闭 → guard.save() → 成功 → invoke confirm_close → app.exit(0)
                │                            └─ 失败 → 框内显示错误，窗口保持打开
                ├─ 放弃 → guard.discard() → confirm_close
                └─ 取消 → 关框，回到原表单
```

### 2.3 防重复与防死循环

- `closingRef`：程序化关闭前置位，避免 `app.exit` 再次触发 `ExitRequested` 被自己拦住。
- `closeInFlight`：保存/放弃进行中时第二次点击直接忽略。
- `closeKindRef` 非空时 `requestClose` 直接返回：连续点关闭只处理一次。
- 对话框自身用现有 `runOnce` 的内部 ref 再挡一层。

---

## 3. 纳入 dirty 管理的页面

不是只保护订单详情，每个可编辑表单都接入了同一套登记表（`src/lib/unsavedRegistry.ts`）。

| 页面 / 表单 | dirty 判定 | 保存动作 | 放弃动作 |
|---|---|---|---|
| 订单详情 | `draft` 与 `detail` 不一致（沿用原有 `sameDraft`） | `api.updateOrderDetails`（原有 `saveDraft`） | 还原 `draftFrom(detail)` |
| 新建订单面板 | 标题/类型/金额/备注/新客户名任一非空，或选了客户 | `api.createOrder`（原有 `submit`） | 关闭面板 |
| 客户编辑 | `draft` 与 `detail.client` 不一致 | `clientApi.update` | 还原草稿 |
| 新建客户 | 已输入名称 | `clientApi.create` | 清空并关闭 |
| 模板编辑 | `draft` 与 `selected` 不一致 | `templateApi.update` | 还原草稿 |
| 新建模板 | 已输入名称 | `templateApi.create` | 清空并关闭 |
| 工作时区 | `draft !== info.workingTimezone` | `api.timezoneSet` | 还原为已保存值 |

登记表规则：**最后登记且 dirty 的生效**——所以"新建订单面板"（内层）会盖过"订单页详情"（外层），
关窗时不会把两套草稿混在一起。注销即失效，路由切换自动清理。

原有页面内离页保护（`useBlocker` + `UnsavedChangesDialog`）**完全未改**，两套共用同一个对话框组件。

---

## 4. 三个分支的实现与失败路径

| 分支 | 行为 | 失败时 |
|---|---|---|
| 保存并关闭 | `await guard.save()`，只有返回 `null` 才 `finishClose()` | 返回错误串 → 显示在框内，**窗口保持打开**，输入不动；抛异常同样转成错误文本 |
| 放弃修改并关闭 | `guard.discard()`（只清内存，不写库）后关闭 | 不调用任何保存命令 |
| 取消，继续编辑 | 关闭对话框，表单状态原样 | Esc 等同此分支 |

关键点：**先保存成功再关闭**，没有"先关窗再异步保存"。
`src/App.close.test.tsx` 用调用顺序断言 `["save", "destroy"]`，防止有人把顺序写反。

对不支持"保存并关闭"的页面：本轮没有发现——上述 7 个表单的保存函数都改成了
返回 `Promise<string | null>`，错误信息可以从保存结果里拿到，不必靠读 state（避免时序误判）。

---

## 5. macOS：Cmd+Q 与关闭按钮的边界

| 行为 | 是否被拦截 | 说明 |
|---|---|---|
| 红色关闭按钮 | 是（JS `onCloseRequested`） | 阻止关闭，先问 |
| Cmd+Q / 菜单「退出」 | 是（Rust `ExitRequested`） | 阻止退出，先问；确认后 `confirm_close` 打开闸门再退出 |
| 关闭最后一个窗口 | 是 | 与关闭按钮同一条链路 |
| 系统强制结束 / 断电 / 崩溃 | **否** | 这是故障恢复问题，不在本轮范围；不做任何"能阻止丢数据"的声明 |
| 程序化 `app.exit`（我们自己触发） | 不拦截 | 闸门已打开 |

**实测状态**：两条链路都只有代码与单元/集成测试证据；
真实按键与真实红色按钮点击 **NOT VERIFIED**（第 9 节）。

---

## 6. 快捷键与焦点管理

| 快捷键 | 生效范围 | 实现 |
|---|---|---|
| Cmd+N | 订单页（未在新建面板时）、客户页、模板页 | `usePageShortcuts.onNew` |
| Cmd+S | 订单详情（脏时）、客户编辑、模板编辑、设置页 | `onSave`，页面自身 `busy` 防重复 |
| Cmd+F | 订单页 | 聚焦搜索框（`searchRef`） |
| ↑ / ↓ | 订单列表 | 只移动**键盘光标**（`cursorId`），不打开详情、不写队列 |
| Enter | 订单列表 | 打开光标所在订单 |
| Esc | 全局 | 沿用 `modalStack`：只有栈顶模态处理 |

冲突处理（全部有测试）：

- **文本输入中**：焦点在 input/textarea/select/contentEditable 时方向键与 Enter 不触发列表操作。
- **模态打开时**：`topModal() !== null` → 整页快捷键直接返回，底层不抢键。
- **输入法组合**：`isComposing` 为真时忽略。
- **默认行为**：没注册的动作不 `preventDefault`，不吞系统快捷键。
- **Cmd+N 重复**：已在新建面板时不再打开第二个。
- **Cmd+S 重复**：`busy` 期间不重复提交。
- **队列安全**：键盘选择只改 `cursorId`，不调用 `queueApi.move`，测试断言 `queueMove` 从未被调用。

光标与选中分离的原因：如果方向键直接打开详情，每按一下就会发两次请求并可能触发离页确认；
分离后方向键是纯本地操作，Enter 才产生副作用。

---

## 7. 自动化测试

```text
cargo test                → 279 passed / 0 failed
cargo check --all-targets → 通过，0 warning
npm run test              → 114 passed / 0 failed（17 个文件）
npx tsc --noEmit          → 通过
npm run build             → ✓ built in 132ms
```

本轮新增：

| 文件 | 用例 | 覆盖 |
|---|---|---|
| `src/App.close.test.tsx` | 10 | 无草稿直接关；dirty 拦截；保存成功后才关（断言调用顺序）；保存失败不关且显示错误；放弃不保存；取消不动；连续关闭只处理一次；有其它模态时不叠框、栈空后补问；Cmd+Q 走 `confirm_close`；Esc 只关自己 |
| `src/lib/shortcuts.test.tsx` | 7 | Cmd+N/S/F；未注册不吞默认；输入框内方向键无效；非输入框内生效；模态打开全失效；输入法组合忽略；`enabled=false` |
| `src/lib/unsavedRegistry.test.ts` | 5 | 只有 dirty 参与；内层优先；注销失效；实时判断非快照；save 返回值透传 |
| `src/pages/OrdersPage.keyboard.test.tsx` | 5 | 方向键只移动光标且不改队列；Enter 打开正确订单；搜索框内方向键不影响；Cmd+N 不叠面板；Cmd+F 聚焦 |
| `src-tauri/src/infra/close.rs` | 1 | 闸门默认关闭、授权后打开 |

关于"Tauri 窗口关闭事件的实际接线"：前端测试确实是替换了 `@tauri-apps/api/window`
模块，但它替换的是**官方 API 的边界**，不是随便一个 React 回调——测试断言
`onCloseRequested` 被真实调用、`preventDefault()` 被真实调用、`destroy`/`invoke` 的调用顺序正确。
Rust 侧的 `ExitRequested` 拦截有独立单元测试。真正的红色按钮点击仍标 NOT VERIFIED。

---

## 8. 正式 / QA 数据隔离核验

| 项 | 结果 |
|---|---|
| 正式代际 | `gen-c00a879220964299af7adcef8b9fc1c5`（未变） |
| 正式数据 | 4 订单 / 1 客户 / 2 模板 / 2 附件 / 23 事件（4 完成）——与本轮开工前一致 |
| 正式 schema | v3（无迁移） |
| QA seeded | `.../dev.artflow.minidesk.qa/seeded`，12 单，未被本轮改动 |
| QA clean | 已被你的 C-QA2 验收用过一次（1 张 `AF-2026-0001` 测试单）。这是**用户操作留下的**，我没有清理 |
| 旧 Web 工程 / TV 实验工程 | 未触碰 |

本轮**没有新增 schema 字段或迁移**：退出闸门是进程内 `AtomicBool`，不落盘。

---

## 9. 仍需你在真实窗口确认（NOT VERIFIED）

我无法点击 macOS 窗口（`osascript` 返回 -1728，`screencapture` 取不到窗口），
以下全部需要你实机确认。操作说明见第 11 节。

| # | 项目 |
|---|---|
| 1 | 红色关闭按钮在有/无草稿时的实际行为 |
| 2 | 「保存并关闭」后重启应用，数据确实存在 |
| 3 | 「放弃修改并关闭」后数据没有落库 |
| 4 | 「取消，继续编辑」后输入内容仍在 |
| 5 | 保存失败时窗口确实不关（需要在 QA 里制造冲突，见第 11.4 节） |
| 6 | Cmd+Q 是否同样弹出确认框 |
| 7 | 输入中文时方向键不会切换订单（输入法组合） |
| 8 | Cmd+N / Cmd+S / Cmd+F 在真实窗口的焦点表现 |
| 9 | 模板页、客户页、设置页的关窗保护 |
| 10 | 无草稿时关闭窗口是否干净退出（不留幽灵进程） |

---

## 10. 未完成事项与风险

1. **没有做"关闭窗口但保留应用运行"**：macOS 单窗口应用里关窗即退出，实现简单且无歧义。
   若以后要支持"关窗不退出"，需要把 `confirm_close` 拆成 `close_window` / `exit_app` 两个命令。
2. **Cmd+Q 的拦截依赖 Rust 侧事件**：如果将来把窗口改成多窗口，需要重新核对每个窗口的关闭语义。
3. **未做崩溃恢复**：断电/强杀仍可能丢草稿，本轮不做任何承诺。
4. **对话框文案复用了 `UnsavedChangesDialog`**：新增了 `title/saveLabel/discardLabel/stayLabel/hint`
   四个可选属性，默认值保持原行为，既有 12 个用例未改。
5. **构建有一条动态导入提示**：`@tauri-apps/api/core` 既被静态也被动态导入，
   Vite 提示无法单独分包。不影响功能，属于体积优化项，记在这里而不是偷偷忽略。

---

## 11. 给普通 Mac 用户的实机验收说明

### 11.1 打开终端

`Command + 空格` → 输入 `终端` → 回车。

### 11.2 启动（本轮请用 Clean QA）

**先重置空白场景。** 你在 QA-01 验收时已经在 clean 里建过一张测试单（C-QA2），
不重置的话第 5 步"订单列表为空"就不成立。

```bash
cd /Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk
cargo run --manifest-path src-tauri/Cargo.toml --bin qa_seed -- --scenario clean --rebuild
npm run qa:clean
```

第一条命令只影响 `.../dev.artflow.minidesk.qa/clean`，会删掉那张 `AF-2026-0001` 测试单；
seeded 场景与正式台账都不受影响。

看到下面这行才算进了 QA：

```text
[minidesk] env ready mode=qa scenario=clean identifier=dev.artflow.minidesk.qa ...
```

窗口标题应为「ArtFlow miniDesk — QA 测试环境」，顶部有琥珀色横幅。

> 用 clean 是因为要验证"放弃后没有创建订单"，不能用预置数据干扰。

### 11.3 逐项操作

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | 左侧点「订单」→「新建」，标题输入 `关闭测试-A` | 面板出现，标题已填 |
| 2 | 点窗口左上角红色关闭按钮 | 弹出「关闭窗口前有未保存的修改」，三个按钮 |
| 3 | 点「取消，继续编辑」 | 回到表单，`关闭测试-A` 仍在 |
| 4 | 再点红色按钮 → 点「放弃修改并关闭」 | 窗口关闭 |
| 5 | 重新 `npm run qa:clean` 启动 | 订单列表为空，没有 `关闭测试-A`（前提是执行过 11.2 的重置） |
| 6 | 「订单」→「新建」，标题填 `关闭测试-B` → 红色按钮 → 「保存并关闭」 | 窗口关闭 |
| 7 | 重新启动 | 列表里有 `AF-2026-0001`「关闭测试-B」 |
| 8 | 打开该订单，把标题改成 `关闭测试-B2` → 红色按钮 → 「取消」 | 标题仍是 `关闭测试-B2`，未保存 |
| 9 | 客户页：新建客户输入名字 → 红色按钮 | 同样弹出确认框 |
| 10 | 模板页：改模板名 → 红色按钮 | 同样弹出确认框 |
| 11 | 无草稿状态下点红色按钮 | **不弹框**，直接退出 |
| 12 | 重新启动，按 `Cmd+Q` | 应先弹确认框，而不是直接退出 |

### 11.4 制造"保存失败"（可选，第 5 项）

1. 打开一个订单，改标题但**不保存**。
2. 另开一个终端窗口执行：
   ```bash
   cd /Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk
   npm run tauri dev   # 注意：这是正式环境，仅用来制造库锁冲突
   ```
   > 不建议为了这一条去锁正式库。更简单的做法：**跳过第 5 项**，
   > 保存失败路径已由 `App.close.test.tsx`「保存失败时窗口不关闭」覆盖。
3. 若你确实要试：在 QA 里同时打开第二个实例（重复执行 `npm run qa:clean` 会因端口 1421 被占用而失败），
   这不是好办法。**建议跳过**。

### 11.5 快捷键（用预置数据更直观）

```bash
npm run qa:seeded
```

| 操作 | 预期 |
|---|---|
| 订单页按 `Cmd+F` | 光标进入搜索框 |
| 输入 `逾期` | 列表只剩匹配项 |
| 清空后按 `↓` `↓` | 列表出现蓝色描边（键盘光标），但右侧详情**不切换** |
| 按 `Enter` | 右侧打开光标所在订单 |
| 按 `Cmd+N` | 出现新建面板；再按一次不会有第二个 |
| `Cmd+S`（详情脏时） | 保存成功提示；连续按不会重复提交 |

### 11.6 停止应用

终端窗口按 `Ctrl + C`。若窗口还在：

```bash
pgrep -fl artflow-minidesk
kill <上面的 PID>
```

### 11.7 如何报告失败

给我四样：终端里 `env ready` 那一行、你点了什么、期望、实际。

---

## 12. Git 提交

按"机制 / 页面接入 / 测试与文档"三组提交：

```text
1673964 feat(close): guard window close and app exit behind a draft check
228f808 feat(shortcuts): page shortcuts and keyboard-only order selection
1eff2a8 test/docs: window close suite, shortcut suite and DEV-06A report
```

另有两个 QA-01 归档提交（在 DEV-06A 之前）：

```text
29fb2a4 docs(qa01): archive the final acceptance and correct the monthly completion figure
```

未推送远程。
