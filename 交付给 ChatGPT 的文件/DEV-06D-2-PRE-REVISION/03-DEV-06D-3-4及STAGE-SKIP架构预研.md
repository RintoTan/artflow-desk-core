# DEV-06D-3 日历 / DEV-06D-4 画廊 / STAGE-SKIP 架构预研

**性质：只读预研。本轮没有开发、没有迁移、没有新增命令。**
所有结论基于当前代码（`18c2ef7`）与 `docs/DEV06D-SCOPE.md`、`docs/REMAINING-WORK.md`、`docs/DEV07-PRE-DESIGN.md`。

---

## 1. 现有数据结构的真实形态

| 表 | 关键列 | 与后续模块的关系 |
|---|---|---|
| `orders` | `status ∈ (active, complete, cancelled)`、`stage_template_id`、`current_stage_id`、`queue_position`、`planned_start_date`、`planned_delivery_date`、`started_at/completed_at/cancelled_at`、`source`(v4) | 日历唯一允许写的是 `planned_*_date`；时间线只读 |
| `order_stages` | `(order_id, stage_id)` + `title` + `position`，`ON DELETE CASCADE` | 画廊不涉及；STAGE-SKIP 的"跳过"必须落在这里的 position 语义上 |
| `order_events` | `kind ∈ (created, work_started, work_start_undone, stage_advanced, stage_reworked, workflow_changed, completed, cancelled, reopened)`、`from/to_stage_title` 快照、`movement` | **没有 `stage_skipped`**；统计口径（完成次数）依赖 `completed` 事件 |
| `attachments` | `rel_path`（相对代际目录）、`thumb_rel_path`、`sha256`、`state ∈ (ok, missing, corrupt)`、`role ∈ (reference, final)`（v4）、`gallery_visible`（v4）、`ON DELETE CASCADE` | 画廊的唯一数据源 |
| `cleanup_tasks` | `generation`、`order_id`、`rel_path`、`state ∈ (pending, done, failed)` | 删除/恢复都必须先入队再删文件 |
| `client_tags` / `client_tag_link`（v4） | 手工标签 | 画廊分组可能用到客户维度 |

约束（已存在，且必须尊重）：

- `CHECK (planned_delivery_date >= planned_start_date)` —— 时间线的"反向区间"在正式库里**不可能出现**，原型里的异常样例只用于防御性渲染演示。
- `CHECK (status <> 'active' OR current_stage_id IS NOT NULL)`。
- v5 触发器：`gallery_visible = 1` 必须 `role = 'final'`（用触发器而不是跨列 CHECK，因为 NULL 会让 CHECK 静默通过）。

---

## 2. DEV-06D-3 日历

### 2.1 形态

- 独立导航入口（与时间线不同：时间线在工作台内，日历是独立页）。
- 月视图 + 周视图；以"日期"为主轴，每格列出当天开始/交付的订单。
- 展示 `planned_start_date` / `planned_delivery_date`；未排期订单单独一栏。
- 订单状态用既有 `status` 与 `deadlineState` 表达，不新增状态。

### 2.2 与时间线的共享边界

共享：`DayIndex`、`parseDayKey`、`localDayIndex`、「今天」、工作时区、按天定位。
不共享：时间线只读；日历**可以写**日期，但只能走 `update_order_details` 一条命令（现有能力），不允许前端直写。

### 2.3 拖放语义（必须由产品裁定，本轮不预设）

| 拖放动作 | 可能的语义 | 风险 |
|---|---|---|
| 把订单拖到某一天 | A. 改计划开始 B. 改计划交付 C. 两端一起平移（保持时长） | 选错会静默改写客户承诺；B 可能触发 `due < start` 被 CHECK 拒绝 |
| 拉伸条尾 | 改交付日 | 同上 |
| 拖到已逾期格 | 与"改期"混淆 | 需要二次确认文案说明"这是改计划，不是延期说明" |

建议的默认安全策略（供裁定）：

1. 拖放**默认只改交付日**（最常见的改期动作）。
2. 任何写入前弹单层确认："AF-2026-0101 计划交付 11-20 → 11-27"，附"保持开始日不变"的说明。
3. 写入走 `update_order_details`，带 `revision` 乐观锁；失败回滚 UI 并显示后端原文。
4. 不写事件表（`order_events` 目前只记生命周期，不记资料改动），避免制造第二套审计口径。

### 2.4 未排期订单在日历里

与时间线一致：不自动补日期，放在侧栏"未排期"列表，可拖入日历 → 触发同一条"设置交付日"确认。

---

## 3. DEV-06D-4 作品画廊

### 3.1 已有基础

- `attachments.role`：`reference`（参考图） / `final`（成品）。
- `attachments.gallery_visible`：0/1，DB 触发器保证"可展示 ⇒ 必须是成品"。
- 所以画廊 = `SELECT * FROM attachments WHERE gallery_visible = 1`（再按客户/标签分组），**不需要新表**。

### 3.2 生命周期（本轮最重要的风险区）

```
订单删除 ──CASCADE──> attachments 行消失 ──cleanup_tasks(先入队)──> 磁盘文件删除
                                │
画廊可见性 ─────────────────────┘
```

必须明确的规则：

1. **未标记的附件不得进画廊**（`gallery_visible = 0` 一律不展示，包括 `final`）。
2. 取消 `gallery_visible` 只改可见性，**不删文件**；文件的生命周期只由"删除附件/删除订单"驱动。
3. 删除订单时：先写 `cleanup_tasks`（含 `generation`），再 `DELETE FROM orders`；画廊条目随 `attachments` 级联消失，但**磁盘文件由清理任务负责**，两者不能合并成一步。
4. 备份恢复后：`cleanup_tasks` 必须按 `generation` 重新校验（R-03），否则会删掉"新代际里仍被引用"的文件。
5. 缩略图 `thumb_rel_path` 可重建（`attachments::repair`），原图缺失时画廊显示 `state = missing` 占位，不静默隐藏。

### 3.3 权限区别（产品层面）

- 画廊展示图 = 对外可见的"作品"；订单附件 = 私有资料。同一张图可以既是 `final` 又 `gallery_visible = 0`（客户未授权展示）。
- **不能**用"是否在画廊"反推"是否可删除"。

### 3.4 与备份恢复的交叉

- 备份必须含：`attachments` 行 + 原图 + 缩略图 + `gallery_visible/role`。
- 恢复后若文件缺失：`state` 置 `missing`，不自动删除行（否则用户失去"这张图曾经存在"的记录）。
- 画廊的排序/筛选偏好属于"视图状态"，**不进备份**。

---

## 4. STAGE-SKIP（受控越级）

本轮只分析"展示关系"，不实施。

现有事实：`order_events.kind` 的 CHECK 列表里没有 `stage_skipped`；`current_stage_id` 只能通过 `advance/rework` 改变。

若要实施，需要同时满足：

1. 目标阶段必须属于**该订单自己的** `order_stages`（不是模板）。
2. 被跳过的阶段不能被记成"完成"——统计口径按 `completed` 事件计数，跳级不产生 `completed`，所以历史统计不会被污染（这是好消息）。
3. 需要新事件类型 `stage_skipped`（带 `from_stage_title` / `to_stage_title` / 跳过的阶段列表），并且要改 v1 的 CHECK 约束 —— 属于**迁移级**改动，必须单独立项。
4. 前端不得直写 `current_stage_id`。

### 4.1 与时间线的关系

时间线**只画计划日期**，与阶段无关；因此"某阶段被跳过"不会影响时间线的任何像素。日历同理。
唯一要守住的是：不要因为"跳过了阶段"就在时间线上伪造一个"提前完成"的完成点 —— 完成点只来自 `completedAt`。

---

## 5. DEV-07 / DEV-07-PRE 影响面

| 新增内容 | 对永久删除的影响 | 对备份恢复的影响 |
|---|---|---|
| 画廊 `gallery_visible` | 删除订单时无需额外处理（随附件级联），但"被画廊引用"不能成为阻止删除的理由 | 必须随附件一起备份；恢复后需重算"是否有可展示作品" |
| 画廊排序/封面选择（若未来加列） | 需在删除时清理 | 需要新列 → 新迁移 |
| 日历改期 | 不改删除语义 | 计划日期已存在，无需新增备份字段 |
| STAGE-SKIP 事件 | 事件随订单级联删除 | 事件表已在备份范围 |

结论：**画廊必须先于 DEV-07-PRE 完成**（与 `REMAINING-WORK` #5 的判断一致），否则永久删除的"清理范围"会漏掉画廊引用。

---

## 6. 推荐实施顺序

1. **STABILIZATION-FINAL-FIX 收尾**（FIX-C 的 U3-B 实机）。
2. **DEV-06D-2 时间线**（本规格，等裁定后实施）。
3. **DEV-06D-3 日历**（先裁定拖放语义，再实施）。
4. **DEV-06D-4 画廊**（依赖 v4 字段，正式库仍是 v3 → 需要先做一次代际升级）。
5. **STAGE-SKIP**（独立立项 + 迁移）。
6. **DEV-07-PRE → DEV-07**（备份恢复、永久删除）。
7. **DEV-08 macOS 打包 → DEV-09 Windows**。

依赖关系：4 依赖 3 的日期规则（共用 `DayIndex`）；6 依赖 4（清理范围）；5 与 2/3/4 无硬依赖，但会改事件表，越晚做越安全。

---

## 7. 未决问题

1. 日历拖放写哪个字段（开始 / 交付 / 平移）——**必须产品裁定**。
2. 日历是否需要"拖到同一天即视为单日订单"。
3. 画廊封面规则：取第一张 `final`？还是手工指定（需新列）？
4. 画廊是否需要"客户可见/不可见"两级，而不只是 `gallery_visible` 布尔。
5. 正式库仍是 schema v3，v4/v5 未升级：切代际的时机与回滚方案需在 DEV-06D-3 之前定。
6. 跳级事件是否需要"理由"字段（与取消订单的理由类似）。
