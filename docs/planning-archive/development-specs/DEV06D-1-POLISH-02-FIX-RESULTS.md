# DEV-06D-1-POLISH-02-FIX 修复报告

**背景：** POLISH-QA 6 PASS / 2 FAIL —— U2（Finder 拖拽失败）、U8（订单详情宽屏与改造前几乎无差别）。

**状态：** `DEV-06D-1 = OPEN / PARTIALLY ACCEPTED`。U8 已重构并有 Blink 证据；U2 的**真实 Finder 拖放仍是 NOT RUN**。

---

## 一、先检查，再动手：现状事实

### 1.1 订单详情由哪些组件渲染

`.orders-detail` 是详情根节点，渲染顺序（cards 视图）：

| 顺序 | 模块 | 渲染位置 |
|---|---|---|
| 1 | 订单头（编号 / 状态 / 标题 / 当前阶段 / 金额 / 版本）+ 操作栏 + 内联确认条 | `OrdersPage.tsx` 内联 `<section className="panel">`，操作栏是本地组件 `ActionBar` |
| 2 | 排期概览 | `src/components/ScheduleOverview.tsx` → `ScheduleOverview` |
| 3 | 资料（可编辑表单） | 内联 `<section className="panel">` + 本地组件 `DetailsForm` |
| 4 | 参考图片 / 附件 | `src/components/AttachmentPanel.tsx` |
| 5 | 制作流程与阶段操作 | `OrdersPage.tsx` 本地组件 `StagePanel` |
| 6 | 制作历史 | `OrdersPage.tsx` 本地组件 `EventTimeline` |

### 1.2 为什么 `form-grid auto-fit` 没带来布局变化

因为它只作用在**「资料」这一个面板内部**的字段排布上（`repeat(auto-fit, minmax(200px,1fr))`）。当时 `.orders-detail` 是 `display:flex; flex-direction:column`，六个模块**永远上下堆叠、每个都占满详情宽度**——面板级的纵向堆叠没有被任何规则改变，所以宽屏看起来只是"表单一行多放了一个字段"，整体版式没有差别。这不是字段 CSS 的问题，是容器缺少二维布局。

### 1.3 列表与详情的可用宽度（实测，Blink 900–1920）

- 订单列表：`.orders-layout` 固定 `320px` 一列（窄容器下才改成单栏）。
- 详情宽度 = 主内容区宽 − 320 − 16 间距；900px 窗口会先进入单栏，列表在上、详情独占整宽。

| 窗口 | 主内容区 | 详情实测宽 | 布局 |
|---|---|---|---|
| 900 | 585 | **585** | 单栏（列表在上） |
| 1200 | 885 | **551** | 单栏（列表 320 + 详情 551） |
| 1400 | 1085 | **751** | 单栏 |
| 1680 | 1365 | **1031** | **双栏 615 + 380** |
| 1920 | 1605 | **1271** | **双栏 764 + 471** |

数据来自探针 `detailLayout`（`scripts/layout-probe.mjs` 新增），量的是 `getBoundingClientRect()` 实际值，不是推算。

### 1.4 文件拖拽的完整调用链

```
Finder 拖入
  → Tauri 2 在 webview 层接管（tauri.conf.json 未关闭 dragDrop，默认开启）
  → getCurrentWebview().onDragDropEvent(payload)
       payload: { type: "over" | "drop" | "leave", paths: string[], position: {x,y} }
  → AttachmentPanel 的 useEffect 订阅
  → partitionImagePaths(paths)            仅按扩展名预过滤（png/jpg/jpeg/webp）
  → attachmentApi.import({ orderId, sourcePaths })
  → invoke("attachment_import", { input })
  → Rust commands::attachments::attachment_import
  → domain attachments::import()           魔数解码、100MB 上限、落盘、写 attachments / attachment_jobs
  → 返回 ImportOutcome[]，面板 reload 并提示成功/失败
```

---

## 二、U8：详情整体重构

### 2.1 结构

订单头 + 操作栏仍是整宽（它是"这张订单是谁、能做什么"，不属于任一列）。其下新增两层容器：

```
.orders-detail            container-type: inline-size; container-name: detail
└─ .detail-columns        grid；窄=1 列，宽=1.62fr + 1fr
   ├─ .detail-col-main    资料（DetailsForm + 保存/还原）、参考图片（AttachmentPanel）
   └─ .detail-col-side    排期概览、制作流程（StagePanel）、制作历史（EventTimeline）
```

- **不用 `order` 或绝对定位重排**：只是 DOM 顺序与 grid 列位，模块始终挂载。
- 断点用 `@container detail (min-width: 860px)`，即详情自己还剩 860px 才分栏；**与窗口宽度无关**。
- 860 的来历：1400px 窗口详情只有 751px，拆成 60/40 后主列约 450px，表单会从三列退到两列并开始挤；1680px 详情 1031px 才有舒适的 615/380。
- 草稿安全：`DetailsForm` 的 `draft` 状态在 `OrdersPage` 顶层，分栏/单栏只是 CSS 变化，不触发卸载。

### 2.2 实测（探针 `detailLayout`）

| 窗口 | 详情宽 | grid 列 | 主列 | 辅列 | 辅列在主列右侧 |
|---|---|---|---|---|---|
| 1400 | 751 | `1fr`（单列） | 731 | 731 | false |
| 1680 | 1031 | `615.219px 379.781px` | 615 | 380 | **true** |
| 1920 | 1271 | `763.625px 471.375px` | 764 | 471 | **true** |

主/辅比例 61.8% / 38.2%（1680）与 61.9% / 37.1%（1920），落在要求的 60–65% / 35–40% 内。

### 2.3 A / B 截图

- A：`01-详情-1680-双栏.png` —— 1680×800，资料与附件在左、排期与制作流程在右，同一水平区域并列。
- B：`02-详情-1400-单栏.png` —— 1400×800，两组模块恢复上下单列，表单按整宽三列排布。
- 参照：`05-改造前-1400.png`（上一轮 POLISH-02 的同一页面）。三者信息位置差异明显，不是字段层面的微调。
- 深色：`03-详情-1680-双栏-深色.png`。

---

## 三、U2：Finder 拖拽诊断与修复

### 3.1 检查结果

| 检查项 | 结论 |
|---|---|
| Tauri 是否开启拖拽接管 | `tauri.conf.json` 未设置 `dragDropEnabled`，默认 **true**，窗口确实会接管文件拖放 |
| `over` / `leave` / `drop` 是否订阅 | 都订阅了；`over` 只改高亮，`leave` 清除 |
| 坐标与矩形是否同一坐标系 | **不一致风险**：`payload.position` 在 Tauri 2 是物理像素，代码按 `devicePixelRatio` 换算；若运行环境给的是逻辑像素，换算后坐标只有一半，落点判定直接失败 |
| 落点判定是否准确 | 旧的 `drop` 分支把"命中矩形"当作是否导入的**闸门**：一旦坐标换算不匹配，拖到面板上也不会导入，且没有任何反馈 |
| 路径传递 | `payload.paths` 直接进 `attachment_import`，路径本身没有转换问题 |
| 重复事件 | 同一次拖拽可能连发 `drop`，旧代码没有去重 |
| 失败反馈 | 旧代码命中失败时**静默丢弃**，用户看不到任何提示 |
| 点击选择图片 | 走 `openDialog` → `importPaths`，与拖拽共用同一导入函数，未受影响 |

### 3.2 改动

1. **`drop` 不再被坐标判定挡住**：面板只在"已选中订单"时挂载并订阅，drop 本身就是"给当前订单"的意图，因此直接导入 `payload.paths`；坐标只用于 `over` 高亮。
2. **高亮命中改为双刻度**：同时按 `1` 和 `devicePixelRatio` 试算，并对齐到 `.orders-detail` 面板矩形（外扩 8px），逻辑/物理两种坐标都能命中。
3. **去重**：800ms 内的重复 `drop` 只处理一次。
4. **空路径明确报错**：`paths.length === 0` 时提示"没有拿到文件路径：请从 Finder 直接拖到面板上，或点「选择图片」"，不再静默。
5. 前置扩展名过滤（`partitionImagePaths`）与后端校验、存储语义、权限均未改。

### 3.3 仍未验证的部分（NOT RUN）

- **真实 Finder 拖放没有在本轮执行**：jsdom 与 Blink 都无法产生 Tauri 的 `drag-drop` 事件，不能把模拟通过当成实机通过。
- 上述"物理/逻辑像素"是**基于代码与 Tauri 2 文档的推断**，没有在 Mac 上抓到真实 `payload.position` 作为证据。

**实机复验步骤：**

1. 用 QA identifier 启动应用（`dev.artflow.minidesk.qa`），场景 `seeded`，打开任一订单。
2. 从 Finder 拖 1 张 PNG 到参考图片空状态上：面板应出现强调色描边；松手后出现"已导入 1 张图片"，缩略图出现。
3. 再拖 1 张 JPG 到已有图片区域：应追加到同一订单，提示"已导入 1 张图片"。
4. 拖入 `.gif` / `.pdf`：应弹出"不支持 .gif，只接受 PNG / JPEG / WebP"，且**不产生**附件记录。
5. 拖入 >100MB 的 PNG：应显示后端拒绝原因，列表不变。
6. 拖拽中途移出窗口再移回：高亮应正确熄灭/恢复，不应重复导入。
7. 全程结束后核对 `attachment_list` 的数量与文件名。

---

## 四、设计审查（不只报测试通过）

### 4.1 尺寸与优先级

- 1680：主列 615px（资料表单三列字段、附件网格），辅列 380px（排期 183px 高、制作流程、历史）。
- 视觉优先级：订单头（标题 22px + 状态胶囊）> 主列表单（15px 字段标签、13px 输入）> 辅列（14px 小节标题、12.5px 说明）；强调色只出现在主操作「推进阶段…」与选中订单卡。
- 排列顺序：先"这张单要做什么"（资料/附件），再"做到哪一步、什么时候交"（排期/流程/历史），符合任务给出的职责划分。

### 4.2 宽屏是否真的减少纵向堆叠

实测 `.orders-detail` 高度：1400px 单栏 **1640px**、1680px 双栏 **1033px**。两者窗口宽度不同，不能换算成百分比；能确认的是：双栏时右列独立承担 746px 的排期/流程/历史，主列只放资料与附件，不再把这些内容串行堆在表单下面。

### 4.3 深浅色对比

- 浅色：正文 `#1f2a33` on `#ffffff`／`#f7fafd`，说明文字 `--text-muted` 仍 ≥ 4.5:1；输入框边框 `--border-strong` 在 1px 下可辨。
- 深色：正文 on `#151b22`／`#1b222b`，卡片边界靠 `--border` 与半透明表面区分；强调色按钮文字保持白字（截图 03）。
- 唯一需要盯的：深色下 `--accent-soft` 的选中订单卡与卡片底色差距较小（截图 03 左侧列表），不影响可读性，但实机可再确认。

### 4.4 未达成的设计目标

- 1680 以下（含 1400）仍是单列：这是刻意保留的"详情不够宽不强行分栏"，不是未完成。若产品希望 1400 也分栏，需要把列表压到 260px 或允许主列降到 ~450px。

---

## 五、测试结果

| 项目 | 结果 |
|---|---|
| `npx tsc --noEmit` | 通过 |
| `npm run build` | ✓ built in 110ms |
| `npx vitest run` | **370 passed / 42 files** |
| `npm run layout:check`（900/1400/530，Blink） | **27/27 通过** |
| 真实 Finder 拖放 | **NOT RUN** |
| Mac WKWebView 任何像素表现 | **NOT RUN** |

新增测试：`OrdersPage.stageOps.test.tsx` 增加 1 项——详情主列包含「资料」「把参考图片拖到这里」，辅列包含「制作流程」，且两列是同一父节点的兄弟。

## 六、保护范围

未改：订单三视图与筛选、阶段推进/返工约束、revision、历史事件、数据表、CSV 白名单、客户/统计/模板/设置功能、正式台账与 QA 数据。未实现 STAGE-SKIP / EXPORT-01 / SETTINGS-03 / UX-08 / UX-09。

## 七、提交

- `208aa1d` 代码：详情主/辅两列 + Finder 拖拽修复 + 探针 `detailLayout` + 1 项结构测试
- 本报告与交付包单独提交
