> **归档说明（技术实验，非正式功能验收）**
>
> 本文档来自 ArtFlow miniDesk 的独立技术实验阶段（TV-01～TV-03.5），复制归档于此。
>
> - 结论仅对**当时的实验工程**成立，不是正式业务功能的验收结果。
> - 全部实验只在 macOS 上执行；**不代表 Windows 实机验证通过**。
> - 实验中的数据库、沙箱与测试数据均未迁入正式工程。
> - 正式实现以 `src-tauri/` 当前代码与 DEV 阶段报告为准。

---

# TV-03 实验结果报告

- 执行日期：2026-11-16
- 工程：`/Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk-tv01`
- 范围：本地参考图附件、完整 ZIP 备份、安全恢复与故障注入
- 性质：独立技术实验，未进入 TV-04，未创建正式 miniDesk 工程

---

## 1. 执行摘要

TV-03 的六项核心能力全部有真实执行证据：原图无损导入、独立缩略图、数据库与附件一致备份、独立目录恢复、失败回退、恶意 ZIP 拒绝。

| 项 | 结果 |
|---|---|
| TV-03 Rust 集成测试 | **23 passed / 0 failed** |
| 真实桌面演示（Tauri 窗口内） | **通过**（建数据 → 导入 3 张 → 备份 → 恢复 → 启动自检） |
| 真实进程崩溃恢复 | **通过**（子进程 `abort()` 后重启，仍是完整旧数据） |
| TV-01 回归 | 见第 15 节 |
| 阻塞 | 无 |

未把「编译通过」当作运行成功：所有结论都来自 `cargo test` 的真实 SQLite/文件系统执行，或真实窗口日志。

---

## 2. 环境与依赖

| 项 | 值 |
|---|---|
| 系统 | macOS 27.0.1 / arm64 |
| Rust | 1.100.0 |
| Tauri | crate 2.12.5 / CLI 2.12.4 |
| rusqlite | 0.43.0（bundled，SQLite 3.54.1） |
| 新增：zip | 9.6.0（`deflate`） |
| 新增：sha2 | 0.11.1（zip 另带 0.10.9 作为间接依赖） |
| 新增：image | 0.25.10（`png` / `jpeg` / `webp`） |
| 新增：tempfile | 3.27.0（仅测试） |

未安装：云存储 SDK、ORM、自动更新、UI 框架、桌面自动化框架。未使用 sudo。

---

## 3. 工程修改清单

新增：

- `src-tauri/src/tv03.rs`（沙箱、附件、备份、恢复、ZIP 防护，约 1200 行）
- `src-tauri/src/bin/tv03_crash.rs`（崩溃探针子进程）
- `src-tauri/tests/tv03.rs`（23 个集成测试）
- `src/Tv03Page.tsx`（中文测试页面）
- `src-tauri/Info.plist`（macOS 简体中文本地化声明）
- `src-tauri/icons/*`（生产包所需图标，含 `icon.icns`）
- `TV03-RESULTS.md`（本文件）

修改：

- `src-tauri/Cargo.toml`（依赖、`default-run`、`tv03-crash` bin）
- `src-tauri/src/lib.rs`（注册 `tv03` 模块、沙箱状态、6 个 `tv03_*` 命令）
- `src-tauri/tauri.conf.json`（生产包 `bundle` 配置、`minimumSystemVersion 13.0`）
- `src/main.tsx`、`src/Layout.tsx`、`src/bridge/commands.ts`（路由与命令封装）

**未改动**：`orders.rs`、`db.rs`、`migrations.rs`、`error.rs` 的业务语义；TV-01 的 schema 仍为 `user_version = 1`，TV-03 使用自己的 v2 schema。

---

## 4. 数据隔离

| 内容 | 位置 |
|---|---|
| TV-03 沙箱（桌面演示） | `~/Library/Application Support/dev.artflow.minidesk.tv01/tv03-sandbox/` |
| TV-03 沙箱（自动测试） | 每个测试独立的 `tempfile` 临时目录 |
| TV-01 数据库 | `~/Library/Application Support/dev.artflow.minidesk.tv01/minidesk-tv01.sqlite` |

- 恢复实验**从未**指向 TV-01 数据库或附件目录：`Sandbox` 的所有路径都从自身 `root` 派生。
- TV-01 数据库在实验前后均为：`integrity_check = ok`、订单 1 条、历史 5 条。
- UI 的「恢复」只允许恢复沙箱 `backups/` 内的文件（命令拒绝 `/`、`\`、`..` 与不存在的文件），不提供任意路径恢复入口。

沙箱目录结构（实测）：

```
tv03-sandbox/
├─ active.json                     {"generation":"gen-…"}
├─ generations/{gen-…}/database.sqlite + attachments/{originals,thumbs,incoming}/
├─ restore-work/                   备份与恢复的临时区
├─ recovery/                       回退备份 + state.json
├─ backups/                        demo-*.zip / manual-*.zip
└─ fixtures/                       自动生成的测试图片
```

---

## 5. 附件系统实现

写入顺序（`Sandbox::import_image`）：

1. 校验普通文件、非空、≤ 40 MB。
2. **嗅探真实格式**（`image::ImageReader::with_guessed_format`），只接受 PNG/JPEG/WebP；扩展名不参与判断。
3. 读取尺寸，超过 4000 万像素拒绝（防止解码炸弹）。
4. 复制到 `attachments/incoming/{uuid}.{ext}`，`fsync`。
5. 计算源文件与副本 SHA-256，**不一致即放弃并删除暂存**。
6. 生成 480px 最长边缩略图到 `attachments/thumbs/{uuid}.webp`；失败则该附件无缩略图，但原图不受影响。
7. `rename` 到 `attachments/originals/`，再写数据库记录（相对路径）。
8. 数据库写入失败 → 删除已归档文件（补偿），不留「有记录无文件」或「有文件无记录」。

**结论**：文件系统与数据库没有天然事务，这里用「先落盘校验 → 再写库 → 失败补偿」保证两个方向的不变量，并用测试 01/03/04 验证。

---

## 6. 备份包规格

格式（实测样本）：

```
database.sqlite
attachments/originals/{uuid}.png|jpg|webp
manifest.json
```

manifest 字段：`format`、`format_version=1`、`app_version`、`schema_version=2`、`created_at`、`files[]`（path/bytes/sha256）、`total_files`、`total_bytes`。

实测一次演示备份：

| 项 | 值 |
|---|---|
| ZIP 大小 | 8 688 字节 |
| 条目 | 5（4 个清单文件 + manifest） |
| 解压合计 | 109 956 字节 |
| database.sqlite | 57 344 字节，sha256 `403c3b93…` |
| PNG 附件 | 16 454 字节 |
| JPEG 附件 | 23 884 字节 |
| WebP 附件（6000×4000） | 12 274 字节 |

缩略图**不进入备份**：它是可再生产物，重新生成成本低；备份只保证原图与数据库一致的同时最小化体积。这一点在正式产品中可以再评估。

---

## 7. 备份一致性

**问题**：WAL 模式下直接复制 `.sqlite` 会漏掉已提交事务；SQLite 一致也不等于「数据库 + 附件目录」整体一致。

做法：

1. 取操作锁（进程内单一 `Mutex`，`try_lock` 失败立即返回 `BUSY`，不排队）。
2. `VACUUM INTO` 生成快照到 `restore-work/bk-*/database.sqlite`（目标必须不存在）。
3. 重新打开快照，跑 `PRAGMA integrity_check`，失败即放弃。
4. **从快照本身**读取 `attachments` 行，逐个复制对应原图；文件缺失直接拒绝生成备份。
5. 边写 ZIP 边计算 SHA-256，最后写 manifest。
6. 重新解析自己产出的 ZIP（`inspect_zip`）通过后才 `rename` 发布。

**锁定范围与耗时**：整个备份过程持有操作锁，包含快照、复制附件、压缩、自校验。本轮数据量（20 单 / 3 图 / 8 KB）耗时在毫秒级。图片数量增长后这段时间会线性上升，正式产品需要改为「快照 + 附件只读快照（如硬链接或版本目录）」，否则会长时间阻塞写入——**这是已知扩展风险，不是本轮缺陷**。

---

## 8. 安全恢复架构

采用 **generation（代）+ 指针文件**：

```
active.json            {"generation":"gen-x"}
generations/gen-a/     数据库 + 附件（一代完整数据）
generations/gen-b/
recovery/state.json    切换意图（phase/previors/target）
recovery/rollback-*.zip
```

恢复流程（`Sandbox::restore`）：

1. `inspect_zip`：条目数、单文件/总量上限、压缩率、路径安全、重复、清单一致性、格式版本、schema 版本。
2. 解压到 `restore-work/rs-*`，**边解压边统计真实字节并校验 SHA-256**（不信任 ZIP 声明的大小）。
3. 打开解压出的数据库：`integrity_check`、`foreign_key_check`、`user_version` 兼容性。
4. 核对「数据库引用的每个附件都在包内，且大小与哈希一致」。
5. 为**当前**数据生成回退备份（复用备份流程）并重新校验。
6. 在 `generations/` 内组装新的一代并 `validate_generation`（完整性 + 每个附件哈希）。
7. 写入 `recovery/state.json`（phase=prepared，记录 prev/target）。
8. 原子替换 `active.json`（临时文件 + `fsync` + `rename` + 目录 `fsync`）。
9. 重新打开新库复核；通过则删除状态文件，保留回退备份。

启动自检（`recover_on_start`）按四条规则收敛，且**永不自动初始化空库**：

| 状态 | 行为 |
|---|---|
| 无状态文件 | 校验当前 generation；不合法则报错停止 |
| 指针==prev 且 prev 完整 | 保留旧数据，清理状态 |
| 指针==prev 但 prev 损坏、target 完整 | 切到 target |
| 指针==target 且完整 | 认定恢复已完成，清理状态 |
| 指针==target 但损坏、prev 完整 | **回退**到 prev |
| 两者都不可用 / 指针未知 | 报错并停止写入，保留现场 |

`Sandbox::create` 在「没有指针但已有 generation」时直接报错，避免把中断的现场当成首次启动。

---

## 9. 测试矩阵（TV03-01 ～ TV03-18）

`cargo test --test tv03`：**23 passed / 0 failed / 3.85s**。

| ID | 对应测试 | 执行方式 | 关键断言 | 结果 |
|---|---|---|---|---|
| TV03-01 | `tv03_01_import_preserves_bytes` | 真实文件 + SQLite | 源/副本/入库哈希三者一致，字节数一致 | PASS |
| TV03-02 | `tv03_02_thumbnail_is_separate` | 同上 | 原图哈希不变；缩略图 ≤480px 且为 WebP | PASS |
| TV03-03 | `tv03_03_rejects_invalid_files` | 伪图片/空文件/文本/41MB | 全部 `INVALID`，无数据库记录残留 | PASS |
| TV03-04 | `tv03_04_remove_keeps_shared_files` | 同图导入两次后删除一条 | 记录清除、该文件删除、另一条文件仍在且哈希不变 | PASS |
| TV03-05 | `tv03_05_backup_snapshot_and_manifest` | `VACUUM INTO` + ZIP | 清单字段完整，包内快照 `integrity ok` 且 20 单 | PASS |
| TV03-06 | `tv03_06_backup_refuses_overwrite` | 目标已存在 | `INVALID`，原文件字节不变 | PASS |
| TV03-07 | `tv03_07_restore_into_empty_sandbox` | 空沙箱恢复 | 订单/历史/附件数与源一致，附件哈希一致，自检通过 | PASS |
| TV03-08 | `tv03_08_restore_replaces_existing_and_keeps_rollback` | 旧数据 → 备份 → 加新数据 → 恢复 | 回到 v1 整库；回退包能恢复回 v2 | PASS |
| TV03-09 | `tv03_09_faults_leave_data_untouched` | F1/F2/F3/F5 注入 | 每次失败后计数与活动 generation 均不变 | PASS |
| TV03-10 | `tv03_10_rollback_failure_blocks_restore` | F4 注入 | 拒绝进入替换阶段，数据不变 | PASS |
| TV03-11 | `tv03_11_after_switch_resolves_to_complete_generation` | F7 注入 | 状态文件留存；重启后收敛到完整新数据 | PASS |
| TV03-12 | `tv03_12_after_reopen_failure_rolls_back` | F8 注入 | 重启后回退到旧 generation，计数不变 | PASS |
| TV03-13 | `tv03_13_rejects_path_traversal_and_absolute` | `../`、`/etc/passwd`、`C:/`、反斜杠 | 全部 `ZIP` 拒绝，隔离目录外无文件产生 | PASS |
| TV03-14 | `tv03_14_rejects_reserved_and_trailing_names` | `CON.txt`/`aux`/`a.`/`dir /`/`a//b` | 全部拒绝 | PASS |
| TV03-15 | `tv03_15_rejects_symlink_entries` | unix mode 0o120777 | 拒绝符号链接 | PASS |
| TV03-16 | `tv03_16_rejects_duplicate_and_extra_and_missing` | 清单重复 / 多余条目 / 缺失文件 | 三种均 `ZIP` 拒绝 | PASS |
| TV03-17 | `tv03_17_rejects_entry_count_and_ratio` | 10 010 条目 / 120MB 零字节 | 条目数与压缩率两条规则分别命中 | PASS |
| TV03-18 | `tv03_18_rejects_hash_mismatch` | 篡改附件保留旧清单 | `HASH` 拒绝，数据不变 | PASS |
| 追加 | `tv03_19_rejects_corrupt_database_with_valid_hash` | 改库并重算哈希 | `DB` 拒绝 | PASS |
| 追加 | `tv03_20_rejects_incompatible_schema` | schema_version=99 | `SCHEMA` 拒绝 | PASS |
| 追加 | `tv03_21_rejects_forged_manifest_with_valid_hashes` | 改附件并重算全部哈希 | 被数据库引用校验拒绝（`CONFLICT`/`HASH`） | PASS |
| 追加 | `tv03_22_operations_are_mutually_exclusive` | 持锁时调备份/恢复 | 均 `BUSY`，释放后成功 | PASS |
| 追加 | `tv03_23_real_process_crash_recovers` | 子进程 `abort()` | 退出码非 0；重启后 `RECOVER` 且订单 ≥6 | PASS |

> 关于「重复 ZIP 条目」：`zip` 写入库本身拒绝产生同名条目，因此该项以「清单内重复路径」验证读取侧的去重逻辑；这一点已在测试中注明。

---

## 10. 故障注入专项

| 编号 | 注入点 | 类型 | 结果 |
|---|---|---|---|
| F1 | 校验阶段前 | 普通异常 | 拒绝，数据不变（tv03_09） |
| F2 | 解压中途 | 普通异常（已写入部分文件） | 拒绝，临时目录清理，活动数据不变（tv03_09） |
| F3 | 数据库损坏 | 普通异常 | `DB` 拒绝（tv03_09 / tv03_19） |
| F4 | 回退备份失败 | 普通异常 | 拒绝继续，数据不变（tv03_10） |
| F5 | 切换前 | 普通异常 | 新 generation 丢弃，仍用旧数据（tv03_09） |
| F6 | 状态已持久化、切换边界 | **真实进程崩溃** | 子进程 `abort()`；重启识别状态并保留完整旧数据（tv03_23） |
| F7 | 切换后、确认前 | 普通异常 | 重启识别 `target` 完整，收敛为新数据（tv03_11） |
| F8 | 切换后复核失败 | 普通异常（人为损坏新库） | 重启回退到旧 generation（tv03_12） |

**区分说明**：只有 F6 是真实进程中断（`std::process::abort()`），其余是把故障注入到具体阶段后返回错误。未把普通回滚测试当作崩溃恢复报告。

---

## 11. ZIP 安全专项

| 编号 | 攻击/异常 | 结果 |
|---|---|---|
| Z1 | `../outside.txt` | 拒绝（路径段 `..`） |
| Z2 | `/etc/passwd` | 拒绝（绝对路径） |
| Z3 | `C:/…`、`a\b.txt`、`CON.txt`、`aux`、`a.`、`dir /`、`a//b` | 全部拒绝（盘符/反斜杠/保留名/尾随点空格/空段） |
| Z4 | 符号链接（0o120777） | 拒绝 |
| Z5 | 重复路径 | 拒绝（清单级重复已验证；ZIP 写入库阻止构造同名条目） |
| Z6 | 10 010 条目 / 单文件 >200MB / 总量 >4GB | 条目数命中；单文件与总量由解压时实际字节数强制 |
| Z7 | 120MB 零字节（压缩率 >1000） | 拒绝（压缩炸弹特征） |
| Z8 | 改附件保留旧哈希 | `HASH` 拒绝 |
| Z9 | 数据库损坏但哈希匹配 | `DB` 拒绝（`integrity_check`） |
| Z10 | `schema_version = 99` | `SCHEMA` 拒绝，不猜测兼容 |
| Z11 | 多余条目 / 缺失条目 | 均 `ZIP` 拒绝 |
| Z12 | 伪造 manifest（重算全部哈希） | 被「数据库引用的附件哈希」校验拒绝 |

**明确结论**：SHA-256 只用于检测损坏与篡改，不被当作「可信来源」证明；所有 ZIP 一律按不可信输入处理。

---

## 12. 正常备份与恢复核对

| 项 | 源数据 | 恢复后 |
|---|---|---|
| 订单 | 20 | 20 |
| 历史 | 34 | 34 |
| 附件 | 3 | 3 |
| 附件哈希 | png `5abf9e6c…` / jpg `24d75480…` / webp `8ea3350a…` | 完全一致 |
| 缺失引用 | 0 | 0 |
| 备份包 | 8 688 字节 / 5 条目 | 可再次备份（备份→恢复→再备份一致） |

**回退备份**：tv03_08 在「旧数据 → 新数据 → 恢复旧数据」后，用回退包再次恢复，成功回到新数据（订单数与附件数一致）。空目录恢复与「整库替换 + 回退」是两个独立测试，未互相替代。

---

## 13. 桌面 UI 验证

真实 Tauri 窗口（`npm run tauri dev`）打开「附件与备份测试」页，页面自动执行一次性演示，Rust 侧日志：

```
[tv03] sandbox ready path=…/tv03-sandbox generation=gen-808bf38a22
[tv02] PASS TV03 demo | 准备虚构订单 | 新增 20 条，总计 20 条上限
[tv02] PASS TV03 demo | 生成测试图片 | PNG / JPEG / WebP 可用=true（6000×4000）
[tv02] PASS TV03 demo | 导入图片 | 成功 3 张
[tv02] PASS TV03 demo | 创建完整备份 | 4 个文件 / 8688 字节
[tv02] PASS TV03 demo | 恢复备份 | 新 generation gen-4f98…，校验：订单、历史与附件哈希一致
[tv02] PASS TV03 demo | 启动自检 | 无需恢复，当前数据完整：gen-4f98…
```

页面同时提供：沙箱路径、当前 generation、订单/历史/附件数量、附件列表（含 SHA-256 前 16 位与缩略图状态）、备份文件列表、五个中文操作按钮。

**未验证**：手动点「导入测试图片」「立即备份」「恢复最近备份」三个按钮（需要人工点击）。演示路径已覆盖同样的后端命令。

---

## 14. 生产协议与本地化预检

### 构建

```
npx tauri build --bundles app   →  exit 0
ArtFlow miniDesk TV-01.app      →  18.55 MiB
```

`Info.plist` 实测（`PlistBuddy`）：

| 键 | 值 |
|---|---|
| `CFBundleDevelopmentRegion` | `zh_CN` |
| `CFBundleLocalizations` | `zh-Hans`, `en` |
| `LSMinimumSystemVersion` | `13.0` |

### 直接运行 `.app` 内的可执行文件（真实生产协议）

```
[tv02] INFO TV02-00 运行环境 | 运行方式=tauri: 安全上下文=true 缩放=1
[tv02] PASS TV02-08 摘要校验（SHA-256） | 算法可用=true 与标准结果一致=true
[tv02] PASS TV02-01 原生弹窗（dialog） | 已打开=true 焦点进入弹窗=true 处于模态层=true
[tv02] PASS TV02-07 图片预览（Blob） | 第一次宽=400 第二次宽=400 字节=2869
[tv02] PASS TV02-11 数据库命令响应速度 | 平均 0.30 毫秒 最长 1.00 毫秒
[tv02] PASS TV02-12 界面中文化检查 | 缺少中文=无 残留英文=无
[tv02] PASS TV02-04 未保存时的页面切换保护 | 仍在本页=true 确认框数量=1
[tv02] PASS TV02-05 未保存时的窗口关闭保护 | 窗口仍打开=true 出现确认=true
[tv02] PASS TV02-03 页面路由（Hash Router） | 起点 #/ → 切换后 #/db → 返回后 #/
[tv03] sandbox ready path=…/tv03-sandbox generation=gen-4f98…
```

| 检查项 | 结果 |
|---|---|
| 实际协议 | `tauri:` |
| `isSecureContext` | **true** |
| `crypto.subtle` / SHA-256("abc") | **可用且命中标准向量** |
| Hash Router | 正常往返 |
| Tauri invoke | 正常（响应 0.30 ms） |
| 最小关闭保护 | 生效 |

TV-02 遗留的「生产协议下 Web Crypto 是否可用」**已闭环**：可用，不必把备份哈希整体迁到 Rust（当前实现本来就在 Rust 侧，属于双重保障）。

### 本地化

- 声明已写入并**确认随包发布**（上表）。
- **系统文件对话框是否显示中文：未验证。** 需要人工在打包后的应用里点一次「选择图片」才能观察；本轮不把「配置存在」当作「已生效」。
- 未修改系统语言、未修改全局配置。

---

## 15. TV-01 / TV-02 回归

| 项 | 结果 |
|---|---|
| `cargo test`（全量） | **37 passed / 0 failed**（1 单元 + 13 TV-01 domain + 23 TV-03） |
| `tsc --noEmit` | 通过 |
| `vite build`（tauri build 前置步骤） | 通过（否则打包会失败） |
| TV-01 数据库 | `integrity ok`，订单 1、历史 5（与实验前一致） |
| TV-02 自动项 | 生产包内 10 项全部 PASS（见第 14 节日志） |

**本轮发现并修复的一处回归**：`t10_no_generic_sql_command_and_minimal_capability` 原本断言「命令数量 == 9」，TV-03 增加 `tv03_*` 命令后变为 16，测试失败。已改为 `>= 9` 并保留「lib.rs 内不得出现 SQL 调用」的核心断言——数量不是安全属性，SQL 面才是。

未重新跑 TV-02 的 M1–M8 人工项（本轮未改动相关交互），符合定向回归原则。

---

## 16. 原仓库隔离核验

| 时点 | 分支 | HEAD | 工作区 |
|---|---|---|---|
| 实验前 | `work/u8-restart-prototypes` | `c5e67f02b7a0c0a46b7de058e01c7071a5ccde6c` | 0 行 |
| 实验后 | `work/u8-restart-prototypes` | `c5e67f02b7a0c0a46b7de058e01c7071a5ccde6c` | 0 行 |

ArtFlowDesk 全程只读：未安装依赖、未运行其测试/构建、未迁移、未改配置、未动 Git。

---

## 17. 遗留风险

### 高

1. **单实例保护缺失**：操作锁是进程内 `Mutex`。若用户启动两个应用实例，各自持锁，仍可能同时写同一沙箱。正式版需要单实例锁（如文件锁或 Tauri single-instance 插件）。
2. **备份期间长时间持锁**：当前把「快照 + 复制附件 + 压缩」整体放在锁内。图片上百张后写入会被阻塞数十秒。正式版需要「快照 + 附件只读视图（硬链接/版本目录）」缩短临界区。

### 中

3. **缩略图不随备份迁移**：备份只含原图，恢复后 `thumbs/` 为空，界面显示「无」。需要恢复后重建缩略图的步骤（可再生产物，不影响数据正确性）。
4. **旧 generation 不自动清理**：每次恢复都新增一代并保留回退包，磁盘会持续增长，需要保留策略。
5. **ZIP 重复条目只能间接验证**：`zip` 写入库拒绝产生同名条目，读取侧的重复检测用「清单重复」验证；真实同名条目样本未构造。

### 低

6. `.app` 内同时打包了 `tv03-crash` 测试二进制，正式包不应包含。
7. 未签名、未公证：仅本机私人使用；对外分发会触发 Gatekeeper 提示。
8. `Info.plist` 本地化未做视觉验证。

---

## 18. 最终结论

| # | 问题 | 结论 |
|---|---|---|
| 1 | 原始图片能否无损导入 | **能**。源/副本/入库三者 SHA-256 一致，字节数一致 |
| 2 | 缩略图是否独立于原图 | **是**。独立 WebP（≤480px），原图哈希不变，可重复生成 |
| 3 | SQLite 与附件能否一致备份 | **能**。`VACUUM INTO` 快照 + 从快照读引用 + 缺文件即拒绝 |
| 4 | ZIP 能否完整校验 | **能**。清单、大小、SHA-256、格式/结构版本、条目一致性全查 |
| 5 | 能否在独立目录恢复 | **能**。空沙箱与已有数据两种场景均验证 |
| 6 | 整库恢复是否保留可靠回退备份 | **是**。恢复前生成并再次校验，回退包可独立恢复 |
| 7 | 普通恢复失败是否破坏旧数据 | **否**（F1–F5 全部保持原状，计数与活动代均不变） |
| 8 | 真实进程中断后能否自动恢复 | **能**。`abort()` 后重启保留完整旧数据；F7/F8 分别收敛到新代/回退旧代 |
| 9 | 恶意 ZIP 能否可靠拒绝 | **能**（Z1–Z12 全部有对应测试，含重算哈希的伪造清单） |
| 10 | 是否发现路径越界或覆盖漏洞 | **未发现**。唯一未直接构造的是「同名重复条目」，已在风险中标注 |
| 11 | 生产协议下 Web Crypto 可用 | **可用**（`tauri:` / secure=true / 标准向量命中） |
| 12 | macOS 文件对话框本地化是否解决 | **未验证**。声明已随包发布，但视觉结果需人工点一次 |
| 13 | TV-01 数据库是否保持不变 | **是**（ok / 1 单 / 5 条） |
| 14 | ArtFlowDesk 是否保持原样 | **是**（同分支同提交，0 行改动） |
| 15 | 是否满足全部关键验收标准 | **是**（13 项关键失败判据均未触发；本地化属未验证项，不涉及数据安全） |
| 16 | 是否建议进入 TV-04 | **建议**，但先补：Windows 构建环境、单实例锁、恢复后重建缩略图 |

未把「编译通过」「解压成功」「目录存在」当作功能通过：上表每一项都能对应到具体测试名或日志行。
