# DEV-06D-1-POLISH-02 实施报告

**状态：** `DEV-06D-1 = OPEN / PARTIALLY ACCEPTED`，等 POLISH-QA 实机验收。

**未改动：** identifier、编号规则、生命周期/revision/历史事件语义、CSV 字段白名单、模板快照隔离、正式 v3 台账与现有 QA 数据、远程仓库。

---

## P1 订单危险操作区

- 操作栏拆成两组：`制作进度`（开始制作 / 撤销开工 / 推进阶段…）与 `订单状态`（完成 / 取消订单… / 重新打开）。两组之间用竖线分隔并右对齐，窄容器（≤780px）换行时自动去掉分隔线。
- 取消订单改为**独立确认框**：标题「取消这张订单？」，danger 样式，确认按钮「确认取消订单」，取消按钮「保留订单」；正文写清“退出活动队列、流程锁定、阶段与开工记录保留、可用重新打开恢复、不删除数据”。
- 主操作层级：只有真正可用时才上主色（开始制作 / 推进阶段互斥），危险操作使用描边危险色，不与主操作争视觉重量。
- 生命周期、revision、权限约束未变；没有新增越级写入。

## P2 参考图片上传

- 空状态整块是按钮式拖放区：「把参考图片拖到这里 / 或点击选择图片」，点击走原有 `openDialog` + `attachmentApi.import`。
- 已有图片时，拖入会追加到同一张订单，并在网格上方提示“松开鼠标，把图片追加到这张订单”；面板获得焦点样式。
- 拖拽路径订阅 Tauri `getCurrentWebview().onDragDropEvent`（over/leave/drop），按落点是否落在面板矩形内决定高亮与接收；浏览器预览里没有该事件时退回点击选择。
- 新增纯函数 `partitionImagePaths`：先按后端白名单（png/jpg/jpeg/webp）过滤，不合法的逐张给出原因（“不支持 .gif”“没有扩展名”），合法项继续交给原有导入命令，避免一张坏文件让整批静默失败。格式与 100MB 上限的最终校验仍在 Rust 侧。
- 处理中显示“正在导入 N 张…”，成功走 `onNotice`，失败走 `onError`。图片数据、路径与权限语义未变。

**限制：** 真实文件拖拽依赖 Tauri 窗口事件，Blink 与 jsdom 都不能验证；本轮只验证了扩展名过滤与界面状态。

## P2 客户页面

- 页面根节点加 `clients-page`：宽容器 290px 列表 + 自适应详情；沿用既有 `@container workspace (max-width: 780px)` 单栏规则，窄屏列表在上、详情在下。
- 列表高度改为 `calc(100dvh - 96px)`（给 QA 横幅留位），列表体 `overflow-y: auto` + `scrollbar-gutter: auto`，不预留常驻槽位，滚动条交给 macOS 原生覆盖式表现。
- 筛选、选择、保存、未保存保护、同名不合并全部保留（未改数据层）。

## P2 历史统计

- 四个范围改为 `.segmented` 分段控件：2px 间隙、内嵌底槽、选中项只抬一层白底，宽 content、不被平均推到两端。
- 范围、时区、统计口径与图表计算未改；窄屏允许换行（`flex-wrap`）。

## P2 数据环境

- 五项指标加 `stat-row-metrics`：`repeat(auto-fit, minmax(150px, 1fr))` 等宽自适应，窄屏自动换行；数字 22px、统一 padding 14/16、tabular-nums。
- 数据全部来自既有 `status` 命令，没有新增指标；只读与诊断功能未动。

## P2 流程模板

- 操作分三组：保存模板（主色）+ 还原修改；设为默认 + 复制为新模板；删除模板…（描边危险色，独立分组，仍在既有 ConfirmDialog 里确认）。
- 按钮统一 8px 间距、可换行不截断；模板快照/版本/历史订单规则未动。

## P2 设置页面

- 外观区改为 `settings-modules`：主题模式、强调色两个模块并排（`minmax(260px,1fr)`），应用图标为整行模块；窄容器自动堆叠。
- 颜色输入限制为 72px 色卡，不再被模块宽度拉成一条；主题草稿、保存、恢复、图标选择逻辑未改。

## 已批准的 POLISH-02 项

- 订单详情：列表固定宽，详情内部 `form-grid` 为 `auto-fit minmax(200px,1fr)`，不使用固定三列；单栏时按内容重排。
- 表单控件：`select/textarea` 补齐 `min-height: var(--control-h)`、统一圆角/边框/字号；`.actions` 改为 flex + 8px 间距。
- 导出对话框：说明“UTF-8 CSV、逗号分隔、首行表头、只含业务字段、不含联系方式/备注/路径”，两个范围都显示真实条数，主按钮改为「导出 CSV」；保存仍走 macOS 原生对话框，字段白名单未改。

---

## 测试结果

| 项目 | 结果 |
|---|---|
| `npx tsc --noEmit` | 通过 |
| `npm run build` | ✓ built in 169ms |
| `npx vitest run` | **367 passed / 42 files** |
| `npm run layout:check`（900 / 1400 / 530，Blink） | **27/27 通过** |

本轮新增测试：

- `src/lib/attachmentDrop.test.ts`（3 项）：白名单、大小写、无扩展名、混合拖入只放行合法项。
- `OrdersPage.stageOps.test.tsx` 增加 2 项：取消订单独立确认框（保留订单零写入）、确认取消只调一次命令。
- `AttachmentPanel.test.tsx` 空状态断言改为新的拖放区文案。
- `TemplatesPage.delete.test.tsx` 与 `OrdersPage.export.test.tsx` 跟随按钮文案调整（删除模板…、导出 CSV）。

未运行 Rust 套件：本轮没有改 Rust 代码。

## 截图（Blink，非 WKWebView）

| 文件 | 页面 | 宽度 | 主题 |
|---|---|---|---|
| 02-订单-900.png | 订单卡片 + 分区操作栏 | 900 | 浅色 |
| 03-导出-900.png | 导出 CSV 对话框 | 900 | 浅色 |
| 04-客户-1400.png | 客户主次工作区 | 1400 | 浅色 |
| 05-统计-900.png | 分段控件 | 900 | 浅色 |
| 06-设置-1400.png | 设置模块 | 1400 | 浅色 |

## 未完成与风险

1. **Mac WKWebView 全部 NOT RUN**：滚动条、拖拽、面板渲染均只有 Blink/jsdom 证据。
2. **深色主题无有效截图**：`data-theme=dark` 能切，但本轮没有产出可核对的深色截图；深色一致性只由变量与既有守卫保证。
3. **图片拖拽实机未验**：Tauri 的 `onDragDropEvent` 处理只做了类型与降级处理，未在真机拖过文件。
4. **1100px / 更宽窗口未出截图**：layout:check 覆盖 900/1400/530；客户页 1400 与设计一致，1100 未单独截图。
5. **探测夹具缺陷已修但暴露局限**：`JSON.stringify` 会丢掉函数夹具，导致 `client_detail` 曾返回 null；已改为纯数据夹具。后续夹具不要用函数。
6. 受控越级（stage_skipped）未实现，按裁定等本收尾后单独进行。
