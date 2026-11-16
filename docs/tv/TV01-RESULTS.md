> **归档说明（技术实验，非正式功能验收）**
>
> 本文档来自 ArtFlow miniDesk 的独立技术实验阶段（TV-01～TV-03.5），复制归档于此。
>
> - 结论仅对**当时的实验工程**成立，不是正式业务功能的验收结果。
> - 全部实验只在 macOS 上执行；**不代表 Windows 实机验证通过**。
> - 实验中的数据库、沙箱与测试数据均未迁入正式工程。
> - 正式实现以 `src-tauri/` 当前代码与 DEV 阶段报告为准。

---

# TV-01 实验结果报告

- 任务：Tauri 2 + Rust + SQLite 独立技术实验
- 执行日期：2026-11-16
- 执行范围：独立实验工程 `/Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk-tv01`，未修改 ArtFlowDesk
- 结论：**完成，无阻塞**（T01–T09 通过，T10 为静态断言通过 + 人工核对）

---

## 1. 执行摘要

TV-01 已按授权完成，验证了 miniDesk 所依赖的四项技术基础：

1. Tauri 2 桌面应用可在本机 Apple Silicon 上编译并真实启动；
2. `rusqlite`（bundled）可作为唯一写入通道，前端不接触任何 SQL；
3. 订单与历史可在**同一事务**内原子写入，故障注入可证明完整回滚；
4. revision 冲突校验、终态锁、阶段前进/返工、迁移幂等、崩溃后持久化均通过真实执行验证。

| 项 | 结果 |
|---|---|
| 测试总数 | 14（1 单元 + 13 集成），**14 passed / 0 failed** |
| 桌面运行 | 通过（真实窗口 + invoke 全链路日志） |
| 崩溃恢复 | 通过（`abort()` 后 `integrity_check=ok`，未提交变更被丢弃） |
| 架构性问题 | 未发现 |

---

## 2. 实际环境

| 项 | 值 |
|---|---|
| 操作系统 | macOS 27.0.1（Build 26A434） |
| 架构 | arm64（Apple Silicon） |
| Xcode CLT | `/Library/Developer/CommandLineTools`，`CLTools_Executables 27.0.0.0` |
| Node | v22.23.2（满足 Vite 8 的 `^20.19 \|\| >=22.12`） |
| npm | 10.9.8 |
| rustc | 1.100.0 (0ef1bc386 2026-11-09) |
| cargo | 1.100.0 (3acc79c0c 2026-11-05) |
| rustup | 1.29.3 (edbc831ce 2026-11-02)，host `aarch64-apple-darwin` |
| Tauri CLI / API | 2.12.4 / 2.12.4 |
| tauri crate / tauri-build | 2.12.5 / 2.7.4 |
| rusqlite | 0.43.0（`bundled`） |
| **SQLite 实际版本** | **3.54.1**（来自运行时 `SELECT sqlite_version()`，非猜测） |
| React / Vite / TS | 19.3.1 / 8.3.5 / 7.0.2 |

`PRAGMA` 实测：`journal_mode=wal`、`synchronous=NORMAL`、`foreign_keys=1`、`busy_timeout=5000`、`user_version=1`。

SQLite 3.54.1 高于 WAL-reset 缺陷修复线（3.51.3），无需额外规避。

---

## 3. 工程路径

| 内容 | 路径 |
|---|---|
| 实验工程 | `/Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk-tv01` |
| 数据库 | `~/Library/Application Support/dev.artflow.minidesk.tv01/minidesk-tv01.sqlite` |
| 应用日志 | `/tmp/tv01-dev.log`（首次运行）、`/tmp/tv01-dev2.log`（重启验证） |
| 崩溃探针数据库 | `$TMPDIR/tv01crash.*/db.sqlite`（临时目录，自动生成） |

bundle identifier 为 `dev.artflow.minidesk.tv01`，与未来正式 miniDesk 隔离。

---

## 4. 依赖安装记录

| 安装项 | 方式 | 范围 | 说明 |
|---|---|---|---|
| Rust stable 1.100.0 | 官方 `sh.rustup.rs`，`-y --profile minimal --no-modify-path` | `~/.rustup`、`~/.cargo` | 未使用 sudo；**未修改 shell 配置**（`~/.zshrc` 中 `cargo/env` 命中 0，使用时临时 `export PATH`） |
| npm 依赖 | `npm install` | 工程内 `node_modules` | 27 packages，含 lockfile |
| Cargo 依赖 | `cargo` 自动解析 | 工程内 `target/` | tauri 2.12.5、rusqlite 0.43.0(bundled)、serde、serde_json、uuid |

未安装：Tauri SQL Plugin、图片库、ZIP 库、ORM、Supabase SDK、UI 框架、测试框架。未使用 sudo，未修改系统配置。

---

## 5. 最小架构

```
React (src/App.tsx)
  └─ src/bridge/commands.ts        只有 invoke 封装，零 SQL 字符串
       └─ 8 个 #[tauri::command] (src-tauri/src/lib.rs)
            └─ 领域层 (src-tauri/src/orders.rs)      规则 + 事务边界
                 └─ rusqlite Transaction (BEGIN IMMEDIATE … COMMIT)
                      └─ minidesk-tv01.sqlite
```

命令清单：`ping`、`app_info`、`list_orders`、`load_progress`、`create_order`、`edit_order`、`move_stage`、`set_order_status`。

连接管理：`DbState { conn: Mutex<Connection>, db_path }`，单连接串行；所有写命令经 `Mutex` 串行化，无连接池。

---

## 6. 测试结果矩阵

| 编号 | 测试项 | 执行方式 | 预期 | 实际 | 结果 | 证据 |
|---|---|---|---|---|---|---|
| T01 | 环境与启动 | `npm run tauri dev` | 编译、开窗、invoke 通、DB 可读写、无云端 | 窗口启动；日志 `db ready`、`invoke ping`、`invoke list_orders -> 0 rows` | **PASS** | `/tmp/tv01-dev.log` |
| T02 | 建单 + created 历史原子性 | `cargo test t02_*` + 实机操作 | 1 单 + 1 条 created + rev=0 + 关联正确 | 全部满足；DB 内 `AF-001 / created / draft / rev 0` | **PASS** | `tests/domain.rs::t02_*`、应用 DB |
| T03 | revision 冲突 | `cargo test t03_*` + 界面「制造 revision 冲突」 | 首次成功、rev+1；旧 rev 返回 CONFLICT；数据不被覆盖；不写历史 | 首次 rev 4→5；第二次拒绝（无成功日志）；标题保持 `· A`；历史仍 5 条 | **PASS** | `t03_*`、`/tmp/tv01-dev.log`、DB |
| T04 | 阶段推进与返工 | `cargo test t04_*` + 实机 3 次推进 | 每步有历史；forward/backward 正确；最终阶段正确 | 单测覆盖 draft→lineart→color→lineart（3 条 stage，末条 backward）；实机 draft→lineart→color→final | **PASS** | `t04_*`、`/tmp/tv01-dev.log` |
| T05 | 终态锁 | `cargo test t05_*` + 实机「标记完成」 | 终态拒绝推进/重新激活；状态与历史不变 | complete 后 `move_stage`/`set_order_status` 均 `INVALID`；rev 与历史条数不变；cancelled 同样拒绝 | **PASS** | `t05_*`、`/tmp/tv01-dev.log` |
| T06a | 故障注入：move_stage | `cargo test t06a_*` | 事务回滚：阶段、revision、历史全不变 | 阶段仍 `draft`、rev 0、历史 1 条、连接可继续用 | **PASS** | `t06a_*` |
| T06b | 故障注入：create_order | `cargo test t06b_*` | 订单与 created 历史都不留下 | orders 计数不变、无孤儿历史 | **PASS** | `t06b_*` |
| T07 | 重启持久化 | `cargo test t07_*` + 崩溃探针 + 应用重启 | 数据/阶段/revision 不丢，初始化不重复 | 重开文件库一致；abort 后重开一致；应用二次启动 `list_orders -> 1 rows`，模板仍 1 条 | **PASS** | `t07_*`、`crash_verify` 输出、`/tmp/tv01-dev2.log` |
| T08 | 迁移幂等 | `cargo test t08_*`（连续 3 次 migrate） | 不重复建表/插模板；数据不变；版本正确 | `stage_templates=1`、`user_version=1`、订单与历史不变 | **PASS** | `t08_*` |
| T09 | WAL / FK / JSON / 失败后可用 | `cargo test t09_*` | WAL 生效、外键生效、JSON 可用、失败后连接可用 | `wal`、FK 拒绝孤儿历史、`json_extract` 返回 42、`json_valid` 拒绝非法 JSON、失败事务后查询正常 | **PASS** | `t09_*` |
| T10 | 安全边界 | 静态断言测试 + capabilities 核对 | 前端无任意 SQL；参数化；最小权限 | `lib.rs` 内无 `execute_sql/execute_batch/query_row/prepare(`；命令数=8；capability 仅 `core:default`，无 `fs:/dialog:/sql:/shell:` | **PASS（静态）** | `t10_*`、`capabilities/default.json` |

**说明**：T10 是源码级断言，不是运行时渗透测试；真实攻击面验证需后续安全评审。

---

## 7. 事务与故障注入结果

**事务创建**：每个写命令内部 `conn.transaction_with_behavior(TransactionBehavior::Immediate)?`，作用域结束即提交或回滚。

**revision 校验**：
```sql
UPDATE orders SET title = ?1, revision = revision + 1
WHERE id = ?2 AND revision = ?3
```
`rows_affected != 1` 即返回 `CONFLICT`；读校验与写入在同一事务内，无“先查后写”的空窗。

**历史与订单同事务**：`create_order` 在插入订单后、同一 `tx` 内插入 `created` 事件；`move_stage` 先 `UPDATE current_stage_id`，再插入 `stage` 事件；`set_order_status` 同理插入 `status` 事件。

**回滚路径**：`inject_failure` 为 `true` 时在“订单/阶段已更新、历史未写”处返回 `Err`；`Transaction` 随作用域 drop，SQLite 自动回滚。

**是否验证真实数据库内容未改变**：是。T06a 回滚后重新查询：`current_stage_id=draft`、`revision=0`、历史 1 条；T06b 回滚后 `orders` 与 `order_progress` 计数均未增加。

故障注入入口只存在于 `create_order_inner` / `move_stage_inner` 的布尔参数，**命令层固定传 `false`，UI 无法触发**。

---

## 8. 持久化与迁移

- **进程内重开**：`t07` 关闭连接后用同一文件重新 `open` + `migrate`，订单、阶段、revision、历史全部一致。
- **进程强杀**：`crash_writer` 提交 1 单后 `BEGIN IMMEDIATE` 改标题并插历史，`std::process::abort()`（exit 134）。`crash_verify` 重开结果：
  ```
  integrity=ok
  orders=1
  title=崩溃前已提交
  progress=1
  uncommitted_rows=0
  ```
  即已提交事务保留、未提交事务完全丢弃、库完整可读、WAL 自动恢复。
- **应用级重启**：dev 进程退出后再次启动，`db ready ... user_version=1`，`list_orders -> 1 rows`，默认模板未重复插入。
- **迁移幂等**：连续 3 次 `migrate` 后模板 1 条、`user_version=1`、既有数据不变。

---

## 9. 安全检查

| 检查项 | 结果 |
|---|---|
| 是否存在通用 SQL 命令 | 无。`lib.rs` 中无 `execute_sql`、无 SQL 字符串、无 `query_row/prepare` 调用 |
| SQL 参数化 | 全部使用 `params![]` 绑定，无字符串拼接 |
| 非法状态 | 非 `complete/cancelled` 目标状态被拒；终态不二次变更；同阶段移动为 no-op |
| 任意文件读取 | 无文件系统命令；未启用 `plugin-fs` |
| capabilities | 仅 `core:default`，无 `fs:`/`dialog:`/`sql:`/`shell:` |
| 数据库位置 | 仅应用数据目录内的 `minidesk-tv01.sqlite` |

**已知边界**：`DbState` 用单一 `Mutex<Connection>`，命令同步执行；若未来加入长查询，可能阻塞 UI 线程，需要改为专用写线程或异步命令（TV-02 关注项）。

---

## 10. 遇到的问题

| # | 问题 | 处理 | 现状 |
|---|---|---|---|
| 1 | `tsc` 报 TS2304 `Cannot find name 'useMemo'`，并连带 `implicitly any` | 补 `useMemo` 导入 | 已修复，typecheck 通过 |
| 2 | `generate_context!` 编译失败：缺少 `icons/icon.png` | 用 Node/zlib 生成 512×512 RGBA PNG | 已修复，编译通过 |
| 3 | 首次 `rm -rf /tmp/tv01-crash` 被系统回收站包装拦截，导致目录未建成 | 改用 `mktemp -d`，不做删除 | 已绕过，无数据影响 |
| 4 | `cmd \| tail` 掩盖真实退出码 | 改用 `${PIPESTATUS[0]}` / 显式 `$?` | 已修正取数方式 |

**仍然存在的技术风险**：见 TV-02 建议——单 Mutex 的线程模型、WAL 与未来备份（`VACUUM INTO`）的配合、`current_stage_id` 在终态保留的语义。

**与指令 schema 的偏差（3 处，均为实现所需）**：
1. `order_progress` 增加 `from_status`/`to_status`：否则无法记录“complete 还是 cancelled”。
2. `order_progress` 增加 `from_stage_title`/`to_stage_title`：冻结阶段名称，避免模板改名后历史失真。
3. `orders.code` 取 `AF-{queue_position:03}`：实验中无独立编号序列；正式 schema 需重新定义。

---

## 11. 原仓库隔离核验

| 时点 | 分支 | HEAD | 工作区 |
|---|---|---|---|
| 实验前 | `work/u8-restart-prototypes` | `c5e67f02b7a0c0a46b7de058e01c7071a5ccde6c` | 0 行改动 |
| 实验后 | `work/u8-restart-prototypes` | `c5e67f02b7a0c0a46b7de058e01c7071a5ccde6c` | 0 行改动 |

ArtFlowDesk 全程只读：未安装依赖、未运行其测试/构建、未迁移数据库、未改配置、未触碰 Git。实验工程完全位于独立目录，数据库位于独立应用数据目录。

---

## 12. 最终判断

1. **Tauri 2 是否成功运行？** 是。真实窗口启动，日志记录 `db ready`、`invoke ping` 及完整业务调用序列。
2. **rusqlite bundled 是否正常使用？** 是。SQLite 3.54.1，WAL、外键、JSON1 均可用。
3. **Rust 侧单写入入口是否可行？** 是。8 个命令，前端零 SQL，写入全部经 `orders.rs`。
4. **订单与历史能否原子更新？** 能。同事务写入，注入故障后两者同时消失。
5. **revision 冲突是否可靠？** 是。同语句校验 + `rows_affected` 判定，旧 revision 被拒且不覆盖数据。
6. **故障注入是否证明完整回滚？** 是。阶段、revision、历史三处状态均回滚，且连接可继续使用。
7. **数据库重启持久化是否通过？** 通过（进程内重开、`abort()` 崩溃重开、应用二次启动三种路径）。
8. **是否发现必须改变架构的问题？** 未发现。唯一待定是“单 Mutex + 同步命令”的线程模型是否足够，属 TV-02 的 WebView/交互范畴。
9. **TV-01 是否满足全部强制验收条件？** 满足（T10 为静态断言，已在矩阵中标注）。
10. **是否建议进入 TV-02？** 建议。建议 TV-02 优先打掉 WebView 行为差异（`<dialog>`、中文 IME、窗口关闭拦截、`crypto.subtle`），并顺带确认同步命令的线程行为。

---

## 复现命令

```sh
export PATH="$HOME/.cargo/bin:$PATH"
cd /Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk-tv01

npm run typecheck && npm run build
cargo test --manifest-path src-tauri/Cargo.toml

DIR=$(mktemp -d "${TMPDIR:-/tmp}/tv01crash.XXXXXX")
cargo run --manifest-path src-tauri/Cargo.toml --example crash_writer -- "$DIR/db.sqlite"   # 预期 exit 134
cargo run --manifest-path src-tauri/Cargo.toml --example crash_verify -- "$DIR/db.sqlite"   # 预期通过

npm run tauri dev
```
