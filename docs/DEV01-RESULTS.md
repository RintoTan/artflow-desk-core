# DEV-01 正式工程初始化与数据基座 — 结果报告

- 日期：2026-11-16
- 工程：`/Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk`
- 结论：**DEV-01 通过**（98 个 Rust 测试全绿，窗口在 macOS 真实启动）。
  不等于 miniDesk v1.0 完成。

---

## A. 执行摘要

已建成独立正式工程与单库数据基座，六项批准决策全部落地：

| 决策 | 结果 |
|---|---|
| J-1 单库基座 | 一个 `database.sqlite` 承载订单、阶段、事件、客户、模板、附件元数据、清理任务、主题、设置 |
| J-2 编号高水位 | `state/highwater.sqlite` 独立小库，`AF-YYYY-NNNN`，恢复旧备份不降、删除不复用 |
| J-3 单实例 | `fs2` 跨进程目录锁，第二进程 `BUSY`；未引入 single-instance 插件 |
| J-4 UI 范围 | Arctic Blue 基础视觉 + 导航壳 + 真实环境状态 + 可用时区设置，未实现模块明确标注 |
| J-5 文档归档 | TV-01～TV-03.5 四份报告复制到 `docs/tv/`，每份加归档声明 |
| J-6 代际保留 | 活动代 + 一个有效回退代 + 未确认身份者一律保留，不按时间删到 N 个 |

实测：`cargo test` **98 passed / 0 failed**；`tsc --noEmit` 通过；`vite build` 通过；
应用在 macOS 真实启动（窗口 1120×760），运行中第二个进程被拒绝（退出码 3）。

---

## B. 工程路径与 Git 状态

| 项 | 值 |
|---|---|
| 正式工程 | `/Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk` |
| Git | 已初始化，本地提交 12 个，**未推送远程** |
| 分支 | `main`（默认） |
| 工作区 | 干净（`status --porcelain` 为空） |
| 跟踪文件 | 65 个 |
| 应用标识 | `dev.artflow.minidesk`（与 `dev.artflow.minidesk.tv01` 隔离） |

### 旧 Web 工程（受保护，未修改）

| 项 | DEV-01 开始时 | DEV-01 结束时 |
|---|---|---|
| 分支 | `work/u8-restart-prototypes` | 同 |
| HEAD | `e1d8d64` | **`a4dccda`** |
| 工作区 | 0 行 | 0 行 |

**如实记录两处变化，均非本工程所为：**

1. 会话中途出现 5 个未提交改动（`src/templates/meta.ts` 19:14、`registry.tsx` 19:16 等），
   是另一个进程在编辑模板功能。
2. 结束时 HEAD 已前进到 `a4dccda`（`feat(templates): editorial-motion runtime slice`），
   工作区重新变干净。

我没有对旧工程执行任何 reset / clean / checkout / 写入。

---

## C. 新增与迁移的模块

### 新增（全部为正式工程新写，非复制）

| 路径 | 职责 |
|---|---|
| `src-tauri/src/error.rs` | `AppError{code,message}`，稳定错误码契约 |
| `src-tauri/src/store/paths.rs` | 数据环境目录布局 |
| `src-tauri/src/store/generation.rs` | 活动指针原子写、代际列举、可清理性判定与安全删除 |
| `src-tauri/src/store/environment.rs` | 环境打开与自检、隔离代际升级 |
| `src-tauri/src/store/migrations/{mod,v1}.rs` | 迁移链与 schema v1 |
| `src-tauri/src/store/highwater.rs` | 年度编号高水位独立小库 |
| `src-tauri/src/store/timezone.rs` | IANA 时区、时间戳、日历日期 |
| `src-tauri/src/store/settings.rs` | 设置读写与首次默认数据 |
| `src-tauri/src/store/diagnostics.rs` | 只读诊断查询（命令层不写 SQL） |
| `src-tauri/src/domain/numbering.rs` | `AF-YYYY-NNNN` 格式化与预留 |
| `src-tauri/src/domain/orders.rs` | 最小建单事务 |
| `src-tauri/src/media/mod.rs` | 附件路径安全与资源限制 |
| `src-tauri/src/backup/zip_read.rs` | 备份包中央目录校验、manifest、SHA-256 |
| `src-tauri/src/infra/lock.rs` | 跨进程目录锁 + 锁文件身份校验 |
| `src-tauri/src/infra/state.rs` | 进程状态（环境 + 高水位） |
| `src-tauri/src/commands/{status,preferences,orders}.rs` | 4 个产品的薄命令 |
| `src-tauri/src/bin/minidesk_probe.rs` | 测试探针（不随安装包分发） |
| `src/**` | Arctic Blue 外壳、状态页、设置页、占位页 |
| `src-tauri/tests/*` | 9 个集成测试文件 + 共用夹具 |

### 迁移（按 J-5 归档，不含代码搬运）

`docs/tv/TV01-RESULTS.md`、`TV02-RESULTS.md`、`TV03-RESULTS.md`、`TV035-RESULTS.md`
从实验工程复制，每份顶部加归档声明；未复制任何数据库、沙箱或构建缓存。

### 有意未迁移

`tv03_demo`、`seed()`、`Fault` 故障注入枚举、测试台页面、`tv03_crash`／`tv035_probe`
二进制、实验样式表。这些留在实验工程，不进入产品。

---

## D. 单库与编号架构

### D.1 单库

```text
generations/gen-<id>/database.sqlite   ← 唯一业务库
  orders / order_stages / order_events
  clients / stage_templates / stage_template_steps
  attachments / cleanup_tasks / themes / app_settings / schema_meta
```

订单与附件在同一个库、同一个事务域，`attachments.order_id` 有外键约束，
删除订单连带删除附件元数据（`ON DELETE CASCADE`）。

**没有第二套可以独立修改订单的数据库。** TV-01 主库与 TV-03 沙箱库都留在实验工程，
正式应用从不打开它们。

### D.2 编号

```text
state/highwater.sqlite     ← 独立于业务代际
  number_high_water(year INTEGER PRIMARY KEY, last_allocated INTEGER)
```

分配顺序：

```text
BEGIN IMMEDIATE
  INSERT ... ON CONFLICT(year) DO UPDATE SET last_allocated = last_allocated + 1
  RETURNING last_allocated        → 提交（此刻编号已"持久保留"）
然后
  BEGIN IMMEDIATE 业务事务：写订单 + 订单阶段 + created 事件 → 提交
```

- 两个 SQLite 文件**没有**跨文件事务。因此预留后业务失败只会**跳号**，绝不复用。
- 编号与 `queue_position` 完全无关：测试把订单换位后编号不变。
- 年份在创建时按当时工作时区确定并固定（`AF-2026-0001` 中的年份不随之后改时区变化）。
- 恢复旧备份：`merge()` 逐年取 `max(本机, 备份)`，只升不降。
- 高水位库缺失或损坏：返回 `NUMBERING` 并**阻止启动**，不静默重建。

---

## E. 数据迁移与恢复策略

### E.1 迁移链

- 版本即 `PRAGMA user_version`，只增不减。
- 每步在自己的 `BEGIN IMMEDIATE` 事务内执行，失败整步回滚。
- `current > APP_SCHEMA_VERSION` → `SCHEMA` 错误，旧程序拒绝写新库。

### E.2 升级在隔离代际完成

```text
1. 新建 gen-<new>
2. VACUUM INTO 复制当前库 → 新代际
3. 复制 attachments（不跟随符号链接）
4. 在新库上跑迁移链到目标版本
5. 校验：integrity_check = ok 且 foreign_key_check 为空 且 版本达标
6. 写 recovery/state.json → 原子替换 active.json → 清除 recovery
```

任一步失败：删除新代际目录、清除 recovery、指针未动，旧代际继续服务。
实测 `failed_upgrade_keeps_old_generation_and_pointer` 验证了"版本不前进、数据仍在、无残留目录"。

### E.3 启动自检

| 现场 | 行为 |
|---|---|
| 无标记 + 无代际 + 无指针 | 真正的首次启动 → 初始化 |
| 有代际但无指针 | `ENV` 拒绝，**不**创建空库 |
| 有指针但无环境标记 | `ENV` 拒绝 |
| 活动代目录或库文件缺失 | `ENV` 拒绝 |
| 库版本高于程序 | `SCHEMA` 拒绝 |
| 编号记录缺失 | `NUMBERING` 拒绝 |

### E.4 代际清理（J-6）

保护：活动代、`recovery/state.json` 引用的 previous/target、最近一个通过校验的历史代，
以及任何"身份不明"的条目（符号链接、缺库目录）——后者进 `unknown`，永不删除。
有未完成恢复时，全部保留、候选为空。删除前重新确认活动库存在、候选是普通目录且父目录正确。

**未实现**：清理的手动入口命令（DEV-07 与备份一起做）；当前只有领域函数与测试。

---

## F. 测试命令、结果与证据

### F.1 命令与总计

| 检查 | 命令 | 结果 |
|---|---|---|
| Rust 全量测试 | `cargo test` | **98 passed / 0 failed** |
| Rust 编译 | `cargo check --all-targets` | 通过，0 告警 |
| TypeScript | `npx tsc --noEmit` | 通过（exit 0） |
| 前端构建 | `npx vite build` | 通过，`index-*.js` 319.97 kB（gzip 101.59 kB），94 ms |
| 真实启动 | `npm run tauri dev` | 通过（见 F.3） |

### F.2 逐套用例

| 测试文件 | 用例 | 覆盖 |
|---|---|---|
| `tests/schema.rs` | 15 | 单默认模板、同模板阶段重名、编号唯一、NULL 金额 ≠ 0、负金额、日期倒挂、终态时间戳一致性、当前阶段必须属于本单（可延迟外键）、同名客户不合并、删单级联附件、清理任务唯一、事件类型枚举、主题 JSON、外键运行时生效 |
| `tests/migrations.rs` | 10 | 空库建到 v1、重启复用代际、隔离代际升级并保留旧代、失败升级回滚、高版本拒绝、缺 v1 定义、重复启动不重复播种、缺指针拒绝、缺库文件拒绝、错误码稳定 |
| `tests/numbering.rs` | 15 | 首号 0001、同年连号、跨年各自计数、删除不回退、与队列位置无关、预留后失败只跳号、数据库层拦重复、`request_id` 幂等、旧备份恢复不降水位、更早年份被吸收、损坏记录阻止分配、缺失记录阻止启动、进程重启保持、**真实 abort 后编号继续前进**、两进程不得同号 |
| `tests/timezone.rs` | 9 | 初始时区持久化、非法 IANA 拒绝、改时区跨重启保持、改时区不改时间戳、同一瞬间在不同时区映射到不同年份、编号年份随时区、事件归属日、日历日期拒绝时间戳、时间戳格式 |
| `tests/lock.rs` | 10 | 单进程取得锁、**第二进程 BUSY 退出码 3**、正常退出释放、**abort 后内核释放**、竞争时恰好一个成功、不同根目录独立、符号链接别名不能绕过、同进程不能二次取得、**锁文件被替换被发现**、竞争后数据完整 |
| `tests/environment.rs` | 10 | 首次启动目录完整、重启不算首次、缺标记拒绝、单代不清理、活动代与回退代保护、未完成恢复全保护、符号链接不入候选、执行清理幂等、活动库消失即停止、指针记录代际 |
| `tests/media.rs` | 8 | 上限符合规格（100 MB / 480px）、合法相对路径、12 类危险路径拒绝、`safe_join` 不越界、`ensure_within` 拒绝越界（`DENIED`）、原图与缩略图路径分离、格式与 MIME 映射、尺寸/像素限制 |
| `tests/zip_safety.rs` | 11 | 合法包通过、缺 manifest、哈希不符、清单与条目不一致、格式版本过高、缺工作时区、路径穿越、**真实重复条目（中央目录 2 个、解析库只见 1 个）**、大小写冲突、反斜杠与非 ASCII、校验只读 |
| `tests/commands.rs` | 10 | 白名单精确一致、未知命令被抓、缺失命令被抓、白名单不来自源码、危险/实验命令不存在、`lib.rs` 无 SQL、命令层无 SQL、capabilities 精确 4 项、前端不直连数据库、打包配置不含探针 |

### F.3 真实启动证据

```text
[minidesk] env ready path=/Users/rinto/Library/Application Support/dev.artflow.minidesk
           generation=gen-f8930531c59f437795d99d28a7ae25c5 schema=v1 first_run=true tz=Asia/Shanghai
```

- 窗口（CoreGraphics 窗口列表实测）：`WIN 34868 owner=artflow-minidesk bounds=1120×760 @ (400,103)`
- GUI 注册：`lsappinfo` 显示 `"artflow-minidesk" … (in front)`
- 开发服务器：`http://127.0.0.1:1420/` 返回 200
- 应用运行期间，第二个进程被拒绝：
  `BUSY code=BUSY message=另一个 ArtFlow miniDesk 进程正在使用这个数据目录`，退出码 **3**
- 关闭应用后同一探针 `ACQUIRED`，退出码 0
- 数据库实测：`user_version=1`、模板 1 个、阶段 5 个、主题 1 个、`working_timezone=Asia/Shanghai`

**未做**：窗口像素截图。`screencapture -l 34868` 返回 `could not create image from window`
（缺少屏幕录制权限），因此界面外观只由窗口尺寸与进程状态证明，**未经我肉眼核对**。

---

## G. 异常与缺陷清单

### G.1 本轮发现并已修复

| # | 问题 | 处理 |
|---|---|---|
| 1 | `tauri.conf.json` 的 macOS 段不接受 `developmentRegion`，`tauri-build` 直接编译失败 | 改为写 `src-tauri/Info.plist`（`CFBundleDevelopmentRegion=zh_CN` + `CFBundleLocalizations`） |
| 2 | 订单的 `(id, current_stage_id)` 外键在"先插订单再插阶段"时立刻失败 | 改为 `DEFERRABLE INITIALLY DEFERRED`，并在测试里固定"必须在同一事务内提交"这一约束 |
| 3 | `tests/lock.rs` 用固定 `sleep(300ms)` 等子进程取锁，全量并行跑时偶发失败 | 改为读取子进程 stdout 直到出现 `LOCKED`，消除调度竞态 |
| 4 | `HighWater::open` 对非数据库文件返回 `DB` 而非 `NUMBERING` | 连接阶段的错误统一映射为 `NUMBERING`，语义与阻塞原因一致 |
| 5 | 命令层 `status.rs` 内联了 `SELECT COUNT(*)` | 抽到 `store/diagnostics.rs`，并用测试锁死"命令层无 SQL" |
| 6 | `image` 依赖未被使用（附件导入属 DEV-04） | 暂时移除，避免无用依赖与告警；DEV-04 再引入 |

### G.2 已知限制（不是缺陷，但需记录）

1. `stage_template_steps` 只约束 `UNIQUE(template_id, title)`，**没有** `UNIQUE(template_id, position)`。
   原因：重排阶段时唯一位置约束会让中间态非法。顺序正确性由 DEV-03 的领域层保证，读取一律 `ORDER BY position, step_id`。
2. 编号 `merge()` 目前只有库函数与测试，**尚未接入备份恢复流程**（DEV-07）。
3. 备份包只有**校验**能力，没有生成能力（DEV-07）；因此本轮无法产出真实备份做端到端恢复。
4. 附件导入/缩略图生成未实现（DEV-04）；`media` 目前只提供路径安全与限制常量。
5. 未实现未保存修改保护、快捷键、列表密度（DEV-06）。
6. macOS 系统文件对话框的简体中文显示**仍未验证**（TV-03 遗留项，本轮未触碰）。
7. Windows 全部未测：文件锁在 Windows 的语义、打包、WebView2 均属 DEV-09。

---

## H. 隔离核验

| 对象 | 结果 |
|---|---|
| ArtFlowDesk 旧工程 | 未修改任何文件；HEAD 由 `e1d8d64` 前进到 `a4dccda`（外部进程所为，如实记录，未回滚）；工作区 0 行 |
| TV-01 实验数据库 | `integrity_check = ok`，订单 1，历史 5 —— 与本轮开始时一致 |
| TV-03 演示沙箱 | 2 个代际，1 个备份，无未完成恢复 —— 未触碰 |
| 实验工程源码 | 未修改；仅**读取**，并从中复制了 4 份报告到 `docs/tv/` |
| 正式应用数据目录 | 首次启动时新建 `~/Library/Application Support/dev.artflow.minidesk/`，仅含环境标记、锁、指针、高水位库、空业务库与默认模板/主题；**没有任何虚构订单或业务数据** |
| 所有测试数据 | 全部在 `tempfile` 临时目录，测试结束由 `TempDir` 回收 |

---

## I. 本地 Git 提交列表

```text
f28ad73  chore: scaffold ArtFlow miniDesk project skeleton
1ce2e39  feat(core): crate skeleton, structured errors and minimal capabilities
2a5a3e1  feat(store): single business database with generations, migrations and high-water marks
68efc45  feat(domain): AF-YYYY-NNNN numbering and minimal order creation
3741b7f  feat(media,backup): attachment path safety and backup archive validation
ae088d6  feat(infra): cross-process data directory lock
793315a  feat(commands): minimal product command surface
2621f93  feat(ui): Arctic Blue shell with real environment status
1293b46  test: DEV-01 coverage for schema, migrations, numbering, tz, lock, media, zip, commands
6ad3ea2  docs: DEV-01 results report
<后续>  docs: correct commit count in DEV-01 report
```

未推送远端。

---

## J. DEV-02 的前置条件与建议

### 前置条件（建议先确认）

1. **订单"整体保存"的字段边界**：D-00-03 要求资料分区编辑但一次整体保存。
   需要明确哪些字段属于"资料"（标题、客户、类型、金额、计划日期），
   哪些属于独立事务（阶段推进、附件操作）。我按此理解实现，但需要确认。
2. **建单时是否允许内联创建客户**：当前 `create_order` 要求 `client_id` 已存在。
   若允许"边建单边建客户"，需要明确失败回滚语义。
3. **`revision` 的粒度**：现有设计每次资料写入 +1，排序等操作是否也 bump 需要定。

### DEV-02 建议范围

- 订单编辑（整体保存 + `revision` 乐观锁 + 冲突提示）
- 制作流程：推进、返工、开工、撤销开工（含 FIX-02／FIX-03 的前置条件校验）
- 终态：完成、取消、重新打开（FIX-04 时间语义）
- 生命周期事件补齐：`work_started`、`work_start_undone`、`stage_advanced`、`stage_reworked`、`workflow_changed`、`completed`、`cancelled`、`reopened`
- 队列位置：插入位置选择与事务化重排（编号不受影响）

### 验收建议

沿用本轮口径：每个写操作一个事务、失败不得报告成功、
所有新增命令必须进白名单、真实子进程验证并发与崩溃。
界面只做到"能真实操作"，视觉打磨留给 DEV-06。

---

## 判定

**DEV-01 通过**，无未解决 P0。

同时明确：这**不是** v1.0 完成。当前可交付的只有数据基座与最小窗口；
订单业务闭环、附件、统计、主题、备份恢复、Windows 交付全部未实现。
