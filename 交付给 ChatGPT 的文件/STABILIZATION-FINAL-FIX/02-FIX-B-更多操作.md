# FIX-B 更多操作菜单

## 问题

`<details>` 原生不会因点击外部或 Escape 关闭；`summary` 的文本垂直居中依赖行高；菜单还留在详情容器内，可能被滚动区域裁切。

## 修改

新增 `src/components/ActionMenu.tsx`（受控、portal）：

- 点击触发按钮开/关；`aria-expanded` 同步。
- 点击外部（`mousedown`）关闭；Escape 关闭并把焦点还给触发按钮。
- 点击菜单内可用项：先执行，再收起；禁用项保持打开，方便看到禁用原因。
- `position: fixed` + 打开时测量：下方放不下就向上翻；左右夹在视口内。
- 滚动或窗口尺寸变化时关闭，避免菜单脱离按钮。
- 操作栏窄容器分支改用它，删除了旧的 `.action-more` / `.action-more-menu` 样式，只保留一套开关状态。

## 验证

`ActionMenu.test.tsx` 5 项：开关、外部点击、Escape + 焦点、菜单项执行后收起、禁用打不开。
截图 `04-更多操作-900.png`：菜单浮在列表之上（未被裁切），四个操作含取消订单。

Mac 实机：**NOT RUN**。
