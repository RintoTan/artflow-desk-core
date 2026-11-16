> **归档说明（技术实验，非正式功能验收）**
>
> 本文档来自 ArtFlow miniDesk 的独立技术实验阶段（TV-01～TV-03.5），复制归档于此。
>
> - 结论仅对**当时的实验工程**成立，不是正式业务功能的验收结果。
> - 全部实验只在 macOS 上执行；**不代表 Windows 实机验证通过**。
> - 实验中的数据库、沙箱与测试数据均未迁入正式工程。
> - 正式实现以 `src-tauri/` 当前代码与 DEV 阶段报告为准。

---

# TV-03.5 结项复核与收尾验证报告

- 执行日期：2026-11-16
- 工程：`/Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk-tv01`
- 范围：跨进程独占锁、缩略图重建、generation 清理、真实 ZIP 重复条目、命令白名单
- 性质：独立实验定向补强，未进入 TV-04

---

## 1. 执行摘要

TV-03 结项复核未发现代码与报告的重大不一致；TV-03.5 五项遗留风险全部落地并有真实执行证据。

| 项 | 结果 |
|---|---|
| TV-03.5 新增测试 | **23 passed / 0 failed** |
| 全量 Rust 测试 | **60 passed / 0 failed**（1 单元 + 13 TV-01 + 23 TV-03 + 23 TV-03.5） |
| TypeScript / Vite | 通过 |
| 真实 Tauri 启动 | 通过（应用取得数据目录锁并正常开窗） |
| 阻塞 | 无 |

复核中确认的**真实缺陷**（本轮已修）：恢复后从不重建缩略图；跨进程无任何锁；ZIP 重复条目只查 manifest；命令检查是数量断言。

---

## 2. 实际环境

| 项 | 值 |
|---|---|
| macOS / 架构 | 27.0.1 / arm64 |
| Rust / Cargo | 1.100.0 / 1.100.0 |
| Tauri | crate 2.12.5，CLI 2.12.4 |
| SQLite（rusqlite bundled） | 3.54.1 |
| 新增依赖 | `fs2 0.4.3`（跨平台文件锁，`try_lock_exclusive`） |

`fs2` 直接映射到 `flock(2)` / `LockFileEx`，属于操作系统级锁：进程退出（含 `abort`）由内核释放，不依赖清理逻辑。没有自行实现 PID 或时间戳锁。

---

## 3. 工程变更

新增：

- `src-tauri/src/bin/tv035_probe.rs`（锁与清理的子进程探针：`hold` / `hold-crash` / `try` / `race` / `gc-crash`）
- `src-tauri/tests/tv035.rs`（23 个测试 + 手写 ZIP 构造器）
- `TV035-RESULTS.md`

修改：

- `src-tauri/src/tv03.rs`
  - `Sandbox` 增加 `_dir_lock: File`，`create()` 先规范化路径再取锁，之后才建库
  - 新增 `central_directory_names()`（直接解析中央目录，绕开按名去重的解析器）
  - 新增 `rebuild_thumbnails()` / 缩略图原子写入
  - 新增 `plan_cleanup()` / `apply_cleanup()` / `apply_cleanup_with_fault()`
  - `RestoreReport` 增加 `thumbsRebuilt` / `thumbsFailed`；恢复末尾触发缩略图重建
  - ZIP 拒绝规则增加：仅允许 ASCII 路径、大小写冲突检测、条目数/中央目录一致性
- `src-tauri/src/lib.rs`：新增 `tv03_rebuild_thumbs`、`tv03_cleanup_plan`（**仅 dry-run**）
- `src-tauri/Cargo.toml`：`fs2`、`tv035-probe` bin

未修改：TV-01/TV-02 的业务逻辑、`migrations.rs`、`orders.rs`、前端页面与样式。

---

## 4. 隔离核验

| 对象 | 实验前 | 实验后 |
|---|---|---|
| ArtFlowDesk | `work/u8-restart-prototypes` / `c5e67f0…` / 0 行 | 同分支 / 同 HEAD / 0 行 |
| TV-01 数据库 | `ok` / 1 单 / 5 条历史 | `ok` / 1 单 / 5 条历史 |
| TV-03 演示沙箱 | 2 代 / 1 备份 / 无状态文件 | 2 代 / 1 备份 / 无状态文件 |

TV-03.5 的所有破坏性测试都在 `tempfile::tempdir()` 生成的独立目录中执行，测试结束由 `TempDir` 回收；未指向用户目录、TV-01 库或 TV-03 演示沙箱。

**一处说明**：应用启动时会在 TV-03 演示沙箱根目录创建 `.write.lock`（0 字节锁文件）。这是新增文件，不影响 `active.json`、`generations`、`backups`、`recovery` 的原有内容。

---

## 5. 跨进程锁

**机制**：`root/.write.lock` + `fs2::FileExt::try_lock_exclusive`，`Sandbox` 持有该 `File` 直到 drop。锁文件位于数据根目录，不随 generation 变化。

**顺序**：`create()` → 建根目录 → `canonicalize` → 取锁 → 建子目录 → 初始化/打开数据库。**先取锁再碰数据库**。

**别名处理**：`canonicalize` 后所有符号链接别名映射到同一真实路径与同一锁文件。

实测（全部为真实子进程，非线程模拟）：

| 编号 | 场景 | 证据 | 结果 |
|---|---|---|---|
| TV035-01 | 单进程取得锁 | 锁文件存在，drop 后可重新取得 | PASS |
| TV035-02 | 第二进程同目录 | 子进程输出 `BUSY …`，退出码 **3**；数据计数不变 | PASS |
| TV035-03 | 正常退出后释放 | 子进程输出 `ACQUIRED`，退出码 0 | PASS |
| TV035-04 | `abort` 后释放 | `hold-crash` 打印 `LOCKED <pid>` 后异常退出；随后 `try` 得到 `ACQUIRED` | PASS |
| TV035-05 | 双进程竞争 | 两个 `race` 进程并发，`ACQUIRED` 计数 = **1** | PASS |
| TV035-06 | 不同根目录 | 两个沙箱各自可写 | PASS |
| TV035-07 | 符号链接别名 | 通过别名 `try` 仍返回 `BUSY`（退出码 3） | PASS |

进程内 `Mutex` 仍然保留，但它只负责同一进程内的备份/恢复/清理互斥；跨进程安全由文件锁保证，两者不互相冒充。

---

## 6. 缩略图重建

- **触发**：`restore()` 在切换、复核通过、清理状态之后调用 `rebuild_thumbnails()`；也可通过命令手动触发。
- **范围**：只针对当前活动 generation 的 `attachments` 行；不跨代引用。
- **尺寸**：最长边 480px，WebP，原图不修改。
- **原子性**：先写 `.thumb-<uuid>.tmp` 再 `rename`，中断不会留下半张图。
- **幂等**：已有且可解码、尺寸合规的缩略图跳过。
- **失败**：只累加 `failed`，不删原图、不改数据库。

实测：

| 编号 | 场景 | 结果 |
|---|---|---|
| TV035-08 | 恢复后重建 | `thumbsRebuilt >= 2`、`thumbsFailed = 0`，每张附件都有缩略图 | PASS |
| TV035-09 | 幂等与修复 | 第二次 `rebuilt=0 / skipped=总数`；删一张只补 1 张；写入坏图被识别并重建 1 张 | PASS |
| TV035-10 | 缩略图目录只读 | `failed > 0`，订单/历史/附件计数不变，原图 SHA-256 全部不变 | PASS |
| TV035-11 | 6000×4000 大图 | 缩略图 ≤480×480 | PASS |
| — | 中断后继续 | 未做真实进程中断（见风险），但「删掉缓存后重启重建」等价路径已通过 TV035-09 | PARTIAL |

---

## 7. generation 清理

**保护规则**（`plan_cleanup`）：

1. `active.json` 指向的活动代 —— 永远保留。
2. `recovery/state.json` 存在时，`previous` 与 `target` 全部保留，并直接标记 `blockedReason`，不产出候选。
3. 无未完成恢复时，保留**最近一个通过完整性校验**的旧代作为最后回退。
4. 缺 `database.sqlite` 的目录视为残留候选；有库但校验失败的目录归入 `unknown`，**拒绝删除**。
5. 符号链接/非目录条目归入 `unknown`，不删除。
6. 无法读取 `active.json` → 直接报错，不产出任何候选。

**执行**（`apply_cleanup`）重新计算计划，再逐项复核「是普通目录、父目录确为 `generations`」，然后 `remove_dir_all`。删除前会再次 `validate_generation(active)`。

| 编号 | 场景 | 结果 |
|---|---|---|
| TV035-12 | 只有 1 代 / 只剩活动+回退 | 候选为空 | PASS |
| TV035-13 | 多代 dry-run 与执行 | dry-run 不删；执行删除全部候选；活动数据与计数不变；再次执行 `removed=0` | PASS |
| TV035-14 | 恢复状态未完成 | `blockedReason` 有值、候选为空、实际未删 | PASS |
| TV035-15 | 符号链接 + 指针损坏 | 链接归入 unknown 不删；指针损坏时 `plan` 报错 | PASS |
| TV035-16 | 清理后回退可用 | 保留代 ≥2，仍可用原备份恢复 | PASS |
| TV035-17 | 与其它操作互斥 | 持锁时 `BUSY`，释放后成功 | PASS |
| TV035-18 | 清理进程 abort | 子进程删除首个候选后 abort；重启可重新取锁、数据完整、再次清理成功 | PASS |

**保留策略的边界**：本轮以「活动代 + 最近可用旧代」为保留单位，**不**以回退 ZIP 作为判断依据（ZIP 由恢复流程单独保留在 `recovery/`）。因此「回退 ZIP 损坏时不应计为可靠副本」这一条**不适用于当前策略**，标记为 N/A 而非通过。

---

## 8. 真实 ZIP 重复条目

**构造方式**：测试内手写 stored-ZIP（本地头 + 中央目录 + EOCD），显式写入两个同名条目。`zip` 写入库会拒绝同名，因此不能用它生成。

**关键证据**：解析器按名称去重，`ZipArchive` 只看得到 4 条，而中央目录实际有 5 条：

```
raw = central_directory_names(dup)  -> 5 条，其中 "database.sqlite" 出现 2 次
zip::ZipArchive::len()              -> 4 条
```

因此校验层改为**直接解析中央目录**，不再依赖 `ZipArchive::len()`/`by_name` 判断重复。

| 编号 | 场景 | 结果 |
|---|---|---|
| TV035-19 D1/D3 | 重复 `database.sqlite`（同内容） | `ZIP` 拒绝（"重复路径"），计数与活动代不变 | PASS |
| D2 | 重复同名、内容不同 | `ZIP` 拒绝 | PASS |
| D4 | 重复某张原图 | `ZIP` 拒绝 | PASS |
| D5 | 仅顺序颠倒（无重复） | 正常恢复 | PASS |
| TV035-20 D6 | 仅大小写不同（`DATABASE.SQLITE`） | `ZIP` 拒绝（"大小写"），数据不变 | PASS |
| D7 | Unicode 形近名（`é`） | `ZIP` 拒绝（非 ASCII 路径规则） | PASS |
| D8 | 反斜杠 / 尾随空格 | `ZIP` 拒绝 | PASS |
| D9 | 重复条目 + 看似合法的 manifest | `ZIP` 拒绝 | PASS |
| D10 | 拒绝后数据完整 | 订单/历史/附件计数与活动代均不变 | PASS |

**格式约束**：本格式的 ZIP 内路径只允许 ASCII（`database.sqlite`、`attachments/originals/{uuid}.ext`、`manifest.json`），中文名只存在于数据库 `original_name` 字段。这是本轮新增的显式规则，用于消除 Unicode 规范化绕过。

---

## 9. Tauri 命令安全白名单

**真实注册列表**（`lib.rs` 的 `generate_handler!`，共 18 个）：

| 命令 | 用途 | 写库 | 读文件 | 写文件 | 删文件 | 备份/恢复 | 仅实验 |
|---|---|---|---|---|---|---|---|
| `ping` | 连通性 | 否 | 否 | 否 | 否 | 否 | 否 |
| `log_event` | 前端日志回传 | 否 | 否 | 否 | 否 | 否 | 是 |
| `app_info` | 读取数据库状态 | 否 | 是（DB） | 否 | 否 | 否 | 否 |
| `list_orders` | 订单列表 | 否 | 是（DB） | 否 | 否 | 否 | 否 |
| `load_progress` | 历史列表 | 否 | 是（DB） | 否 | 否 | 否 | 否 |
| `create_order` | 建单 | 是 | 否 | 否 | 否 | 否 | 否 |
| `edit_order` | 改标题 | 是 | 否 | 否 | 否 | 否 | 否 |
| `move_stage` | 推进/返工 | 是 | 否 | 否 | 否 | 否 | 否 |
| `set_order_status` | 终态 | 是 | 否 | 否 | 否 | 否 | 否 |
| `tv03_info` | 沙箱状态 | 否 | 是 | 否 | 否 | 否 | 是 |
| `tv03_demo` | 一键演示 | 是 | 是 | 是 | 是（沙箱内） | 是 | 是 |
| `tv03_list` | 附件列表 | 否 | 是（DB） | 否 | 否 | 否 | 是 |
| `tv03_import` | 导入图片 | 是 | 是（指定文件） | 是（沙箱内） | 否 | 否 | 是 |
| `tv03_backup` | 生成备份 | 否 | 是 | 是（沙箱 backups） | 否 | 是 | 是 |
| `tv03_restore` | 恢复 | 是 | 是（仅沙箱 backups） | 是 | 是（旧代） | 是 | 是 |
| `tv03_backups` | 备份列表 | 否 | 是（目录） | 否 | 否 | 否 | 是 |
| `tv03_rebuild_thumbs` | 重建缩略图 | 是（thumb 路径） | 是 | 是（thumbs） | 否 | 否 | 是 |
| `tv03_cleanup_plan` | 清理 dry-run | 否 | 是 | 否 | 否 | 否 | 是 |

**校验方式**：测试读取 `lib.rs` 源码，解析 `generate_handler![…]` 得到集合，与测试文件内**独立维护的 18 项常量**比较；不匹配即失败（列出未知与缺失）。清理的**真实删除**没有暴露给前端，只暴露 dry-run。

| 编号 | 检查 | 结果 |
|---|---|---|
| TV035-21 | 注册命令 == 批准清单；负向样本 `evil_exec_sql` 必须失败；`lib.rs` 不得含 `execute_sql`/`execute_batch`/`query_row`/`prepare(`/`Command::new` | PASS |
| TV035-22 | capabilities 精确等于 4 项（`core:default`、`core:window:allow-close`、`core:window:allow-destroy`、`dialog:default`），且不含 `fs:`/`sql:`/`shell:`/`http:`/`process:` | PASS |
| E12 | 故障注入入口不可被前端调用 | PASS（`Fault` 只存在于 Rust API；命令固定传 `Fault::None`，且 `inject_failure`/`apply_cleanup_with_fault` 未注册为命令） |
| E10 | 清理不能绕过沙箱与锁 | PASS（清理是 `Sandbox` 方法，持锁；UI 只有 dry-run） |

---

## 10. TV035-01 ～ TV035-21 测试矩阵

`cargo test --test tv035`：**23 passed / 0 failed / 8.54s**（编号多于矩阵项，因为部分项拆成多个子测试）。

| 编号 | 对应测试 | 结果 |
|---|---|---|
| TV035-01 | `tv035_01_lock_acquire_and_release` | PASS |
| TV035-02 | `tv035_02_second_process_is_rejected` | PASS |
| TV035-03 | `tv035_03_normal_exit_releases_lock` | PASS |
| TV035-04 | `tv035_04_abort_releases_lock` | PASS |
| TV035-05 | `tv035_05_exactly_one_of_two_racers_wins` + `_06_different_roots` + `_07_symlink_alias` | PASS |
| TV035-06 | `tv035_08_restore_rebuilds_thumbnails` | PASS |
| TV035-07 | `tv035_09_rebuild_is_idempotent_and_repairs` | PASS |
| TV035-08 | `tv035_10_thumbnail_failure_keeps_originals` + `_11_big_image` | PASS（真实中断为 PARTIAL，见第 6 节） |
| TV035-09 | `tv035_12` + `tv035_13`（dry-run 与执行） | PASS |
| TV035-10 | `tv035_14`（恢复中保护）+ `tv035_15`（指针损坏） | PASS |
| TV035-11 | `tv035_17`（互斥）+ 异常路径 | PASS |
| TV035-12 | `tv035_18`（清理进程 abort） | PASS |
| TV035-13 | `tv035_16`（清理后回退可恢复） | PASS |
| TV035-14 | `tv035_19`（D1–D5） | PASS |
| TV035-15 | `tv035_20`（D6–D8） | PASS |
| TV035-16 | `tv035_19/20` 的「数据不变」断言 | PASS |
| TV035-17 | `tv035_21` | PASS |
| TV035-18 | `tv035_21` 负向样本 | PASS |
| TV035-19 | `tv035_22` | PASS |
| TV035-20 | `tv035_23` + 全量 `cargo test` | PASS |
| TV035-21 | 第 4 节隔离核验（真实路径与计数） | PASS |

**C11（回退 ZIP 损坏不计为可靠副本）**：N/A —— 当前保留策略以 generation 为单位，不以 ZIP 为判断依据，已在第 7 节说明。

---

## 11. 真实进程崩溃测试

| 场景 | 进程 | 注入点 | 退出 | 重启后 |
|---|---|---|---|---|
| 锁持有者崩溃 | `tv035-probe hold-crash <dir>` | 取得锁后 `std::process::abort()` | 非 0（SIGABRT） | 锁由内核释放，`try` 子进程 `ACQUIRED`；数据计数不变 |
| 清理进程崩溃 | `tv035-probe gc-crash <dir>` | 删除第一个候选后 `abort()` | 非 0 | 重新取锁成功；活动数据完整（订单 > 0）；`recover_on_start` 报告「完整」；再次清理成功 |

两次都是独立子进程，没有终止正式应用，也没有把「返回 Err 的回滚」当作崩溃证据。

---

## 12. 回归结果

| 项 | 数量 / 结果 |
|---|---|
| TV-03.5 新增测试 | 23 |
| TV-03 原有测试 | 23 |
| TV-01 domain 测试 | 13 |
| 单元测试 | 1 |
| **`cargo test` 合计** | **60 passed / 0 failed** |
| `tsc --noEmit` | 通过 |
| `vite build` | 通过（368.14 kB JS / 115.91 kB gzip，101ms） |
| 真实 Tauri 启动 | 通过：`[tv03] sandbox ready … generation=gen-4f98…`，锁文件已创建，窗口正常 |

---

## 13. 剩余风险

### 已解决

1. 跨进程同目录写入 → 操作系统级文件锁 + 别名规范化。
2. 恢复后无缩略图 → 自动重建，失败不影响数据。
3. 旧 generation 无限增长 → 受保护的 dry-run + 执行。
4. ZIP 同名条目可绕过 → 中央目录层检测（解析器会去重）。
5. 命令数量断言 → 显式 18 项白名单 + 负向样本。

### 已验证但仍需正式版适配

1. 备份期间持锁时间随图片数量线性增长，正式版需要「只读附件快照」缩短临界区。
2. 保留策略是实验值（活动代 + 最近一个有效旧代），不是产品规则。
3. `.write.lock` 位于数据根目录，正式版需要与单实例插件配合，避免用户困惑于「被占用」提示。
4. 恢复后缩略图重建是同步的，图片很多时应改为后台队列。
5. `tv03-crash` / `tv035-probe` 仍会随 `target/release` 打包，正式包需排除（本轮未构建安装包，未验证）。

### 尚未测试

1. 缩略图重建过程中真实进程中断（当前以「删缓存后重建」等价验证）。
2. Unicode 规范化等价路径（已用「仅允许 ASCII」策略规避，未做 NFC/NFD 双向测试）。
3. 大量图片（>200 张）下的备份耗时与内存。
4. 两个应用实例通过不同挂载点（如外接盘符号链接）访问同一数据根。

### TV-04 范围

Windows 构建、WebView2 离线安装、双平台文件路径差异、安装包签名。

---

## 14. 最终判断

| # | 问题 | 结论 |
|---|---|---|
| 1 | 两个进程能否同时写同一数据目录 | **不能**。第二进程 `BUSY` 退出码 3；竞争时恰好一个成功 |
| 2 | abort 后锁能否正常释放 | **能**，由内核释放，重启即可再取得 |
| 3 | 恢复后缩略图能否安全重建 | **能**，且只针对活动代 |
| 4 | 缩略图失败是否影响原图 | **不影响**，哈希与计数不变 |
| 5 | 能否安全识别旧 generation | **能**，含未知/符号链接拒绝策略 |
| 6 | 清理是否保留完整有效回退 | **是**，至少保留一个通过校验的旧代 |
| 7 | 清理中断后能否继续恢复 | **能**，活动数据完整，可重复清理 |
| 8 | 真正重复 ZIP entries 是否被拒绝 | **是**，且已证明解析器会隐藏重复、必须查中央目录 |
| 9 | ZIP 拒绝后数据是否完整 | **是** |
| 10 | 是否建立显式命令白名单 | **是**，18 项独立清单 |
| 11 | 新增未知命令是否触发失败 | **是**（负向样本验证） |
| 12 | 是否存在不受控 SQL/文件/删除/shell 入口 | **未发现**；清理删除未暴露给前端 |
| 13 | TV-01 数据库是否不变 | **是**（ok / 1 单 / 5 条） |
| 14 | TV-03 演示沙箱是否完整 | **是**（2 代 / 1 备份 / 无状态文件，仅新增锁文件） |
| 15 | ArtFlowDesk 是否原样 | **是**（`c5e67f0`，0 行改动） |
| 16 | 是否发现阻塞性技术问题 | **无** |
| 17 | TV-03.5 是否完成全部关键验收 | **是**，其中 C11 为 N/A（策略不适用），缩略图真实中断为 PARTIAL |
| 18 | 是否建议进入 TV-04 | **建议**，但先补：正式包排除测试二进制、缩略图重建改为后台、保留策略产品化 |

未把「编译通过」或「返回 Err」当作功能通过：上表每项都能对应到具体测试名、子进程输出或日志行。
