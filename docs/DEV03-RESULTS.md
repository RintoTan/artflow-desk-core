# DEV-03 阶段报告：DEV02-UI-01 未保存确认改为模态对话框

- 日期：2026-11-17
- 工程：`/Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk`
- 范围：**仅** 应用内未保存修改确认 UI。DEV-03 的队列排单、客户管理、全局模板**未开始**。
- 状态：修复完成，前端测试 17/17 通过；Rust 侧无改动，160/160 保持通过。

---

## 1. 问题

DEV-02 的未保存提示渲染在页面内容流里（订单详情下方），有三个实际缺陷：

1. **不醒目**：出现在页面底部，长页面需要滚动才能看到，用户容易以为"什么都没发生"。
2. **不是模态**：提示出现时背后的表单、列表仍可继续操作，用户可以绕过它改变状态。
3. **焦点未管理**：提示出现时焦点停留在原处，键盘用户不知道需要处理，Tab 会跑到背后的控件。

## 2. 修复内容

### 2.1 新增组件 `src/components/UnsavedChangesDialog.tsx`

- 通过 `createPortal` 渲染到 `document.body`，`position: fixed` 居中，`rgba(16,30,46,0.34)` 遮罩 + 1.5px 背景模糊。
- 语义：`role="alertdialog"`、`aria-modal="true"`、`aria-labelledby` / `aria-describedby`。
- 标题固定为**「有尚未保存的修改」**，正文按场景区分（切换订单 / 新建订单 / 离开订单页面）。
- 三个操作：**保存并离开**（主按钮）、**放弃修改**（危险色）、**继续编辑**。

### 2.2 八项要求逐条落实

| 要求 | 实现 | 验证 |
|---|---|---|
| 1. 明确标题 | 标题常量「有尚未保存的修改」 | `显示标题与三种操作` |
| 2. 居中 + 遮罩 | `.modal-overlay` fixed inset 0 + grid 居中 + 半透明遮罩 | `以模态方式呈现，并带背景遮罩` |
| 3. 三种操作 | 三个按钮，语义与 DEV-02 一致 | `点击「放弃修改」只触发一次` 等 |
| 4. 默认聚焦继续编辑，Esc 不丢草稿 | 打开时 rAF 聚焦；Esc 监听挂在 `document` 捕获阶段，任何焦点位置都生效 | `默认聚焦「继续编辑」`、`按 Esc 等同「继续编辑」`、`Esc 不会离开页面，也不会丢草稿` |
| 5. 保存失败保留草稿并提示 | 保存失败时对话框不关闭，`error` 以 `role="alert"` 显示，草稿留在表单 | `保存失败时保持打开、显示错误` |
| 6. 阻止确认期间重复导航 | 父组件 `guardBusy` + 组件内部 `inFlightRef` 双重闸门，`busy` 时三个按钮全部禁用 | `处理中禁用全部操作`、`连续点击只触发一次` |
| 7. 键盘操作与焦点恢复 | Tab / Shift+Tab 在对话框内循环；关闭后焦点回到打开前的元素 | `Tab 不会把焦点移出对话框`、`关闭后焦点回到打开前的元素` |
| 8. 针对性测试 | 新增 vitest + Testing Library，17 个用例（10 组件 + 6 集成 + 1 冒烟） | `npm run test` |

### 2.3 订单页接线（`src/pages/OrdersPage.tsx`）

原先有两套守卫：路由级 `useBlocker` 一套、切换订单一套，各自渲染一个 `SwitchGuard`。
现在合并为**单一数据源**：

```tsx
const routeBlocked = blocker.state === "blocked";
const dialogOpen = routeBlocked || manualNav !== null;
const pendingNav = manualNav ?? (routeBlocked ? { kind: "route" } : null);
```

- 路由被拦下时，对话框"就是打开状态"，不再额外用一个 `useEffect` 把 blocker 状态复制到本地 state。
  这是本轮踩到的真实缺陷：早先的写法在 `reset()` 与 `setState` 之间有渲染时序竞争，
  偶发让对话框关掉后又立刻重新弹出（测试里表现为"点了继续编辑但对话框还在"）。
- 改由单一派生状态后，关闭只可能通过 `proceed()` / `reset()` 发生，不存在"本地已关但 blocker 仍阻塞"的中间态。

`saveDraft()` 的返回类型从 `boolean` 改成 `string | null`（错误文案或成功），
使对话框能直接展示保存失败原因，而不用再猜 `draftError` 的时序。

## 3. 测试

### 3.1 新增测试基建

`vitest 4.1.12` + `jsdom` + `@testing-library/react` + `user-event` + `jest-dom`，
配置见 `vitest.config.ts`，入口 `src/test/setup.ts`。`npm run test` 即可运行。

安装时 `npm i -D vitest` 报 `Cannot read properties of null (reading 'edgesOut')`（vite 8 与 vitest 的
peer 解析冲突），改用 `--legacy-peer-deps` 安装成功，运行时无异常。

### 3.2 用例清单（17 个）

`src/components/UnsavedChangesDialog.test.tsx`（10）

1. 显示标题与三种操作，默认聚焦「继续编辑」
2. 以模态方式呈现，并带背景遮罩
3. 按 Esc 等同「继续编辑」，不会丢弃草稿
4. 点击「放弃修改」只触发一次
5. 保存失败时保持打开、显示错误，且草稿未被丢弃
6. 处理中禁用全部操作，避免重复导航
7. 连续点击「保存并离开」只触发一次
8. Tab 不会把焦点移出对话框
9. 关闭后焦点回到打开前的元素
10. 关闭时不渲染任何内容

`src/pages/OrdersPage.guard.test.tsx`（6，真实 `createMemoryRouter` + mock 后的 Tauri bridge）

1. 有未保存修改时导航会弹出模态确认，而不是直接离开
2. 「继续编辑」关闭对话框并留在原地，草稿仍在
3. Esc 不会离开页面，也不会丢草稿
4. 「放弃修改」才真正离开
5. 「保存并离开」先保存再跳转
6. 没有修改时导航不弹对话框

第 8 条要求"避免修改后破坏既有离页保护"由第 2 组覆盖：这 6 个用例走的是
真实的 `useBlocker` + 路由切换路径，不是对组件的孤立调用。

### 3.3 实际执行结果

```text
npm run test     → Test Files 3 passed (3)，Tests 17 passed (17)
npx tsc --noEmit → 通过（exit 0）
npm run build    → 345.00 kB / gzip 107.91 kB，88 ms
cargo test       → 160 passed / 0 failed（Rust 侧本轮无改动）
```

真实应用启动（macOS）：

```text
[minidesk] env ready … generation=gen-e05d7ce65b8d40c0a0d23bedf18476ee schema=v2 tz=Asia/Shanghai
窗口：WIN 35501 owner=artflow-minidesk 1120×760 @ (400,103)
```

## 4. 未覆盖 / 明确不属于本轮

1. **桌面窗口关闭保护仍未实现**（`useBeforeUnload` / 关闭确认属 DEV-06）。
   现在关窗仍会丢草稿——本轮的对话框只覆盖应用内导航与订单切换，**这一点没有改善**。
2. **我没有做人工点击验证。** 本机 `osascript` 返回"不允许辅助访问 (-1719)"，
   `screencapture -l` 返回 "could not create image from window"（无录屏权限）。
   因此模态框的实际观感（遮罩浓淡、动画、真实输入法下的键盘行为）需要用户看一眼。
3. 焦点陷阱只处理 Tab / Shift+Tab 首尾环绕，未实现 `inert` 背景隔离；
   `aria-hidden` 未应用到背景内容（部分读屏器仍可能读到背景）。
   作为 DEV-02 遗留项记录，正式无障碍审查留给后续。
4. 遮罩点击不关闭对话框（有意设计，避免误触丢弃草稿）。

## 5. 需要用户确认

请在有未保存修改时切换订单或点导航，确认：

1. 对话框是否居中、遮罩是否合适；
2. 打开时焦点是否在「继续编辑」上（直接按回车应无任何事发生）；
3. 按 Esc 是否关闭并保留草稿；
4. Tab 是否始终在三个按钮之间循环。

若观感需要调整（例如遮罩更淡、按钮顺序、标题字号），说明即可，改动只在 CSS 与文案。

## 6. Git

```text
docs: DEV-02 manual acceptance update (D02-19/20 → PASS)
test(ui): add vitest + testing-library and unsaved-dialog coverage
feat(ui): replace inline unsaved guard with a centered modal dialog
docs: DEV-03 report for DEV02-UI-01
```

未推送远程。DEV-03 的队列、客户、模板功能未开始。
