# 数据存储

## 位置

| 平台 | 路径 |
| --- | --- |
| macOS | `~/Library/Application Support/dev.artflow.minidesk` |
| Windows | `%APPDATA%\dev.artflow.minidesk` |

路径由应用按平台解析，不在代码或文档里硬编码用户目录。
QA 版在其根目录下按场景分层：`…/dev.artflow.minidesk.qa/<scenario>/`。

## 目录

```
<数据根>/
├── environment.json        环境元信息
├── state/
│   ├── active.json         当前代际指针（原子写）
│   ├── highwater.sqlite    订单编号高水位
│   └── backup.json         上次备份时间与提醒周期
├── generations/gen-<uuid>/
│   ├── database.sqlite
│   └── attachments/{originals,thumbs,quarantine}/
├── backups/                默认导出目录、恢复前快照
└── recovery/               失败现场（不自动清理）
```

## 附件

| 目录 | 内容 | 缺失时 |
| --- | --- | --- |
| `originals/` | 用户导入的原图 | 恢复会被拒绝（不能靠缩略图替代） |
| `thumbs/` | 可重建的缩略图 | 允许缺失，可重建 |
| `quarantine/` | 崩溃恢复时挪出的可疑文件 | 只增不减，需手动清理 |

数据库里只存相对路径；读取时拼接绝对路径并做前缀校验。

## 备份包

ZIP 结构：`database.sqlite` + `attachments/**` + `manifest.json`，manifest 记录每个文件大小与 SHA-256、结构版本、备份格式版本、工作时区、编号高水位。

备份包**未加密**，内含客户与订单信息。

## 迁移与升级

- 迁移只新增，不改写历史迁移文件；
- 升级/恢复都生成新代际，`active.json` 原子切换，旧代际保留；
- 迁移在事务中执行，失败整步回滚。

## 磁盘占用

旧代际不自动清理，长期使用会累积。当前不提供旧代际清理入口（见 ROADMAP）。
