# 备份兼容边界

状态：**生效中**（`d6f410b` 起）
适用：ArtFlow Desk Core 桌面端
上位文档：[DATA-LIFECYCLE](DATA-LIFECYCLE.md)、[ARCHITECTURE](ARCHITECTURE.md)

---

## 1. 兼容承诺

> **ArtFlow Desk Core 正式 Schema 血统内的历史备份，必须能通过迁移链恢复到当前版本。**

正式血统的判定标准（四项同时满足）：

1. 备份 manifest 的 `format` 为 `artflow-minidesk-backup`；
2. 包内 `database.sqlite` 含 `orders`、`clients`、`order_events`、`app_settings` 四张基础表；
3. manifest 的 `schema_version` 与库内 `user_version` 一致；
4. manifest 的 `schema_version` 与四张基础表、四张财务表的存在性自洽（见 §3.2）。

旧备份允许缺少 `working_timezone`、`number_high_water`、`total_files`、`total_bytes`，也允许用 snake_case 写键名——这些都按 §3 的规则补。

## 2. 明确不支持的：技术验证原型

| 项 | 事实 |
| --- | --- |
| 来源 | `dev.artflow.minidesk.tv01/tv03-sandbox`（产品成型前的技术验证沙箱） |
| manifest | `schema_version: 2`，snake_case，无时区/高水位字段 |
| 库内表 | `orders`、`order_progress`、`stage_templates`、`attachments` |
| 缺什么 | 缺 `clients`、`order_events`、`app_settings`——这三张表在正式 v1 才引入 |
| 结论 | **不支持直接恢复**，也不开发一次性导入器 |

理由：它的 `v2` 与正式血统的 `v2` 只是数字重合，结构不同。强行导入要重新解释原型里的订单、阶段、附件与历史，语义失真风险高于收益；为一个开发期产物维护永久映射逻辑不合理。

**行为**：恢复流程在迁移**之前**核对表结构，缺表直接报错——

```
SCHEMA：备份自称 schema v2，但缺少 3 张基础表（clients、order_events、app_settings）。
这个文件来自与本程序不兼容的旧结构，无法通过自动迁移恢复；请保留原文件，待人工导入。
```

不会部分导入，不会改动现有数据库（恢复前仍会先做回退备份）。

**原始文件要求**：保留原 ZIP，不删除、不覆盖、不重打包。

## 3. 旧字段的兼容规则

| 字段 | 旧备份情况 | 当前处理 |
| --- | --- | --- |
| 键名 | `format_version` 等 snake_case | `serde(alias)` 兼容；`FORMAT_VERSION` **保持 v1 不升** |
| `working_timezone` | 缺失 | 用恢复设备当前系统时区；预览与恢复结果都提示「历史日期归属可能与原设备存在差异」；**不改任何历史日期与时间戳** |
| `number_high_water` | 缺失 | 按库内编号（含回收站订单）重建后与本地取大，避免新建订单撞号；历史上已永久删除的编号无法还原，明确记入 warnings |
| `total_files` / `total_bytes` | 缺失 | 按实际文件清单重算 |
| `format` | 缺失 | **仍然拒绝**（不是本程序的包） |
| `files` | 缺失 | 仍然拒绝（清单是校验与落盘的依据） |

## 3.2 财务表与版本的自洽（FIN-07）

财务表从 v10 才有，退款表从 v12 才有。版本号与真实表结构对不上时**拒绝恢复**，
不自动猜测用户的库属于哪个版本。

| 备份声明的 schema | 应有的财务结构 | 不符时 |
| --- | --- | --- |
| v9 及以前 | 四张财务表都不存在 | 带任一财务表 → 拒绝（版本号是假的） |
| v10 / v11 | `payment_platforms` / `payment_schedules` / `payment_records` 必须在；`refund_records` 不该存在 | 缺表或已带退款表 → 拒绝 |
| v12 | 四张表齐全，且 v11+v12 的 12 条触发器在位 | 缺表或缺触发器 → 拒绝 |

存在性在**迁移之前**判定。迁移会把缺的表建出来，事后再问「这份备份有没有平台表」，
答案永远是「有」。

**平台配置是唯一允许跨版本回填的财务数据（规则 B）：**

| 备份情况 | 恢复后 |
| --- | --- |
| 包内没有 `payment_platforms` 表（v9 及以前） | 回填**恢复前本机**的平台配置：`id` / `name` / `fee_rate_bp` / `archived` / `sort_position` / `created_at` 原样，`updated_at` 记为恢复时刻 |
| 包内有 `payment_platforms` 表 | 严格按备份恢复；**即使表是空的也保持空**，不与本机合并 |

`payment_schedules` / `payment_records` / `refund_records` 任何情况下都不回填：
它们是业务历史，不是工具配置。恢复 v9 备份后这三张表为 0 行，旧订单显示「未记录收款信息」。
迁移前后会比对这三张表的行数，变化即拒绝切换。

## 3.3 已知限制：v10 带财务数据的包

v11 迁移要求三张财务表为空，所以「v10 库 + 已录入的财务数据」无法沿迁移链升级。
该状态在应用内不可达（v10 期间没有任何写入入口，仅有建表与永久删除时的清理），
机内也不存在这样的库或包；详见 [FIN-07-BACKUP-CONTRACT](FIN-07-BACKUP-CONTRACT.md) §3.1。

遇到时恢复会在迁移阶段失败且不动现有数据，但**预览阶段还不会提前说明**——已知缺口。

## 4. 验收状态

| 项 | 状态 |
| --- | --- |
| snake_case manifest 可解析 | 已测（`zip_safety`） |
| 缺时区 → 接受并告警 | 已测（`zip_safety`） |
| 缺高水位 → 重建 | 已实现，单测覆盖重建逻辑；真实旧包未跑 |
| 缺总计数 → 重算 | 已测（`zip_safety`） |
| 缺 `format` → 拒绝 | 已测（`zip_safety`） |
| 原型 v2 ZIP → 明确拒绝、不破坏现场 | 已测（`legacy_restore_manual`，真实文件） |
| 构造 v8 库 → 打包 → 改历史 manifest → 恢复 v9 | **已测**（`backup_v8_lineage`）：迁移、数量、关联、历史事件、附件 SHA-256、高水位重建、完整性、时区降级、失败安全 |
| 财务四表 v12 往返逐字段一致 | **已测**（`finance_backup`）：归档平台、作废流水、作废退款、未关联退款、费率快照、`request_id`、12 条触发器 |
| 摘要财务四项口径（含归档/作废/回收站） | **已测**（`finance_backup`、`trash_export_backup`） |
| v9 → v12 回填平台、不回填流水 | **已测**（`finance_backup`） |
| v10 空平台表 → 保持空、不合并 | **已测**（`finance_backup`） |
| v11 → v12 保留平台与流水 | **已测**（`finance_backup`） |
| 版本号与结构不一致 → 拒绝 | **已测**（`finance_backup`：缺表、缺触发器、manifest 与库不一致、低版本带高版本表） |
| 平台回填中途失败 → 不切代际 | **已测**（`finance_backup`，debug-only 故障注入） |
| 切换前 `state/` 落盘失败 → 不切代际 | **已测**（`finance_backup`：高水位合并阶段失败，现有数据不动） |
| **真实同血统旧 ZIP 端到端恢复** | **仍未验证**：磁盘上不存在此类文件（现有两个 zip 均属原型血统） |

「构造 v8 备份」用的是正式迁移链建库 + 程序自身打包逻辑，数据是构造的；
它能证明链路正确，不能替代「真实旧机器导出的包」这一证据。

**已知的构造边界**：v10 的库不可能带着财务数据升到 v11——v11 的迁移以「三张表必须为空」
为前提（v10 期间没有任何写入入口）。因此 v10 夹具只覆盖「表存在但为空」这一合法形态，
带数据的严格恢复由 v11 夹具证明。

## 5. 复现旧包验证

```sh
cd src-tauri
LEGACY_ZIP="/path/to/backup.zip" \
  cargo test --test legacy_restore_manual -- --ignored --nocapture
```

用例会打印 `schema` / 附件数 / 恢复结果或明确的拒绝原因；两种结局都算通过，其余算失败。
所有恢复都在临时目录或隔离 QA 数据根执行，不触碰正式数据。
