# 备份兼容边界

状态：**生效中**（`d6f410b` 起）
适用：ArtFlow Desk Core 桌面端
上位文档：[DATA-LIFECYCLE](DATA-LIFECYCLE.md)、[ARCHITECTURE](ARCHITECTURE.md)

---

## 1. 兼容承诺

> **ArtFlow Desk Core 正式 Schema 血统内的历史备份，必须能通过迁移链恢复到当前版本。**

正式血统的判定标准（三者同时满足）：

1. 备份 manifest 的 `format` 为 `artflow-minidesk-backup`；
2. 包内 `database.sqlite` 含 `orders`、`clients`、`order_events`、`app_settings` 四张基础表；
3. manifest 的 `schema_version` 与这四张表的存在性自洽。

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

## 4. 验收状态

| 项 | 状态 |
| --- | --- |
| snake_case manifest 可解析 | 已测（`zip_safety`） |
| 缺时区 → 接受并告警 | 已测（`zip_safety`） |
| 缺高水位 → 重建 | 已实现，单测覆盖重建逻辑；真实旧包未跑 |
| 缺总计数 → 重算 | 已测（`zip_safety`） |
| 缺 `format` → 拒绝 | 已测（`zip_safety`） |
| 原型 v2 ZIP → 明确拒绝、不破坏现场 | 已测（`legacy_restore_manual`，真实文件） |
| **同血统真实旧 ZIP 端到端恢复** | **未完成**：磁盘上不存在此类文件（现有两个 zip 均属原型血统） |

## 5. 复现旧包验证

```sh
cd src-tauri
LEGACY_ZIP="/path/to/backup.zip" \
  cargo test --test legacy_restore_manual -- --ignored --nocapture
```

用例会打印 `schema` / 附件数 / 恢复结果或明确的拒绝原因；两种结局都算通过，其余算失败。
所有恢复都在临时目录或隔离 QA 数据根执行，不触碰正式数据。
