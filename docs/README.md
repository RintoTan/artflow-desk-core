# 文档索引

ArtFlow Desk Core 的文档分为「产品」「架构」「开发」「用户手册」「版本发布」五类。
仓库只保留当前有效版本；历史阶段的规格、验收报告与测试证据不随仓库分发。

## 产品

| 文件 | 内容 |
| --- | --- |
| [PRODUCT-OVERVIEW.md](product/PRODUCT-OVERVIEW.md) | 产品定位、目标用户、能力边界 |
| [PRODUCT-REQUIREMENTS.md](product/PRODUCT-REQUIREMENTS.md) | 已实现 / 部分实现 / 未实现 / 已延期 |
| [FEATURE-MAP.md](product/FEATURE-MAP.md) | 每个功能模块的实际能力清单 |
| [PRODUCT-DECISIONS.md](product/PRODUCT-DECISIONS.md) | 关键产品取舍与理由 |
| [ROADMAP.md](product/ROADMAP.md) | 已完成、已知问题、下一阶段、中长期候选 |

## 架构

| 文件 | 内容 |
| --- | --- |
| [SYSTEM-ARCHITECTURE.md](architecture/SYSTEM-ARCHITECTURE.md) | 技术栈、进程模型、模块划分、前后端通信 |
| [DATABASE-ARCHITECTURE.md](architecture/DATABASE-ARCHITECTURE.md) | schema、迁移链、事件模型、并发与幂等 |
| [DATA-STORAGE.md](architecture/DATA-STORAGE.md) | 数据目录、代际切换、附件布局、备份格式 |
| [SECURITY-AND-PRIVACY.md](architecture/SECURITY-AND-PRIVACY.md) | 数据边界、资源协议、符号链接防护 |

## 开发

| 文件 | 内容 |
| --- | --- |
| [DEVELOPMENT-GUIDE.md](development/DEVELOPMENT-GUIDE.md) | 环境要求、本地启动、测试、类型检查、目录说明 |
| [BUILD-GUIDE.md](development/BUILD-GUIDE.md) | macOS 与 Windows 构建、QA 构建、常见问题 |
| [RELEASE-GUIDE.md](development/RELEASE-GUIDE.md) | 版本号规则、打包命名、校验和、Release 流程 |
| [WINDOWS-MANUAL-TEST.md](development/WINDOWS-MANUAL-TEST.md) | Windows 系统级手动清单 T01–T40（全部 NOT RUN）+ 2026-11-20 真机两阶段结果索引（§4.5） |

## 用户手册

| 文件 | 内容 |
| --- | --- |
| [USER-MANUAL.md](user-guide/USER-MANUAL.md) | 完整手册，面向普通画师 |
| [USER-MANUAL-macOS.md](user-guide/USER-MANUAL-macOS.md) | macOS 安装与使用分册 |
| [USER-MANUAL-Windows.md](user-guide/USER-MANUAL-Windows.md) | Windows 安装与使用分册 |

## 版本发布

| 文件 | 内容 |
| --- | --- |
| [v0.1.0.md](releases/v0.1.0.md) | 本版功能范围、下载与校验状态 |
| [macOS-DEMO.md](releases/macOS-DEMO.md) | macOS Demo 产物、签名状态、验收记录 |
| [Windows-DEMO.md](releases/Windows-DEMO.md) | Windows Demo 构建来源、产物、实机验收结果与仍未验证项 |
| [KNOWN-LIMITATIONS.md](releases/KNOWN-LIMITATIONS.md) | 当前版本的已知限制与边界 |

## 截图

`assets/screenshots/` 下 8 张，全部取自 QA 环境（虚构数据），无客户隐私与本地路径。

## 说明

- 本仓库不包含开发阶段的 Prompt、验收报告、原始日志与测试证据；这些材料按阶段保存在项目外部的工作区中，需要追溯时由项目所有者提供。
- `WINDOWS-MANUAL-TEST.md` 中的 T01–T40 尚未在 Windows 真机执行；另有 2026-11-20 的两阶段实机矩阵（PHASE-01 10 项 / PHASE-02 46 项，合计 56 项），两者是并行的两套范围，不能互相替代。
