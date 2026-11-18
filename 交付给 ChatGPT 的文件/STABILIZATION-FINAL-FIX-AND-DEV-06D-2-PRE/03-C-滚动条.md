# FIX-C 深色订单列表滚动条

## 审计结果

- 全站已无 `::-webkit-scrollbar` / `scrollbar-width` / `scrollbar-color` 规则（grep 为 0）。
- 订单列表 `.order-rows` 是 `overflow-y: auto`，没有 `scroll` 强制常驻；`scrollbar-gutter: auto`（本轮显式写出）。
- 深色主题只有 `color-scheme: dark`，它会让**浏览器原生**滚动条变深色，这是正确行为，不是 UI 自定义。
- 另发现旧补丁 `.orders-detail { padding-right: 8px }` + `.orders-detail > * { margin-right: 12px }` 会给详情右侧加一条无内容窄带，已删除（这条也可能是"右侧窄白栏"观感的来源之一）。

## 本轮改动

1. 删除上述二次内缩，留白统一由 `.main-inner` 负责。
2. `.order-rows` 显式 `scrollbar-gutter: auto`，并加 `padding-inline-end: 4px`，让排序箭头不贴轨道。

## 为什么不再自定义滚动条

Mac 系统"显示滚动条：始终"会画出 15px 原生轨道；之前自定义的 10px 深灰轨道在浅色主题下反而更突兀。任务要求优先平台一致，因此不再覆盖系统行为。

## Mac 复验方法（区分原生/自定义）

1. 系统设置 → 外观 → 显示滚动条：切成「自动」与「始终」各看一次订单列表右缘。
   - 只有「始终」时出现粗轨道 → 属系统行为，非 UI 缺陷。
   - 两种设置都出现同一条 10px 深灰轨道 → 仍有自定义规则残留，请截图并附 computed style。
2. Safari 开发者 → 检查 `.order-rows`，确认 `scrollbar-gutter: auto`、无 `::-webkit-scrollbar` 命中。
3. 深色与浅色各截一张 900px 订单页右缘。

Blink 参考：`screenshots/05-订单-深色-900.png`（覆盖式、细滚动条）。
