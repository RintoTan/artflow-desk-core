# DEV-06D-1 结果报告（含 FIX 轮）

- 日期：2026-11-17
- 范围：订单三视图（卡片/看板/表格）、订单来源字段、客户标签与动态统计、v4→v5 数据结构
- 状态：**代码与自动化验证完成；Mac 实机验收未做**
- 本报告只写**本轮实际重新执行**的结果；上一轮的数字仅作历史基线标注

---

## 0. 本轮最重要的一条：上一轮对 SQLite CHECK 的诊断是错的

上一轮报告写：

> 实测 `ALTER TABLE ADD COLUMN` 的跨列 CHECK 不会被强制执行。

**这个结论不成立。** 本轮用 `sqlite3 3.54.0` 在隔离临时库做了对照实验：

| 实验 | 表达式 | 结果 |
|---|---|---|
| A 建表即带 CHECK | `(g = 0 OR role = 'final')` | `g=1, role=NULL` **写入成功** |
| B 建表即带 CHECK | `(g = 0 OR role IS 'final')` | `CHECK constraint failed` **拒绝** |
| C `ADD COLUMN` 带 CHECK | `(g = 0 OR role = 'final')` | **写入成功** |
| D `ADD COLUMN` 带 CHECK | `(g = 0 OR role IS 'final')` | **拒绝** |
| E 合法路径 | `role='final', g=1` | 通过 |

真正的原因是**三值逻辑**：`role` 为 NULL 时 `role = 'final'` 求值为 NULL，
SQLite 把 NULL 当作"未违反"。`ADD COLUMN` 本身是正常执行约束的。
我当时把"NULL 放过"误读成"ADD COLUMN 不生效"，并且据此把规则从数据库层撤到领域层——**这是错的修法**。

另外：`sqlite3` CLI 是 3.54.0，而项目用 `rusqlite 0.43`（`bundled`），二者不一定同版本。
因此约束验证不能只靠 CLI，必须在 Rust 测试里用项目自己的 SQLite 跑——见 §8。

### 0.1 处置：新增 v5，用触发器补上数据库层约束

- **不改 v4**：实测 QA `gen-3f3b125…` 已经是 `user_version=4`，改旧迁移文件不会回头作用于已迁移的库，
  只会让新库与旧库结构分叉。
- **不重建 `attachments`**：SQLite 不支持 `ALTER TABLE ADD CONSTRAINT`，重建表要搬数据、重建索引与外键，
  风险远大于收益，且属于"擅自重建已有持久化数据"。
- **用触发器**：对 INSERT 与 UPDATE 都生效，对已存在的行与已迁移的库同样生效，无需搬数据。

```sql
CREATE TRIGGER attachments_gallery_visible_insert
BEFORE INSERT ON attachments
WHEN NEW.gallery_visible = 1 AND (NEW.role IS NULL OR NEW.role <> 'final')
BEGIN SELECT RAISE(ABORT, 'gallery_visible 需要 role = final'); END;
-- UPDATE OF role, gallery_visible 同样一条
```

领域层校验保留（错误文案更友好），数据库触发器兜底。**双层保护成立。**

---

## 1. 最终产品决策与实现范围

| 编号 | 决策 | 本轮实现 |
|---|---|---|
| P1 | 保留卡片列表，增加看板与真正的多列表格 | 三视图共存，列表未重写 |
| P2 | 增加可选 `orders.source` | 已实现（可空、≤40 字、空白归一 NULL） |
| P3 | 看板拖拽切阶段，只走已有合法动作 | 已实现；见 §4 |
| P4 | 看板按当前制作阶段分列 | 已实现；见 §3 |
| P5 | 日历单日拖放（DEV-06D-3） | **未实现（本轮不做）** |
| P6 | 客户优先手工标签，不做自动等级 | 已实现 |
| P7 | 画廊复用 `attachments` | 只建结构（role / gallery_visible），无画廊 UI |

> 这七项是任务书给出的建议口径。我按它实施，但**不把它们记为用户已批准的决策**——
> 需要产品所有者在验收时确认。

不在范围（且未做）：收款/实收/欠款、新的生命周期状态、自动归档、日历、工作台时间线、
画廊 UI、在线发布、永久删除、ZIP 备份、客户删除、主题编辑器、Finder 拖拽导入。

---

## 2. 三种订单视图

| 视图 | 实现 | 与既有能力的关系 |
|---|---|---|
| 卡片 | 未改动 | 保持 78px 行高、密度切换、搜索/筛选、拖拽排序、键盘导航、自动滚动、长标题气泡、双栏详情 |
| 看板 | `src/components/OrderBoard.tsx` + `src/lib/board.ts` | 按阶段分列；列头 `数量 · 已知金额合计`；终态单列区 |
| 表格 | `src/components/OrderTable.tsx` | 10 列（编号/客户/标题/来源/类型/阶段/状态/计划交付/已知金额/排期），列头可排序 |

视图选择存 `preference("orders_view_mode")`，三种视图共用同一份 `orders`、同一套筛选与同一个 `selectedId`。

**明确没有**：实收、已收款、未收款、收款差额。本项目没有收款事实，不造列。

看板/表格模式下容器类为 `.view-board` / `.view-table`，网格变单列（`minmax(0,1fr)`），
详情面板排在下方——沿用既有窄窗行为，不引入新的导航模式。

### 2.1 本轮修掉的一个真实视觉缺陷

首版看板卡片标题没有截断：一条长标题就把整列拉到 300px+，横向滚动条被推到很远的位置。
用 `-webkit-line-clamp: 2` + `overflow-wrap: anywhere` 修掉，改前改后都有截图对比。

---

## 3. 跨模板阶段归组

- **列 = 规范化阶段名**：`trim` + 压空白 + 忽略大小写（`stageKey`）。
  原因：不同模板的阶段 ID 不同，按 ID 分列会把同一件事拆成两列。
- **列顺序**：按成员在各自流程里的最小阶段序号升序，其次按名称。跨模板时得到"大致从左到右推进"的稳定顺序。
- **拖动时回到目标订单自己的阶段表里解析 ID**：列名只是展示，绝不拿列名写库。
- **解析不唯一就拒绝**：该订单没有这个名字的阶段 → 拒绝；该订单有两个同名阶段 → 拒绝并说明。
- **未开工**：仍显示在它自己的阶段列里，卡片带「未开工」标签；拖动会被领域规则拒绝。
- **终态**：单独「已结束」区，不进阶段列、不可拖。
- **无当前阶段**（正常数据不会出现）：单独「没有当前阶段」区，点击可进详情。

---

## 4. 看板拖动实际使用的业务动作

| 目标列 | 判定 | 实际调用 |
|---|---|---|
| 下一阶段 | `targetIndex == currentIndex + 1` | `advance_stage` |
| 更早的阶段 | `targetIndex < currentIndex` | `rework_stage { targetStageId }`（领域层支持指定更早目标，含"多阶段返工"） |
| 当前阶段 | 同列 | 不产生动作（`noop`） |
| 跨两个及以上阶段 | `targetIndex > currentIndex + 1` | **拒绝**，提示逐阶段推进或在详情处理 |
| 终态订单 | `status != active` | **拒绝** |
| 未开工返工 | `started_at IS NULL` | **拒绝** |

**没有任何一处直接 `UPDATE current_stage_id`。** 阶段变更全部经 `domain/lifecycle.rs`，
沿用其 revision 校验、`stage_advanced` / `stage_reworked` 事件与可延迟外键约束。

确认流程：拖动只形成候选 → 应用内模态显示"将执行：推进/返工，从 X 到 Y（退回 N 步）" →
确认才调后端；取消零写入（有组件测试断言 `onApply` 未被调用）。

冲突处理：`getOrder` 取最新 revision 后再提交；若仍冲突，刷新列表并提示"看板已刷新，请重新拖动"，
不做部分写入。

### 4.1 不支持的阶段跳转

跨多阶段推进、跨模板搬运、终态改阶段、未开工返工——四类都已在前端给出具体原因，
不是静默失败。

---

## 5. 来源字段

- 语义：接稿渠道，自由文本，不与支付平台或客户身份混用。
- 校验：`trim` 后为空 → NULL；>40 字 → 拒绝。正式四张订单保持 NULL（未回填任何虚构值）。
- 入口：新建订单与详情资料两处，共用 `datalist` 建议（来自现有来源，减少同义重复）。
- 筛选：「所有来源 / 未设置 / 具体来源」三者语义不同——`""` 专指未设置，`"all"` 才是不筛。
- 搜索：标题 / 编号 / 客户 / 来源 都可命中。
- 看板、表格、卡片三处使用同一字段与同一套筛选（`filterOrders({ source })`）。

---

## 6. 客户标签与动态统计

**标签**：创建、挂载、解除、按标签筛选、管理全部标签。

- 空名称与 >20 字拒绝；重名**明确拒绝**而不是静默合并（合并会让用户以为新建成功，实际挂到别的标签）。
- 挂载/解除**幂等**：重复操作结果相同。
- **仍被使用时拒绝删除**，并说明"N 位客户"，让用户先解除关联；
  不依赖外键 CASCADE 静默抹掉关系。
- 挂标签**不改 `clients.revision`**：标签是关联表行，不是客户资料字段。
  已验证与既有编辑/并发保护相容——编辑表单不会因为别处挂了标签被误判冲突（有测试）。

**统计**（全部按现存订单实时算，不建冗余计数列）：

- 当前关联订单数：含已完成与已取消；永久删除后随剩余订单重算。
- 已知委托金额合计：`SUM(amount_cents)`，NULL 不计入，也不当成 0。
- 最近下单时间：`MAX(created_at)`，前端按**工作时时区**格式化（不在 SQL 里截日期）。
- 命名刻意避开"实收/已收款"，界面上写明"这里没有收款事实"。

**跳转**：从客户页去订单页用 `?client=<id>`，按稳定 ID 过滤，不靠名称猜（名称可重复）。

---

## 7. 三种视图与来源的回归

- 视图切换**零业务写入**：无头浏览器在切换到看板/表格后读 `window.__MINIDESK_CALLS__`，
  业务命令计数为 0（仅写 `preference` 一个偏好键，属任务书允许的持久化）。
- 表格排序只影响当前展示，不写回 `queue_position`。
- 卡片列表没有回归：`layout:check` 的行高、可见行数、气泡、导航对齐断言全部保留并通过。

---

## 8. v4 / v5 迁移与失败回滚

| 项 | 结果 |
|---|---|
| 空库到当前版本 | 通过（`schema_v4::v4_empty_database_has_all_new_structures`） |
| v3 副本升级 | 通过：订单/客户/模板/附件数量不变，事件不变，`user_version` = 5 |
| 旧订单来源 | NULL（不回填） |
| 旧附件 | `role=NULL`、`gallery_visible=0`（不自动公开） |
| NULL 金额 | 保持 NULL，未被写成 0 |
| 主题 / 强调色 / 图标设置 | 升级后保持（`dark` / `wave-a` 逐项断言） |
| 编号高水位 | 升级不触碰；再发号仍递增（断言 `next > before`） |
| 外键 | `pragma_foreign_key_check` = 0 |
| 迁移失败回滚 | 通过：注入坏 v4 → 打开失败 → 再打开得到单份 `source` 列，证明整步回滚 |
| v4 → v5 | 通过：已迁移的 v4 库拿到两个触发器，结构不变 |

**Rust 侧约束验证**（用项目自带 bundled SQLite，不依赖 CLI 版本）：

| 用例 | 期望 | 结果 |
|---|---|---|
| INSERT `visible=1, role=NULL` | 拒绝 | 通过 |
| INSERT `visible=1, role='reference'` | 拒绝 | 通过 |
| INSERT `visible=1, role='final'` | 通过 | 通过 |
| UPDATE 先设 `visible=1`（role NULL） | 拒绝 | 通过 |
| UPDATE `role='reference'` 后再设可见 | 拒绝 | 通过 |
| UPDATE 成品 → 隐藏 | 通过 | 通过 |
| UPDATE 成品（可见）→ `role=NULL` | 拒绝 | 通过 |

---

## 9. 正式 v3 数据未被升级的只读证据

```
active.json        gen-c00a879220964299af7adcef8b9fc1c5（未变）
user_version       3
orders             4
clients            1
stage_templates    2
attachments        2
order_events       23
completed events   4
cleanup_tasks done 8
orders.source 列   0（说明 v4 从未应用）
identifier         dev.artflow.minidesk（未变）
database.sqlite    mtime 2026-11-17 16:00:06，size 196608
```

**必须披露的一处副作用**：本次用 `sqlite3 -readonly` 打开正式库时，
WAL 模式在正式代际目录里生成了 `database.sqlite-shm`（32768 字节，22:55）。
**数据库文件本身 mtime 未变（16:00）、内容未变（上面的计数与版本均可复核）。**
后续只读核查应改用 `?immutable=1`，避免在正式目录里留下附属文件。
没有删除该 shm（删文件也是写操作）。

**没有**为核查而启动正式 identifier 的新版应用；正式 identifier 与 QA identifier 均未改。

### 9.1 QA 现状（未重建）

| 环境 | 代际 | user_version |
|---|---|---|
| QA seeded active | `gen-3f3b12539b2a48148f73df38cfec6bfe` | **4** |
| QA seeded 另一代 | `gen-7da0bded…` | 3 |
| QA clean | `gen-fa11de2e…` | 3 |

QA 未清空、未重建。seeded 已是 v4，正好构成"已迁移库需要 v5"的真实证据。

---

## 10. 布局回归：6 项失败的真实原因

上一轮报 6 项失败（`/orders @1400/900/530` 与 `orders schedule @1400/900/530`）。
本轮首先重跑并保存完整输出，逐项分类：

**三项都是同一个探针错误，不是布局回归。**

- 探针用 `layout.children[1]` 取详情。
- 我在布局里插入 `<datalist>`（来源建议）后，`children[1]` 变成了 `.orders-list`。
- 于是"列表 vs 详情"实际变成了"列表 vs 列表"，重叠面积等于整块列表面积：
  1400 下 320×636 = **203520**，与失败值完全一致。
- 上一轮我只改了 `PROBE_MUTATE` 分支的同一个写法，**主测量那处没改**——这是"修了两份拷贝中的一份"。

修正：主测量也改为 `document.querySelector(".orders-detail")`，并加注释说明为什么不能用子节点序号。

**修复后：`npm run layout:check` → 24/24 全部通过。** 没有删除断言、没有放宽阈值、没有跳过测试；
新增的看板/表格几何断言保留并通过。

补充测量（不进入门禁，作为附加证据）：

| 场景 | 页面横向溢出 | 内部滚动 | 业务写入 |
|---|---|---|---|
| 看板 @880（最小窗口） | 无（880 = 880） | 有 | 0 |
| 表格 @880 | 无 | 有 | 0 |
| 看板 @900 + 侧栏折叠 | 无 | 有（内容宽 749） | — |
| 表格 @900 + 侧栏折叠 | 无 | 有 | — |

---

## 11. 自动化结果（本轮重新执行）

| 项 | 结果 |
|---|---|
| `cargo test`（Rust 全量） | **311 passed / 0 failed** |
| `npx tsc --noEmit` | 通过 |
| `npx vitest run` | **39 files / 346 tests passed** |
| `npm run build` | 通过 |
| `npm run layout:check` | **24 / 24 通过** |
| 新增 Rust 测试 | `schema_v4`(6)、`schema_v5`(4)、`client_tags`(6)、`attachment_gallery`(4) |
| 新增前端测试 | `board.test.ts`(14)、`OrderBoard.test.tsx`(6)、`ClientsPage.tags.test.tsx`(9)、`ordersView` 来源断言(2) |

---

## 12. 尚未通过 Mac 实机验收

全部 UI 结论来自 **Blink（无头 Chrome）+ jsdom**，**没有**在 WKWebView 里点过：

- 看板拖拽的真实指针行为（HTML5 drag 在 WKWebView 里的事件顺序）。
- 三视图切换后的滚动位置与焦点恢复。
- 看板确认模态的焦点陷阱与 Esc（与既有 `ConfirmDialog` 是两套实现，需实机确认）。
- 标签下拉的 popup 渲染、长标签换行。
- 深色主题下看板卡片与表格斑马的对比（截图可看，但仍是 Blink 渲染）。
- 880px 与 400px 矮窗口下的实际观感。

---

## 13. 后续阶段依赖

- **DEV-06D-2（工作台时间线）**：只读，复用 `scheduleBar` + `ScheduleTrack`；无 schema 依赖。
- **DEV-06D-3（日历）**：需要 `orders.source`（已有）做按来源着色；写计划日期仍走
  `update_order_details`；单日拖放语义仍待产品裁定。
- **DEV-06D-4（画廊）**：`attachments.role / gallery_visible` 与 v5 触发器已就位，
  可以直接做"标记成品 → 允许展示"；画廊 UI 未做。

---

## 14. 对 DEV-07-PRE 删除设计的影响

1. 方案 A（`attachments` 加列）已落地，删除订单时画廊标记随附件级联消失，**删除设计不需要新逻辑**。
2. 若将来改成独立 `gallery_items` 表，删除事务必须先删该表再级联。
3. **隐藏 ≠ 保留文件**：删除订单照样清文件。
4. 测试矩阵追加两条（已写入 `DEV07-PRE-DESIGN.md` §B9）：画廊标记随订单消失、隐藏不阻止清理。
5. v5 触发器不参与删除；`DELETE` 不受它影响（只拦 INSERT/UPDATE）。

---

## 15. 本地提交与剩余风险

| 提交 | 内容 |
|---|---|
| `4159edf` | v4 schema、来源、客户标签与统计、附件画廊元数据 |
| `2fee613` | 三视图、看板、表格、客户标签 UI、来源筛选 |
| 本轮修复提交 | 布局探针修正、v5 触发器、客户/看板前端测试、看板标题截断、本报告 |

**已知缺陷（必须记录）**：

1. `2fee613` 同时包含订单与客户两处改动（当时用了 `git add src`），
   单个提交无法独立回滚。与上一轮 `bfa1024` 属同类提交卫生问题。
2. 只读核查在正式代际目录留下了 `database.sqlite-shm`（内容未变）。
3. 看板列只有"当前有订单的阶段"才会出现——单张订单时无法把卡片拖到空阶段。
   这是设计取舍（与参考图一致），但对只有一两张单的用户不友好，是否要补空列待产品裁定。
4. 看板确认框是独立实现，未复用 `ConfirmDialog` 的焦点陷阱，需实机确认。

**结论：24 项布局检查全部通过；正式库安全已确认（v3 未升级）。**
按任务书标准，DEV-06D-1 可以进入 Mac 实机验收，但**尚未验收**。
