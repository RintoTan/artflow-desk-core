# 文档索引

ArtFlow Desk Core 的全部文档按「当前有效 / 历史归档」两类组织。
每份历史文档都保留原件，不做内容改写；索引里标注当前有效版本。

## 当前有效文档

| 目录 | 文件 | 内容 |
| --- | --- | --- |
| `product/` | [PRODUCT-OVERVIEW.md](product/PRODUCT-OVERVIEW.md) | 产品定位、目标用户、能力边界 |
| | [FEATURE-MAP.md](product/FEATURE-MAP.md) | 每个模块「已实现 / 未实现」清单 |
| | [PRODUCT-ROADMAP.md](product/PRODUCT-ROADMAP.md) | 已完成、进行中、暂缓 |
| | [PRODUCT-DECISIONS.md](product/PRODUCT-DECISIONS.md) | 关键产品取舍与理由 |
| `architecture/` | [SYSTEM-OVERVIEW.md](architecture/SYSTEM-OVERVIEW.md) | 技术栈、进程模型、模块划分 |
| | [DATA-ARCHITECTURE.md](architecture/DATA-ARCHITECTURE.md) | 代际、schema 迁移、备份格式 |
| | [SECURITY-AND-PRIVACY.md](architecture/SECURITY-AND-PRIVACY.md) | 数据边界、资产协议、隐私 |
| `user-guide/` | [macOS-USER-GUIDE.md](user-guide/macOS-USER-GUIDE.md) | macOS 安装与使用 |
| | [Windows-USER-GUIDE.md](user-guide/Windows-USER-GUIDE.md) | Windows 安装与使用 |
| `releases/` | [macOS-DEMO.md](releases/macOS-DEMO.md) | macOS Demo 产物与验证状态 |
| | [Windows-DEMO.md](releases/Windows-DEMO.md) | Windows Demo 构建与验收状态 |
| | [KNOWN-LIMITATIONS.md](releases/KNOWN-LIMITATIONS.md) | 已知限制 |
| `reports/` | `DEV-07/` `DEV-08/` `DEV-09/` | 各阶段实施与验收报告（只读保留） |

## 历史归档

`planning-archive/` 下按类型存放历史材料，**原件不改写**，仅移动并索引：

| 目录 | 内容 | 状态 |
| --- | --- | --- |
| `product-planning/` | 早期产品规划、阶段 Prompt、范围讨论 | 已被 `product/` 取代，留档 |
| `development-specs/` | DEV-01～DEV-06 各阶段规格与结果 | 已完成（部分已重构） |
| `historical-decisions/` | 技术选型、UI 方向、数据结构决策记录 | 有效决策已提炼进 `architecture/` |

冲突时以「当前有效文档」为准；归档文件仅用于追溯当时的判断依据。

## 说明

- 归档里的报告可能包含当时的本机绝对路径（`/Users/...`）与阶段编号，属于历史记录，未做清洗。
- 用户手册面向普通使用者，不包含开发阶段编号或内部实现细节。
