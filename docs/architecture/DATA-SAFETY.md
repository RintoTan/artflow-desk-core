# 数据安全与恢复

这份文档回答四件事：数据放在哪、怎么保证不丢、备份里有什么、出问题怎么救。
所有设计都服务于一个前提：**这是用户唯一的台账，没有云端副本**。

## 1. 数据在哪

| 平台 | 路径 |
| --- | --- |
| macOS | `~/Library/Application Support/dev.artflow.minidesk` |
| Windows | `%APPDATA%\dev.artflow.minidesk` |

QA 版使用独立 identifier，并在其根目录下按场景再分一层：

```
~/Library/Application Support/dev.artflow.minidesk.qa/<scenario>/   # macOS
%APPDATA%\dev.artflow.minidesk.qa\<scenario>\                        # Windows
```

场景为 `clean`（空白）、`seeded`（演示数据）、`timeline-*`（时间线空态）。**QA 与正式数据完全隔离，互不读取。**

### 目录结构

```
<数据根>/
├── environment.json         环境元信息
├── state/
│   ├── active.json          当前代际指针（原子写）
│   ├── highwater.sqlite     订单编号高水位（独立于业务库）
│   └── backup.json          上次备份时间与提醒周期（本机状态）
├── generations/
│   └── gen-<uuid>/
│       ├── database.sqlite
│       └── attachments/{originals,thumbs,quarantine}/
├── backups/                 默认导出目录、恢复前自动快照
├── recovery/                失败的恢复/升级现场（不自动清理）
└── logs/app.log             诊断日志（1 MiB 轮转）
```

路径由应用按平台解析，不在代码或文档里硬编码用户目录。

## 2. 代际（generation）机制

**为什么要有代际**：迁移和恢复都会改动整库。直接改原库，中途失败就是半个库；代际把「写入」和「生效」分成两步。

```
新建 generations/gen-<新uuid>/  →  写入并校验  →  原子切换 state/active.json
```

- **旧代际不删除**，保留回退能力（也意味着磁盘会累积，见 §9）。
- 切换前写 `recovery/state.json`，异常退出后可据此判断「上次操作没走完」。
- 恢复/升级失败时，`active.json` 仍指向旧代际 → **现有数据不受影响**。

## 2.1 自定义存储位置（DEV-0.1.1-05）

数据根可以被迁移到任意本地目录。迁移搬的是**整个数据环境**：`environment.json`、
`state/`、`generations/`（全部代际）、`backups/`（含 `.tmp`）、`recovery/failed-restore-*`、
以及 QA 环境下的 `.qa-root`。日志不在数据根内，不参与迁移。

引导指针 `root.json` 固定在应用数据目录（QA 为 `.root-pointers/{scenario}/root.json`），
内容 `{ dataRoot, updatedAt }`，原子写入。指针损坏或目标盘离线时**拒绝启动**，
不会静默回落到默认位置——那会让人对着空库以为数据丢了。

迁移前会先写一份安全快照到旧根 `backups/`，复制后逐个文件校验 SHA-256，
每个代际都要过 `integrity_check` 与 `foreign_key_check`，并实际读一张附件。
旧根永远不会被自动删除。

## 3. 数据库迁移

- 迁移链 append-only：只允许新增 `vN → vN+1`，不允许改写历史迁移文件。
- 每次迁移在**新代际**里执行，整步在事务中，失败整步回滚后放弃该代际。
- 当前 `APP_SCHEMA_VERSION = 12`。版本历史见 [ARCHITECTURE.md](ARCHITECTURE.md#迁移链)。
- 恢复时若 `schemaVersion` **高于**程序支持 → 直接拒绝（不尝试降级）；**低于** → 在隔离代际内沿迁移链升级到当前版本。

## 4. 备份包格式（v1）

```
<backup>.zip
├── database.sqlite                  # VACUUM INTO 一致性快照
├── attachments/originals/<file>     # 原图（必须有）
├── attachments/thumbs/<file>        # 缩略图（可重建）
├── attachments/quarantine/<file>    # 隔离区文件（若有）
└── manifest.json
```

包内**没有**单独的财务文件：四张财务表（平台、计划、收款、退款）本来就在 `database.sqlite` 里，
随 SQLite 快照一起备份，不需要另行打包，也不改变包结构。

`manifest.json` 字段：

| 字段 | 含义 |
| --- | --- |
| `format` / `formatVersion` | 固定 `artflow-minidesk-backup` / `1` |
| `appVersion` | 生成备份的应用版本 |
| `schemaVersion` | 数据库 schema 版本（决定能否恢复） |
| `createdAt` | 导出时间 |
| `workingTimezone` | 导出时的工作时区（影响事件时间解释） |
| `numberHighWater` | 各年度编号高水位 |
| `files[]` | 每个文件的 `path` / `bytes` / `sha256` |
| `totalFiles` / `totalBytes` | 汇总 |

**版本三元独立**：应用版本、数据库 schema 版本、备份格式版本各管各的，互不推导。

## 5. 导出

1. 用 `VACUUM INTO` 生成一致性快照（直接拷 `database.sqlite` 会丢 WAL 未落盘数据）。
2. 收集 `attachments/originals`、`thumbs`、`quarantine`。
3. 逐文件计算 SHA-256，写入 `manifest.json`。
4. 打包 ZIP，默认落到 `<数据根>/backups/`，用户可另选位置。

备份包**未加密**，内含客户姓名、联系方式、金额与图片。

## 6. 恢复

七个步骤，任何一步失败都不切换：

| 步 | 动作 | 失败时 |
| --- | --- | --- |
| 1 | `preview`：读 manifest、比对 schemaVersion、列出订单/客户/附件数量 | 直接拒绝，不动现有数据 |
| 2 | **自动快照**：先把当前数据导出成一份备份 | 拒绝继续 |
| 3 | 在**新代际**目录里解包 | 放弃该代际，删临时目录 |
| 4 | 校验：SQLite `integrity_check` + 外键检查 + 每条附件在 `originals` 里存在 | 放弃该代际 |
| 5 | 需要时沿迁移链升级 schema | 放弃该代际 |
| 6 | 合并编号高水位：`max(本机, 备份)`，逐年取大 | 放弃该代际 |
| 7 | 原子切换 `active.json` | 保持旧代际 |

- 恢复完成后**必须重新打开 Environment**（或重启应用）才能读到新代际；界面会提示重启。
- 高水位只增不减：恢复旧备份后，编号不会退回到旧值，可能产生空号——这是有意设计。

## 6.1 财务数据与平台配置（FIN-07）

**业务历史一律以备份为准，只有平台配置允许跨版本回填。**

| 数据 | 旧备份里没有这张表时 | 备份里有这张表时 |
| --- | --- | --- |
| `payment_platforms`（平台配置） | **回填恢复前的本机配置** | 严格按备份恢复，不与本机合并 |
| `payment_schedules` / `payment_records` / `refund_records` | 升级后为空表 | 严格按备份恢复 |

- **判断依据是「备份原始结构里有没有这张表」，不是迁移后有没有。** 旧库迁移后也会出现
  `payment_platforms`，用迁移后的表存在性判断就永远会回填。因此存在性在**迁移之前**记录。
- 回填只发生在隔离代际内；保留 `id` / `name` / `fee_rate_bp` / `archived` / `sort_position` /
  `created_at`，`updated_at` 记为本次恢复时刻。回填走事务，冲突整体失败，不用 `INSERT OR IGNORE`。
- **不生成虚构记录**：恢复 v9 备份后，付款计划、收款与退款都是 0 行，旧订单显示「未记录收款信息」。
  迁移前后会比对三张业务表的行数，数量变化即拒绝切换。
- **版本与结构必须自洽**：v9 及以前不该有财务表；v10/v11 必须有三张业务表、不该有退款表；
  v12 必须四张齐全且 12 条触发器在位。manifest 的 `schemaVersion` 与库内 `user_version`
  不一致时直接拒绝，不替用户猜这个库属于哪个版本。
- **摘要只是数量**：备份摘要的财务四项是库存计数（含已归档平台、已作废流水、回收站订单的收款），
  不出现金额、客户姓名或备注。表不存在记 0，表存在却统计失败则报错——`unwrap_or(0)` 会把
  结构损坏伪装成「这个版本一条都没有」。

## 7. 校验与防护分层

| 层 | 挡什么 |
| --- | --- |
| ZIP 解包校验 | 绝对路径、`..`、盘符、重复条目、符号链接；解包目标必须在新建代际目录内 |
| manifest 校验 | 文件缺失、大小不符、SHA-256 不符 |
| SQLite 校验 | `integrity_check`、外键一致性 |
| 附件校验 | 每条记录在 `originals` 里能找到原图；只缺缩略图则允许并标记可重建 |
| schema 校验 | 备份版本高于程序 → 拒绝，不尝试降级；manifest 与库内版本不一致 → 拒绝 |
| 财务结构校验 | 财务表与声明的 schema 版本不符（缺表 / 低版本带表）→ 拒绝；v12 缺触发器 → 拒绝 |
| 路径校验 | 附件只存相对路径，读取时拼绝对路径并做前缀校验 |
| 资产协议 | `assetProtocol.scope` 为空，启动时只对**活动代际**的 `attachments` 授权；比对前先把路径解析为真实路径（跟随符号链接），因此指向外的符号链接同样被拒 |

已实测（macOS 真实 WKWebView，开发与打包环境各一轮）：合法缩略图正常加载；`../`、编码穿越、双重编码、AppData 内/外 canary、`/etc/passwd`、`database.sqlite`、跨代际直连、跨代际符号链接**全部被拒**。

Windows（WebView2）使用 `http://asset.localhost/…`，同一套 scope 机制，**尚未在实机逐条复验**。

## 8. 用户数据保护

- **不自动清理任何文件**：隔离文件、旧代际、作业记录一律手动。应用不会在你不知情时删数据。
- **恢复失败不动现有数据**：失败即放弃新代际，`active.json` 不变。
- **恢复前自动快照**：即使恢复了错误的包，也能找回恢复前的状态。
- **单数据目录单实例**：`.write.lock` 防止两个进程同时写。
- **日志不含业务内容**：`logs/app.log` 只记启动 / 窗口 / 退出 / 错误，不写客户与订单。
- **备份包不加密**：这是已知取舍，用户手册里明确提示保管要求。

## 9. 故障恢复

### 先看这三个地方

| 位置 | 看什么 |
| --- | --- |
| `logs/app.log` | 启动失败、退出异常、panic 原因 |
| `state/active.json` | 当前指向哪个代际；文件损坏说明切换没走完 |
| `recovery/state.json` | 上次恢复/升级是否完成 |

### 常见情形

| 情形 | 判断 | 处理 |
| --- | --- | --- |
| 应用起不来，日志有 panic | 多半是数据根或 lock 问题 | 确认没有残留进程；检查 `.write.lock` 是否属于当前用户 |
| 启动后数据像是「回到从前」 | `active.json` 指向了旧代际 | 检查 `generations/` 下最新代际是否完整；完整则切回（需谨慎，先备份整个数据根） |
| 恢复中途断电 | `recovery/state.json` 会留痕 | 重启后应用会拒绝使用未完成代际，`active.json` 仍指旧代际；删掉残留的新代际目录即可 |
| 缩略图缺失 | 正常可重建 | 应用内「重建缩略图」 |
| 原图缺失 | 不可自动恢复 | 从备份恢复；若无备份，该记录会标记异常 |
| 磁盘写满 | 导出/恢复会失败 | 清理旧代际（手动）或换盘；旧代际路径见 §1 |

> 手工操作数据目录前**先整目录复制一份**。任何「删目录」的动作都不可撤销。

## 10. 已知限制

| 项 | 状态 |
| --- | --- |
| 备份加密 | 未做。包内含个人信息，需用户自行保管 |
| 旧代际自动清理 | 未做。磁盘会随迁移/恢复累积，需手动清 |
| 自动定时备份 | 未做。只有手动导出 + 应用内提醒 |
| 跨平台互恢复 | 仅验证「macOS 侧生成的包 → Windows 恢复」；反向未验证 |
| 云端/多设备同步 | 不做（产品决策，见 [PRODUCT-DECISIONS.md](../product/PRODUCT-DECISIONS.md)） |
