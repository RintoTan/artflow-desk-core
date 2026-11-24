# 数据生命周期设计（v0.1.1）

- 版本：**v1.5（回填 DEV-0.1.1-03 回收站实施结果，并对齐正文中与实现不一致的表述；设计规则未变）**
- 状态：**数据层与回收站界面均已完成各自工作包验收**——DEV-0.1.1-02 完成数据层（schema v8 + 视图 + 守卫 + 查询改造 + 导出/摘要 + lint），DEV-0.1.1-03 完成回收站界面（入口、删除、恢复、永久删除、清空与附件清理重试）；跨平台双端验收仍随 DEV-0.1.1-06 进行。数据重置、存储位置迁移、单实例激活仍待实施。本文的设计规则未因实施而改变。
- 覆盖：WP-06 数据重置与存储位置、WP-07 单实例与退出、WP-08 回收站与永久删除、WP-05 红点数据来源
- 依据：`DEV-0.1.1-01` / `-01R` 架构审查 + `02A` 查询盘点 / `02B` 最终修订 + 产品负责人 Q1–Q8 与 02B 裁定（2026-11-20）
- 代码事实：§0 为 v8 之前的基线（`master` @ `d0b11d0`）；§0.2 为 02 实施后的实际状态（`master` @ `0530a77`）；回收站界面与永久删除交互已于 03 落地（`master` @ `5a958f2`）

## 0. 实施前现状（v8 之前，已核对源码）

| 项 | 现状 |
| --- | --- |
| schema | v7，迁移 `v1.rs`～`v7.rs`，只追加 |
| 软删除 | 不存在。`orders` / `clients` 无 `deleted_at` |
| 订单状态 | `status ∈ {active, complete, cancelled}`，与删除无关 |
| 附件 | `attachments.order_id → orders(id) ON DELETE CASCADE`；`rel_path UNIQUE`；有 `sha256` 但**不做内容去重** |
| 客户外键 | `orders.client_id → clients(id) ON DELETE SET NULL` ← 硬删会制造孤儿订单 |
| 历史 | `order_stages` / `order_events` 对 `orders` 均 `ON DELETE CASCADE` ← 硬删会清空历史 |
| 清理任务 | 见 §0.1（字段完整，含唯一索引） |
| 状态文件 | `state/{active.json, highwater.sqlite, backup.json}`、`.write.lock`、`recovery/state.json` |
| 单实例 | `.write.lock` 只能拒绝（`BUSY`），不能聚焦 |
| 用户设置 | 在**代际库内**的 `app_settings`（`working_timezone` / `list_density` / `startup_page` / `active_light_theme` / `defaults_seeded`） |
| 主题 | 在**代际库内**的 `themes`（`id,name,mode,tokens,builtin,created_at,updated_at`），仅内置 `Arctic Blue 浅色` 会被 seed |

### 0.1 `cleanup_tasks` 真实结构（订正）

v1 建表原文：

```sql
CREATE TABLE IF NOT EXISTS cleanup_tasks (
  id              TEXT PRIMARY KEY,
  generation      TEXT NOT NULL,
  order_id        TEXT,              -- 存在
  rel_path        TEXT NOT NULL,
  reason          TEXT NOT NULL,     -- 存在
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  state           TEXT NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending', 'done', 'failed')),
  created_at      TEXT NOT NULL,
  last_attempt_at TEXT
);
CREATE UNIQUE INDEX cleanup_tasks_pending_uniq
  ON cleanup_tasks(generation, rel_path) WHERE state = 'pending';
CREATE INDEX cleanup_tasks_state_idx ON cleanup_tasks(state);
```

现有写入点已在使用这两个字段：

```sql
INSERT OR IGNORE INTO cleanup_tasks (id, generation, order_id, rel_path, reason, created_at)
```

**结论**：`order_id` 与 `reason` 属于既有 schema，**不需要为永久删除新增 migration**。真正的约束是那条**部分唯一索引**——同一 `(generation, rel_path)` 只允许一条 `pending`，所以写入必须用 `INSERT OR IGNORE`（现有代码已如此），不能用裸 `INSERT`。

## 0.2 已实施（DEV-0.1.1-02，schema v8）

以下为实际落地的代码结构，替代此前「待实施」的描述。

| 层 | 落地物 | 说明 |
| --- | --- | --- |
| schema | `store/migrations/v8.rs` | `orders` / `clients` 各加 `deleted_at`、`deleted_batch`；两个部分索引；**不新增表**；v1–v7 零改动 |
| 视图 | `orders_visible` / `orders_trashed` / `clients_visible` | 读侧统一入口。**列在创建视图时展开**：以后给基表加列必须先 `DROP VIEW` 再重建，`migration_v8.rs` 有长期断言 |
| 守卫 | `store/visibility.rs` | `Scope { Visible, Trashed }`、`require_visible_order` / `require_trashed_order` / `require_visible_client` / `require_trashed_client`、`require_order` 分派、`order_scope` |
| 读取改造 | 30 处 V 类查询（28 订单 + 2 客户，6 个文件） | `list` / 详情 / 客户卡片子查询 / 队列 / 工作台 / 统计 / CSV |
| 写入守卫 | 22 个按 id 入口 | 事务内、版本校验之前；已删除记录一律 `CONFLICT` |
| 导出与摘要 | `export.rs` / `manifest.rs` | CSV 默认走视图，`includeTrashed` 才读基表；`DataSummary` 增加 `trashedOrders` / `trashedClients`，`orders` / `clients` 仍是含回收站的总数 |
| 防回归 | `tests/sql_visibility_lint.rs` | 业务代码出现裸 `FROM orders` / `FROM clients` 即失败；豁免精确到「行文本 + 行数」，29 条豁免覆盖 32 处命中 |

错误码约定：记录不存在用 `NOT_FOUND`，存在但在回收站用 `CONFLICT`（文案含「请先恢复」）。前端把 `NOT_FOUND` 当作「数据已不存在」并刷新列表，若回收站也用 `NOT_FOUND`，「请先恢复」的提示会被刷新抹掉。

**历史读取不受影响**：`events::list`、`orders::stages` 读基表且不加守卫，回收站订单的完整时间线仍可读出。这是刻意保留的能力——拒绝业务操作不等于拒绝查看历史。

## 1. 不变量

1. 历史不可改写：删除只改可见性，不改 `order_events` 内容。
2. 删除无半成品：客户与其订单要么全部进回收站，要么全部不动。
3. 物理文件只由 `cleanup_tasks` 删除，且在事务提交之后。
4. 失败即回滚：原数据、原代际、原指针不变。
5. 不自动清理：回收站、旧代际、备份包都不自动过期。
6. 编号永不复用：`highwater.sqlite` 永远不在可重置范围内。

## 2. 软删除模型（schema v8）

```sql
ALTER TABLE orders  ADD COLUMN deleted_at    TEXT;
ALTER TABLE orders  ADD COLUMN deleted_batch TEXT;
ALTER TABLE clients ADD COLUMN deleted_at    TEXT;
ALTER TABLE clients ADD COLUMN deleted_batch TEXT;
CREATE INDEX idx_orders_deleted  ON orders(deleted_at)  WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_clients_deleted ON clients(deleted_at) WHERE deleted_at IS NOT NULL;
```

- **不新增 status 枚举**：删除是可见性，取消是业务终态。避免重演 v6/v7 那种因改 CHECK 而整表重建的迁移。
- **只加列、不加表**：SQLite 加列是元数据操作；不加表就不必搬行、不必处理触发器。
- **部分索引**：回收站是少数行，比全列索引小得多。

状态机：

```
        删除                 恢复
active ────────→ trashed ────────→ active
                   │
                   │ 永久删除（仅回收站内手动）
                   ↓
                purged（行删除；附件入 cleanup_tasks）
```

## 3. 查询面与口径（Q7 已裁定）

`FROM orders` 43 处、`FROM clients` 9 处；`cleanup_tasks` 之外全部要按下列口径处理。

**实施结果**：表中业务可见性口径全部保留。常规列表与聚合查询采用 v8 可见性视图（`orders_visible` / `clients_visible`）；按 ID 的写入入口通过 `store::visibility` 守卫控制；备份、诊断、幂等及模板使用数等全量查询仍按 §3.1 例外读取基表。下表「落地要求」列保留为实施前方案，供追溯使用。

| 场景 | 是否含回收站 | 落地要求 |
| --- | --- | --- |
| 工作台统计 | 否 | 计数 SQL 加 `deleted_at IS NULL` |
| 正常订单列表 / 看板 / 表格 | 否 | 同上 |
| 客户关联订单 | 否 | 同上 |
| 历史收入统计 | 否 | `stats.rs` 月度查询加过滤 |
| CSV 默认导出 | 否 | `export.rs` 默认过滤 |
| CSV 可选导出 | 允许勾选 | 增加 `includeTrashed` 参数，界面默认关闭；已删除行的状态显示为「已删除 · 原状态」，不改 `status` 列 |
| 完整数据备份 | **必须包含** | 备份是快照，不按可见性裁剪 |
| 备份摘要 | 分类统计 | `DataSummary` 增加 `trashedOrders` / `trashedClients` |

改造清单是**实施前的估算**（按 `FROM orders` 出现次数），实际改动以 §0.2 的 30 处为准；下表保留用于追溯当初为什么认定「43+9 处都需要逐处判断」：

| 文件 | 次数 | 备注 |
| --- | ---: | --- |
| `domain/orders.rs` | 6 | 列表、详情、搜索 |
| `domain/clients.rs` | 7（另 4 处 `FROM clients`） | 客户列表、关联订单、下钻 |
| `domain/queue.rs` | 5 | 队列顺序 |
| `domain/dashboard.rs` | 4 | 工作台计数与提醒 |
| `domain/stats.rs` | 2 | 月度完成与收入 |
| `domain/export.rs` | 2 | CSV |
| `domain/templates.rs` | 1 | 模板使用数 |
| `domain/workflow.rs` / `lifecycle.rs` / `attachments.rs` | 各 1 | 阶段、生命周期、附件归属 |
| `backup/manifest.rs` / `commands/backup.rs` | 3 | 摘要计数（此处**不过滤**） |

编号唯一性不受影响：`orders.code` 仍 `UNIQUE` 且包含已删除行，删除不回收编号。

### 3.1 保留读基表的例外（有意为之）

`tests/sql_visibility_lint.rs` 的豁免清单就是这份例外的权威列表。按用途归为十类：

| 类别 | 为什么必须读全量 |
| --- | --- |
| `MIGRATION_SCHEMA` | 视图自身的定义 |
| `GUARD_SELF` | 守卫判断「是否已删除」只能读 `deleted_at` |
| `BACKUP_SNAPSHOT` | 备份是快照，裁剪即丢数据 |
| `DIAGNOSTICS` | 诊断要报真实行数 |
| `IDEMPOTENCY` | `request_id` 重放必须能找到已删除订单，否则重复建单 |
| `TEMPLATE_GUARD` | 模板使用数统计（界面提示用）。回收站订单也持有模板引用、列无外键，所以按全量计数；它不阻止删除模板 |
| `GUARDED_READ` | 入口已有守卫，内部读基表是为了取守卫不返回的字段 |
| `EXPORT_DYNAMIC` | 按 `includeTrashed` 动态选表 |
| `DISPLAY_JOIN` | 见下 |
| `QA_FIXTURE` | 夹具要核对「库里确实有 N 条」 |

**`DISPLAY_JOIN` 是唯一一类「可以不读全量但选择读全量」的例外**（产品负责人 2026-11-20 裁定保留）：
`orders::load`、`queue::list`、`export::collect_orders` 三处用 `LEFT JOIN clients` 取客户显示名。

理由与代价：

- 正常路径下客户与订单同批进出回收站，可见订单的客户必然可见，与 `clients_visible` 等价；
- 如果因异常数据出现「客户已删、订单未删」，读基表能继续显示客户名，读视图会变成空白；
- 代价是这类异常下会展示一个已删除客户的名字。判定为可接受：名字本身不是敏感业务操作入口，且空白反而更像数据损坏。

不为统一而改动这三处；若 WP-03 回收站界面出现显示冲突，再重新讨论。

## 4. 客户删除与恢复

### 4.1 删除（单事务）

```sql
BEGIN IMMEDIATE;
  -- 客户名下全部订单并入本批：batch 无条件覆盖，deleted_at 用 COALESCE 保留先前单独删除的时间
  UPDATE orders  SET deleted_batch = ?, deleted_at = COALESCE(deleted_at, ?) WHERE client_id = ?;
  UPDATE clients SET deleted_at = ?, deleted_batch = ? WHERE id = ? AND deleted_at IS NULL;
  -- 断言客户受影响行数 = 1；否则 ROLLBACK
COMMIT;
```

**实施时修正（03B）**：早期草案只更新 `deleted_at IS NULL` 的订单，会让先前单独删除的订单留在旧批次；随后永久删除客户时，`orders.client_id ON DELETE SET NULL` 会把它变成无主孤儿。因此改为「batch 无条件覆盖、时间用 COALESCE 保留」——订单全部归入客户批次，但各自保留原删除时间。

不动附件、不动事件、不动 `client_tag_link`（Q8：标签关联随客户保留）。

### 4.2 恢复（Q3：只允许完整批次）

| 场景 | 行为 |
| --- | --- |
| 恢复客户 | 以 `client_id` 确认关联、以 `deleted_batch` 限定范围，恢复该批全部订单；若发现该客户名下还有订单不在本批次内，**中止**并报 `INTEGRITY` |
| 恢复订单，其客户仍在回收站 | **拒绝**，提示「请先恢复所属客户」 |
| 恢复批次中的部分订单 | **不允许**。界面不提供单选恢复，只提供「整批恢复」 |
| 重复恢复 | 幂等 |

理由（产品已定）：删除与恢复对称，用户不需要理解批次概念。

### 4.3 标签（Q8）

- 客户在回收站期间：`client_tag_link` 原样保留；客户列表与标签统计因 `clients.deleted_at IS NOT NULL` 自动排除。
- 恢复客户：标签关联天然复原，无需重打。
- 永久删除客户：显式 `DELETE FROM client_tag_link WHERE client_id=?`；**不删** `client_tags` 本身；**不自动清理**已无客户使用的标签。

## 5. 永久删除（Q1：不保留审计快照）

### 5.1 执行顺序

```sql
BEGIN IMMEDIATE;
  -- 1. CASCADE 之前先取文件路径
  SELECT rel_path, thumb_rel_path FROM attachments WHERE order_id = ?;
  -- 2. 显式删除子表，不依赖 CASCADE（便于计数与留痕）
  DELETE FROM order_events WHERE order_id = ?;
  DELETE FROM order_stages WHERE order_id = ?;
  DELETE FROM attachments  WHERE order_id = ?;
  DELETE FROM orders       WHERE id = ?;
  -- 3. 清理任务与删除同事务
  INSERT OR IGNORE INTO cleanup_tasks (id, generation, order_id, rel_path, reason, created_at)
    VALUES (?, ?, ?, ?, 'purge', ?);   -- 每个 rel_path / thumb_rel_path 一行
COMMIT;
-- 事务外
  run_cleanup(active_generation)
```

三条硬约束：

1. `INSERT OR IGNORE` 而非 `INSERT`：`cleanup_tasks_pending_uniq` 会对重复 `(generation, rel_path)` 报错。
2. 清理任务写入**必须与订单删除同一事务**：否则「行已删、任务没写」会让文件永久残留且无记录。
3. 物理删除必须在事务提交后：文件删了不可回滚，行删了可以重来。

### 5.2 不保留任何业务副本

按 Q1：不建归档表、不存客户联系方式/金额/历史，事件与阶段随订单删除。界面必须写明「永久删除后无法恢复」。

### 5.3 附件安全

- `rel_path` 全表唯一且无内容去重 → 不存在多行共享同一文件；
- 执行器现有两道闸：`generation != active_generation` 直接跳过；`is_managed_path()` 拒绝绝对路径与 `..`；
- 仍建议删除前做一次「是否仍被其他行引用」的防御查询，为未来可能的去重留边界。

### 5.4 清空回收站

**按批次逐批提交**，不做一个大事务：已完成批次不回滚，失败批次停止并报告原因。避免「清 1000 单时因第 999 单 IO 错误全部作废」。

### 5.5 回收站界面与操作粒度

| 规则 | 说明 |
| --- | --- |
| **不暴露批次 ID** | `deleted_batch` 只是内部原子性依据，界面不出现 UUID；命令只收 `id`，整批由服务端按 batch 展开 |
| 客户组整体呈现 | 一个客户条目折叠其关联订单：`删除于 2026-11-20 · 同批 3 个订单` |
| 客户组整批操作 | 只提供「整批恢复」「整批永久删除」，**不提供单条** |
| 独立订单 | 自成一条，可单独恢复 / 永久删除 |
| 状态展示 | 独立订单显示 `原客户：客户 B · 制作中 · 删除于 2026-11-19`；组内订单显示制作进度，与组头同日时省略日期 |

上述粒度已按此实施（DEV-0.1.1-03，`5a958f2`）：组内订单的每一行不渲染任何操作按钮，恢复与永久删除只在组头。

这条与 Q3 一致：删除与恢复对称，用户不需要理解批次概念。

### 5.6 模板使用数统计（全量口径）

模板卡片与详情页的「N 单使用」来自**全部订单，含回收站**：

```sql
SELECT COUNT(*) FROM orders WHERE stage_template_id = ?   -- 不过滤 deleted_at
```

原因：回收站订单仍持有模板引用；只数有效订单会让这个数字在删除/恢复之间跳动。`orders.stage_template_id` **没有外键**，数据库不提供引用完整性保证，统计只能靠这条全量查询。

**实现事实（03D 核对）**：当前模板卡片及详情页显示的使用数包含回收站订单，但不区分有效订单与回收站订单；该数字**仅为使用情况提示，不构成模板删除限制**——`templates.rs::remove` 会校验模板存在性、版本冲突、至少保留一个模板，以及默认模板替换条件；但**不会检查模板使用数，也不会因订单仍持有该模板 ID 而阻止删除**，界面也没有按使用数禁用删除按钮。删除模板不会改变已有订单独立保存的制作阶段副本。

把使用数进一步拆分为「有效订单 / 回收站订单」，属于尚未实施的可选体验优化；若将来真要按引用阻止删除，那需要单独的产品决策，而不是沿用当前这行统计。

### 5.7 备份摘要与 manifest 口径

`DataSummary` **不在 manifest 里**：导出时临时计算、恢复预览时解出快照库再算一遍，只用于界面展示【源码 `create.rs:199`、`restore.rs:85-95`】。

因此 `trashedOrders` / `trashedClients` 加到 `DataSummary` 即可，**manifest.json 内容不变、备份格式仍为 v1、SHA-256 规则不变**。

对旧包（schema v7）预览时，`deleted_at` 列不存在，现有 `count()` 用 `unwrap_or(0)` 兜底 → 计数显示 0，语义正确。若将来确实要把摘要写进 manifest，必须给新字段加 `#[serde(default)]`（现有字段没有 default，缺字段会解析失败），并保留「旧读端忽略未知字段」的既有行为（已核实无 `deny_unknown_fields`）。**实施时两个新字段已加上 `#[serde(default)]`**：若读到缺少这两个字段的旧形状 `DataSummary` JSON，会补 0 而不是解析失败。注意 manifest 本身并不保存摘要，这条兼容性只对摘要结构成立。

## 6. 数据重置（Q2 已裁定）

### 6.1 两种机制

| 机制 | 适用 | 为什么 |
| --- | --- | --- |
| **新代际 + 选择性回填** | 业务数据包 | 业务表互相依赖，逐表 DELETE 会留悬挂引用；新代际失败时旧库完好 |
| **就地事务** | 用户设置、主题、提醒状态 | 这些是「偏好」，重置它们不应动业务数据，也不值得换代际 |

### 6.2 分项（按产品裁定整理）

| 项 | 范围 | 机制 | 默认 |
| --- | --- | --- | --- |
| **业务数据包** | 客户、订单、制作历史、改期历史、附件、流程模板、队列、客户标签 | 新代际 + 回填偏好 | 不勾选 |
| **用户设置与偏好** | `app_settings`（时区、列表密度、启动页、当前主题）、`themes` 中的自定义主题 | 就地事务 | 不勾选 |
| **本地备份** | `{root}/backups/` 下的文件 | 就地删除（仅本应用管理的目录） | 不勾选 |
| **备份提醒状态** | `state/backup.json` | 就地重置为默认（`reminder_days = 0`，保留 `last_success_at` 以免误报「从未备份」） | 不勾选 |
| **日志** | `logs/` 轮转文件 | 就地删除 | 不勾选 |
| **附件隔离区** | 活动代际 `attachments/quarantine/` | 就地删除，**必须提示「清理后将失去崩溃恢复的比对线索」** | 不勾选 |

**业务数据包内部不可拆分**，理由：`orders.client_id` 依赖客户、`attachments` 依赖订单、`order_events` 依赖订单、`stage_template_steps` 依赖模板、`client_tag_link` 依赖客户与标签。允许用户勾掉其中一项，等于允许制造悬挂引用。

### 6.3 多项同时重置：优先级与最终结果

六个勾选项各自独立成立，**任何一项都不得被其他项的副作用覆盖**。业务数据包重置后要新建库并回填偏好，因此「是否回填」由**设置项是否被勾选**决定，而不是固定回填。

| 组合 | 业务数据 | 用户设置 / 自定义主题 | 其他项 |
| --- | --- | --- | --- |
| 只勾业务数据 | 清空（新代际） | **原样保留**（回填原 5 项 + 自定义主题） | 不变 |
| 只勾设置 | 不变 | **恢复默认**（5 项回默认、自定义主题删除、内置主题保留） | 不变 |
| 两项都勾 | 清空（新代际） | **恢复默认**（不回填，seed 默认即结果） | 各自执行 |
| 两项都不勾 | 不变 | 不变 | 各自执行 |

实现要点：

1. 业务数据包重置时，**先读出** 5 项设置与自定义主题，再按上表决定是否 `INSERT OR REPLACE` 回填；
2. 「两项都勾」时**不执行**第二次就地重置——不回填即已达成默认，避免同一项被写两次、也避免两套逻辑产生顺序歧义；
3. 「只勾设置」走就地事务，不触碰业务表与附件；
4. 其余四类（备份、提醒、日志、隔离区）与上表无耦合，永远各自独立执行。

### 6.4 业务数据包重置流程

```
1. 快照（pre_restore_snapshot，产物写旧根 backups/）
2. 读取 5 项设置 + themes 自定义行（是否需要回填见 §6.3）
3. 建新代际（复用 initialize：建库 → 迁移到最新 → 校验）
4. 按需回填偏好（INSERT OR REPLACE）
5. 校验新库：schema 版本、foreign_key_check、偏好条数
6. 原子切 active.json
7. 旧代际保留（Q2），界面告知其路径与占用
```

### 6.5 不可重置（硬白名单）

`environment.json`、`.write.lock`、`active.json`、`highwater.sqlite`、`recovery/` —— 界面不出现这些选项，代码层直接拒绝。

`highwater.sqlite` 尤其重要：编号「创建后永不改变、永不复用」是 v1 起写进 schema 的约束，清掉会让新订单从 `AF-2026-0001` 重发，与已发出的合同号冲突。

### 6.6 执行顺序与部分失败语义

六个选项的原子性天生不同：数据库能回滚，指针能原子切换，文件删除不可逆。**不追求全局原子性**，改为「逐项结果 + 准确报告」。

**固定执行顺序**（先数据库、后文件，先不可逆性低的）：

```
1. 业务数据包（若勾选）
2. 用户设置与偏好（仅在「只勾设置」时执行；两项都勾时由 §6.3 的回填策略直接达成）
3. 备份提醒状态
4. 本地备份
5. 日志
6. 附件隔离区
```

**逐项返回结构**（每一项都要有独立结果，不允许合并成一个布尔）：

```
{ option, status: ok | failed | skipped, reason?, detail? }
```

| 情形 | 行为 |
| --- | --- |
| 数据库事务失败 | 该项回滚；后续项继续（互不依赖） |
| 新代际创建 / 校验 / 切指针失败 | 指针不动、旧库继续服务；**中止后续所有文件类操作**并标记 `skipped`，避免「业务数据还在，却把备份和日志删了」这种丢掉证据的组合 |
| 文件删除部分失败 | 已删的不恢复，剩余保留并逐条报原因（失败项可重试，幂等） |
| 用户取消 | 已完成的项保留（不逆向回滚已提交的事务），界面明确列出哪些已完成 |

**展示规则**：

- 整体结论只有三种：全部成功、部分成功（列出失败项与原因）、全部失败；
- **禁止**把部分成功显示为成功；禁止用一句「重置完成」掩盖 `failed` 项；
- 失败项提供「重试」入口，重试只处理 `failed` 项。

## 7. 自定义存储位置

### 7.1 与既有决策的冲突

`qa.rs` 明确写了「不使用环境变量覆盖数据目录……正式版接受任意路径等于给『把用户数据指到别处』开后门」。v0.1.1 要的能力与这条冲突，因此实现必须遵守：

- 只能由用户在应用内**显式选择**（系统目录选择器）；
- 不接受任何命令行参数、环境变量、配置文件外部注入；
- 选择结果写入不可移动的根指针，且必须通过标记文件与可写性校验。

### 7.2 结构

```
<平台默认目录>/dev.artflow.minidesk/
  root.json            {"dataRoot": "...", "updatedAt": "..."}   ← 引导点，不可移动
<用户根>/
  environment.json  .write.lock
  state/{active.json, highwater.sqlite, backup.json}
  generations/  backups/  recovery/  logs/
```

读取顺序：默认目录 `root.json` → 缺失则用默认根 → 存在则校验目标可写、含 `environment.json` → 打开。

### 7.3 不可用时的行为（Q5）

| 情形 | 行为 |
| --- | --- |
| 目标盘离线 | **硬失败**：明确报错 + 「重新连接后重试」+ 「切回默认位置」两个动作 |
| 切回默认位置 | 必须提示「默认位置的数据可能不是最新版本，不会自动与外接盘数据合并」 |
| 静默回落 | **禁止**。绝不因为目标不可用就新建空库 |

### 7.4 迁移九步

| 步 | 动作 | 失败处理 |
| --- | --- | --- |
| 1 | 目标校验（可写、空间 ≥ 源×1.2、非祖先/子目录、无既有 `environment.json`） | 拒绝，无副本 |
| 2 | 持锁停写 | 拿不到锁 → 提示有实例运行 |
| 3 | 快照写旧根 | 中止 |
| 4 | 流式复制 `state/` + 当前代际 + 附件 | 中止并清目标侧半成品 |
| 5 | 校验：文件数、字节、逐文件 SHA-256、`integrity_check`、`foreign_key_check` | 中止，**源不动** |
| 6 | 原子写 `root.json` | 源仍为活动根 |
| 7 | 新根 `Environment::open` + 读一张附件 | 回滚 `root.json` |
| 8 | 告知旧目录位置与占用，**不删除** | — |
| 9 | 结束 | — |

第 7 步的「读一张附件」是必需的：asset 协议 scope 是**运行时按当前代际授权**（`lib.rs:290`，刻意不使用 `generations/*` 通配），换根后不重新授权，界面所有图片会变裂图。

### 7.5 实施记录（DEV-0.1.1-05）

迁移范围的最终口径，比 §7.4 第 4 步写得更完整：

| 复制 | 不复制 |
| --- | --- |
| `environment.json`（原样，内容不含路径） | `logs/`（本来就不在数据根内） |
| `state/`（`active.json`、`highwater.sqlite`、`backup.json`） | `.write.lock`（到目标根重新创建并取锁） |
| `generations/` **全部代际**，保留原 UUID | `root.json`（引导指针，不属于载荷） |
| `backups/` 全部文件，含 `.tmp` 与迁移前快照 | `recovery/state.json`（存在即拒绝迁移） |
| `recovery/failed-restore-*`（诊断证据） | |
| `.qa-root`（仅 QA 环境，内容与场景一致） | |

只复制活动代际会让用户重置前的历史数据留在旧盘上——那看起来就是"数据丢了"，
所以这里明确要求全代际复制，`tests/storage_migrate.rs` 用"删掉非活动代际的库必须
导致迁移失败"这条区分度测试守住它。

根指针位置（稳定引导目录，不随数据根移动）：

- 正式：`app_data_dir/root.json`
- QA：`app_data_dir/.root-pointers/{scenario}/root.json`

指针内容是 `{ dataRoot, updatedAt }`，写入走临时文件 + fsync + rename。指针损坏、
目标盘离线一律硬失败，**不回落默认根**；切回默认位置只删指针，不合并两份数据。

目标根在迁移开始时必须为空（非空直接拒绝），这样失败后的清理不会误删用户自己的文件。


## 8. 单实例与退出（Q4 已裁定）

| 平台 | 关窗 | 最小化 | 二次启动 |
| --- | --- | --- | --- |
| macOS | **退出**（经退出保护） | 保持运行 | 激活已有窗口 |
| Windows | 退出 | 保持运行 | 聚焦已有窗口 |

不增加 Dock 常驻、不增加托盘。

实现要点：

1. 关窗 → 前端守卫（未保存修改）→ `confirm_close` → `gate.allow()` → 退出；现有 `should_block_exit` 已符合该语义，不需要改判据。
2. 二次启动激活：macOS Unix socket / Windows 命名管道发 `activate`，主进程 `show + set_focus`。
3. **补 Windows 锁身份校验**：`infra/lock.rs` 的 `file_identity()` 在非 unix 返回 `None`，`verify()` 恒通过，双写防护在 Windows 失效。改用 `GetFileInformationByHandle` 的卷序号 + 文件索引。

### 8.1 实施记录（DEV-0.1.1-05）

- 通道位置固定在应用数据目录（`app_data_dir/.instance`），不随数据根迁移；
  Windows 用由该路径哈希出的管道名，正式与 QA 天然隔离。
- 第二实例：拿锁失败且能联系上已有实例 → 发 `activate` → 进程以 0 退出，不建第二个窗口；
  联系不上（例如锁文件被替换）才按错误处理并弹出启动失败说明。
- 锁身份：Unix `dev + ino`，Windows `GetFileInformationByHandle` 的卷序号 + 文件索引。
  取锁时拿不到身份也视为不可信，`verify()` 不再有"恒通过"的分支。

## 9. 存储用量统计（Q6）

### 9.1 两条源码事实（决定口径）

1. **`attachments.byte_size` 只记录原图大小**。导入时写入的是 `image.bytes` 的字节数，缩略图另行 `render_webp` 后单独落盘，不进入该字段【源码 `attachments.rs:405-436`】。因此 `SUM(byte_size)` **不能**代表附件实际磁盘占用。
2. **日志不在数据根内**。`diag::init(app_data_dir/logs)` 绑定的是应用数据目录【源码 `lib.rs:180`】。正式版下它等于数据根；但启用自定义存储位置后，日志仍留在平台默认目录，**不随数据根迁移**。

结论：统计一律以**目录遍历 + 文件 stat** 为准，不用数据库字段求和。

### 9.2 分类与覆盖范围（每个文件只归一类）

| 分类 | 覆盖路径 | 说明 |
| --- | --- | --- |
| 正常业务附件 | `generations/<active>/attachments/{originals,thumbs}/**`，且 `rel_path` 对应到未删除订单 | **含缩略图** |
| 回收站附件 | 同一目录，`rel_path` 对应到已删除订单 | 含缩略图；单列（Q6） |
| 未登记附件 | 同一目录，`rel_path` 在 `attachments` 表中无对应行 | 异常项，单列，不并入其他类 |
| 隔离区 | `generations/<active>/attachments/quarantine/**` | 崩溃恢复比对用 |
| 数据库与状态 | `database.sqlite` + `state/**` + `environment.json` + `.write.lock` + `recovery/**` | 锁文件通常 0 字节，仍计入 |
| 本地备份 | `backups/**` | **含 `.tmp` 临时文件**；备份中途中断留下的半成品必须计入 |
| 旧代际 | `generations/<其他>/` 全部 | 不计入六类，只读展示（Q2 保留） |
| 日志 | `app_data_dir/logs/**` | **不属于数据根**，单列显示，不参与对账 |

遍历实现（Rust）：

```rust
let meta = std::fs::symlink_metadata(&path)?;   // 不跟随符号链接
if meta.file_type().is_file() {
    total += meta.len();                         // 逻辑大小
}
```

- **不得**用 `Path::is_file()` 判断：它会跟随符号链接，把链接目标算进本目录，可能跨卷、成环；
- 只累加 `meta.len()`，不读块数、不查分配大小；
- `.DS_Store`、`.tmp` 等一并计入其所在目录所属分类（不丢弃，否则对账不平）；
- 同一路径只进入一个分类，判定优先级：先按目录归属，再按 `rel_path` 反查订单状态；
- 目录本身不计数。

### 9.3 对账（统一采用「逻辑文件大小」口径）

首版把「占用」定义为**逻辑文件大小**：所有被统计文件的 `metadata.len()` 之和。

不采用「物理磁盘分配」口径——稀疏文件、APFS 克隆、NTFS 压缩都会让块数明显偏离文件长度，且两端难以用同一套 API 取得一致结果。逻辑大小在 macOS 与 Windows 上语义一致、可复现、可测试。

```
数据根逻辑大小 = 正常附件 + 回收站附件 + 未登记附件 + 隔离区 + 数据库与状态 + 本地备份 + 旧代际
```

- 对账基准必须是**同一口径**的递归文件统计（用同样的 `symlink_metadata` 规则遍历数据根），**不得**用 `du` 的块占用做基准；
- 界面文案写「占用」或「逻辑大小」，**不得**写成「物理磁盘占用」「实际占用空间」；
- 各分类互斥，每个文件只计一次；
- 差额 > 1% 时，在设置页显示「未归类」一行并给出目录，避免用一个漂亮的总额掩盖漏算；
- 日志单独显示在「应用日志」一行，明确标注「位于默认目录，不随数据根迁移」。

### 9.4 展示

回收站附件与旧代际都计入用户可见的「逻辑大小」，但各占一行，让用户看清「删掉的、退役的分别占多少」。备份中途中断留下的 `.tmp` 也要出现在「本地备份」里，而不是悄悄不计。

## 10. Migration 影响

只需 `v8.rs`（§2 的加列 + 部分索引），**不新增表**（Q1 已排除归档表），**不修改 v1–v7**。

| 场景 | 行为 |
| --- | --- |
| 旧程序打开 v8 库 | 拒绝写入并提示升级（`current > target` 已实现） |
| 新程序打开 v7 库 | 新建代际 → `VACUUM INTO` → 迁移 → 校验 → 切指针 |
| 恢复 v1 备份（schema 7） | 解包 → 迁移到 8 → 高水位合并 → 切指针 |
| 迁移失败 | 事务回滚；代际级失败删新代际、指针不动 |

## 11. 风险

| # | 风险 | 缓解 |
| --- | --- | --- |
| R1 | 43+9 处查询漏过滤 | 逐处清单勾选 + 分模块集成断言 |
| R2 | 误用硬删客户 | 代码层禁止；删除只走软删除 |
| R3 | 硬删订单清空历史 | 永久删除前明确告知；日常删除绝不硬删 |
| R4 | 迁移后 asset scope 未重授权 | 第 7 步自检必须读一张附件 |
| R5 | `root.json` 指向离线盘 | 硬失败，不回落（Q5） |
| R6 | 重置清掉 `highwater` | 硬白名单 |
| R7 | `cleanup_tasks` 重复写入 | `INSERT OR IGNORE`（唯一索引） |
| R8 | Windows 锁身份校验缺失 | 补 `GetFileInformationByHandle` |
| R9 | 清空回收站大事务 | 按批次提交 |
| R10 | 隔离区被当垃圾箱 | 界面写明用途 + 二次确认 |

## 12. 实施顺序

按产品裁定调整为：

```
DEV-0.1.1-01R  方案修订（本文件）           DONE  v1.3 冻结
WP-01          五项 P3（与数据层无关）      DONE  d0b11d0
DEV-0.1.1-02   v8 迁移 + 数据可见性层       DONE  93646ee / ccf90c9 / abf1417 /
                                                  f272393 / 2e643ec / 0530a77
DEV-0.1.1-03   回收站完整功能（删除/恢复/永久删除/附件清理/界面）   DONE  af0e2a5 / d62259f /
                                                   f96888c / cb8191b / 5a958f2
DEV-0.1.1-04   数据重置（新代际 + 选择性回填 + 就地重置）          待实施
DEV-0.1.1-05   单实例与存储位置迁移（先锁与退出，再开放自定义路径） 待实施
DEV-0.1.1-06   双平台验收（数据安全、迁移失败回滚、UI）            待实施
```

02 完成时只意味着**数据层可支撑回收站功能**；03 完成后用户才能在「设置 → 数据维护 → 回收站」里删除、恢复、永久删除与清空。本节记录的设计规则始终有效，未因界面落地而调整。

## 13. 需同步的文档（实施时）

- `PRODUCT-DECISIONS.md`：Q1–Q8 已转为正式决策（2026-11-20，见该文件 §15–§18）；
- `ROADMAP.md`：v0.1.1 工作包已登记，DEV-0.1.1-02 标为 DONE；
- `PROJECT-STATUS.md`：§2.1 的 PASS 基线记为「产品负责人裁定，非复测」，数据生命周期数据层已登记；
- `ARCHITECTURE.md`：已补 v8 列说明与三个视图（DOC-SYNC-01，`23edc8b`），数据模型两处已一致。
