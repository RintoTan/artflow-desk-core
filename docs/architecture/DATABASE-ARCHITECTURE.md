# 数据架构

## 目录结构

```
<app_data_dir>/                     # macOS: ~/Library/Application Support/dev.artflow.minidesk
│                                   # Windows: %APPDATA%\dev.artflow.minidesk
├── environment.json                # 环境元信息
├── state/
│   ├── active.json                 # 指向当前代际（原子写）
│   ├── highwater.sqlite            # 订单编号高水位（独立于业务库）
│   └── backup.json                 # 上次备份时间与提醒周期（本机状态）
├── generations/
│   └── gen-<uuid>/
│       ├── database.sqlite
│       └── attachments/{originals,thumbs,quarantine}/
├── backups/                        # 默认导出目录与恢复前快照
└── recovery/                       # 失败的恢复/升级现场（不自动清理）
```

QA 版在其根目录下按场景再分一层：`…/dev.artflow.minidesk.qa/<scenario>/`。

## 代际（generation）

- 每次 schema 迁移或备份恢复都新建代际目录，写入完成后原子切换 `active.json`。
- 旧代际**不自动删除**，保留回退能力。
- 切换前写 `recovery/state.json`，异常退出后可据此判断「上次操作没走完」。

## Schema 版本

当前 `APP_SCHEMA_VERSION = 7`。迁移是 append-only 的 `v1…v7`，只允许新增，不允许改写历史迁移。

| 版本 | 内容 |
| --- | --- |
| v1 | 基础表：orders / order_stages / order_events / attachments / clients / stage_templates |
| v2–v5 | 队列、排期、标签、作业与清理任务等逐步补齐 |
| v6 | `order_events` 增加 `rescheduled` 与改期六字段（原/新开始与交付日期、原因、来源） |
| v7 | `order_events` 增加 `stage_skipped`、`skipped_stages`（JSON 快照）、`skip_reason` |

SQLite 不能改 CHECK 约束，v6/v7 都是「建新表 → 搬迁 → 建索引 → 改名为原表」的重建式迁移，带事务整体回滚。

## 核心表

| 表 | 说明 |
| --- | --- |
| `orders` | 订单主体、状态、revision、计划日期、队列位置 |
| `order_stages` | 每个订单自己的阶段副本（来自模板），按 position 排序 |
| `order_events` | 只追加的事件流：创建、开工、推进、返工、跳级、改期、完成、取消、重开 |
| `attachments` | 附件元数据（相对路径），原图必须在，缩略图可重建 |
| `attachment_jobs` | 导入/修复作业（pending / done / failed） |
| `cleanup_tasks` | 待清理文件（含代际归属） |
| `clients` / `client_tags` | 客户与标签 |
| `stage_templates` | 流程模板（系统保留一个默认模板） |

## 备份格式（v1）

```
<backup>.zip
├── database.sqlite                  # VACUUM INTO 一致性快照
├── attachments/originals/<file>
├── attachments/thumbs/<file>
├── attachments/quarantine/<file>
└── manifest.json                    # format/formatVersion/appVersion/schemaVersion/
                                     # createdAt/workingTimezone/numberHighWater/
                                     # files[path,bytes,sha256]/totalFiles/totalBytes
```

- 版本三元独立：**应用版本**、**数据库 schema 版本**、**备份格式版本**。
- 恢复时：`schemaVersion` 高于程序支持 → 拒绝；低于 → 在隔离代际内沿迁移链升级。
- 高水位恢复取 `max(本机, 备份)`，编号永不回退。
