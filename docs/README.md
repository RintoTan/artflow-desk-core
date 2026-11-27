# 文档地图

这个仓库的文档按用途分五类。**先看这张表，再决定读哪一份**——不用从头读到尾。

## 〇、一页速览

| 项 | 现状 |
| --- | --- |
| 项目 | ArtFlow Desk Core——独立画师的本地委托管理桌面应用（Tauri 2 + React 19 + Rust + SQLite） |
| 版本 | `0.1.2`（schema v14），2026-11-26 发布；Tag 对象 `740233b` → `1935fb0` |
| 产物 | macOS arm64（adhoc 签名、未公证）+ Windows x64 Setup / Portable（CI 构建，未实机验收）；Windows 确认由 `41a41b4` 构建（CI run `45820351883`），macOS 推定为同一提交（产物内无构建号，不能自证）。两者都比 Tag 多一个排序修复 |
| 自动化 | Rust 723 passed / 前端 97 文件 956 passed / `tsc`、`build` 通过 |
| 已实机验证 | macOS QA 构建的八页、订单详情、附件、备份面板、版本弹窗、v13→v14 迁移 |
| 未验证 | macOS 正式包启动、干净机器首开、Windows 实机安装、恢复后界面看图、880×500 窄窗 |
| 代码规模 | 340+ 个提交，271 个源码文件（176 前端 / 95 Rust），67 个 Rust 集成测试文件 |
| 下一阶段 | 先关三条验收尾巴，再挑产品缺口（见 [ROADMAP](product/ROADMAP.md)） |

## 一、三条阅读路线

| 你是谁 / 要做什么 | 读这三份 | 时间 |
| --- | --- | --- |
| 刚接手开发 | [开发交接](handoff/DEVELOPMENT-HANDOFF.md) → [产品决策](product/PRODUCT-DECISIONS.md) → [项目状态](releases/PROJECT-STATUS.md) | ~25 分钟 |
| 想了解项目本身 | [README](../README.md) → [产品概览](product/PRODUCT-OVERVIEW.md) → [项目历史](history/PROJECT-HISTORY.md) | ~15 分钟 |
| 排查数据 / 备份问题 | [数据生命周期](architecture/DATA-LIFECYCLE.md) → [数据安全](architecture/DATA-SAFETY.md) → [备份兼容](architecture/BACKUP-COMPATIBILITY.md) | 按需查 |

## 二、目录

### 规划

| 文档 | 回答什么 |
| --- | --- |
| [产品概览](product/PRODUCT-OVERVIEW.md) | 定位、目标用户、业务流程、功能体系 |
| [产品决策](product/PRODUCT-DECISIONS.md) | 已裁定的取舍与不可擅改的规则（含否决清单） |
| [路线图](product/ROADMAP.md) | 已完成 / 进行中 / 已确认未排期 / 暂缓 / 不在计划内 |
| [UX-02 规格](product/UX-02-SPEC.md) | 窗口布局与 DPI 的验收规格 |

### 当前状态

| 文档 | 回答什么 |
| --- | --- |
| [项目状态](releases/PROJECT-STATUS.md) | 版本、平台状态、测试基线、已知问题、未关闭事项（**当前事实以此为准**） |
| [变更记录](../CHANGELOG.md) | 每个版本改了什么 |
| [0.1.2 最终审计](releases/FINAL-AUDIT-0.1.2.md) | 0.1.2 的验收证据与未验证项 |
| [0.1.2 交付清单](releases/DELIVERY-0.1.2.md) | 工作包 → 代码位置 → 测试的对应关系 |
| [2026-11-26 文档审计](AUDIT-2026-11-26.md) | 16 处漂移、修复、剩余风险，以及 11-27 复审（Tag 与产物来源、架构补审）的补记 |

### 架构

| 文档 | 回答什么 |
| --- | --- |
| [技术架构](architecture/ARCHITECTURE.md) | 技术栈、模块边界、进程与数据流 |
| [数据生命周期](architecture/DATA-LIFECYCLE.md) | 代际、软删除、可见性三层、回收站、清理 |
| [数据安全](architecture/DATA-SAFETY.md) | 存储、迁移、备份、恢复、故障处理 |
| [备份兼容](architecture/BACKUP-COMPATIBILITY.md) | 旧包格式、manifest 兼容规则 |
| [FIN-07 备份契约](architecture/FIN-07-BACKUP-CONTRACT.md) | 财务数据在备份/恢复中的结构判定与回填 |

### 开发与发布

| 文档 | 回答什么 |
| --- | --- |
| [开发交接](handoff/DEVELOPMENT-HANDOFF.md) | 接手入口：目录、数据层、硬规则、测试、发布、坑、验收状态 |
| [开发与构建](development/DEVELOPMENT.md) | 环境、命令、测试约定 |
| [发布指南](releases/RELEASE-GUIDE.md) | 构建命令、签名与公证现状、发布检查清单 |

### 历史与素材

| 文档 | 回答什么 |
| --- | --- |
| [项目历史](history/PROJECT-HISTORY.md) | 阶段、版本谱系、schema 演进、三轮资产替换、被否决的方案 |
| [0.1.2 截图清单](assets/screenshots/0.1.2/SHOTS-0.1.2.md) | 8 张界面截图的拍摄环境与内容 |
| [0.1.1 归档截图](assets/screenshots/archive/0.1.1/README.md) | 旧界面，仅作对照，**不代表当前版本** |
| [用户手册](user-guide/USER-MANUAL.md) | 安装、日常使用、备份、排错 |

## 三、文档冲突时以谁为准

从强到弱：

1. **代码、迁移、测试**——唯一可执行的事实。文档与代码不一致时，先确认代码是不是有意的，再改文档。
2. [项目决策](product/PRODUCT-DECISIONS.md)——已裁定的产品口径，代码若与它冲突属缺陷。
3. [项目状态](releases/PROJECT-STATUS.md)——当前版本、平台、测试基线、未关闭事项的唯一口径。
4. [变更记录](../CHANGELOG.md)——版本级变更。
5. 架构文档——机制解释，可能落后于实现，读时对照代码。
6. 历史文档、归档截图、旧审计——只作对照，不作现状依据。

## 四、发版时必须同步的五处

漏一处就会出现「文档互相打架」——本轮审计发现的问题几乎全是这么来的。

| # | 位置 | 内容 |
| --- | --- | --- |
| 1 | `package.json` / `src-tauri/Cargo.toml` / `tauri.conf.json` / CI `APP_VERSION` | 四处版本号，由 `tests/version_consistency.rs` 守 |
| 2 | [PROJECT-STATUS](releases/PROJECT-STATUS.md) §三之九 | 产物文件名、字节数、SHA-256、Tag 指向的提交 |
| 3 | [README](../README.md) 校验表 | 三件产物的 SHA-256 |
| 4 | [FINAL-AUDIT](releases/FINAL-AUDIT-0.1.2.md) 或当期审计 | 发布资产表与「未验证」清单 |
| 5 | [开发交接](handoff/DEVELOPMENT-HANDOFF.md) §八 | 验收状态矩阵 |

另外：本轮整理期间未移动 Tag；master 领先 tag 的提交必须在状态文档里逐条说明性质（文档 / 代码 / 配置）。0.1.2 就是这种情况：`41a41b4` 是运行时修复，Windows 包由它构建、macOS 包推定为同一提交，与 Tag 不是同一快照。

## 五、本轮核对

2026-11-26 整理：文档地图、项目历史、开发交接、项目状态、0.1.2 审计/交付/发布指南、变更记录、README 逐份核对到 `fec7f16`。
2026-11-27 复审：架构五份（`ARCHITECTURE` / `DATA-SAFETY` / `DATA-LIFECYCLE` / `BACKUP-COMPATIBILITY` / `FIN-07`）按 schema v14 与代码补审，修正了 v12/v13 的当前版本表述与迁移链顺序；`PRODUCT-DECISIONS` 补齐财务、排序、客户参考图、看板、吸顶撤回等 10 条。
