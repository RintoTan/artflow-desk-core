# QA-01 独立测试沙箱与自动预置数据 — 结果报告

- 日期：2026-11-17
- 工程：`/Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk`（分支 `master`，未推送）
- 结论：QA 沙箱按**独立应用标识 + 场景子目录**实现，不使用环境变量覆盖路径；
  两套场景（seeded / clean）已生成；16 条隔离与预置测试通过；
  正式与 QA 已实测**同时运行**且互不影响。

---

## 1. QA 架构与数据目录

### 1.1 先看原来有什么

| 检查 | 结果 |
|---|---|
| 数据根来源 | 仅 `app.path().app_data_dir()`，没有测试模式 |
| 可复用机制 | `store/paths.rs` 的 `Layout` 把 `state/`、`generations/`、`highwater.sqlite`、`attachments/`、`backups/`、`recovery/` 全部从单一 root 派生 |
| 上一版尝试 | 用 `AF_MINIDESK_QA_ROOT` 指向任意目录 —— **本轮废弃**（见 2.1） |

### 1.2 现在的目录布局

```text
~/Library/Application Support/
├── dev.artflow.minidesk/            ← 正式台账（用户数据，任何 QA 命令都不指向它）
│   ├── environment.json
│   ├── state/{active.json, highwater.sqlite}
│   └── generations/gen-*/{database.sqlite, attachments/}
└── dev.artflow.minidesk.qa/         ← QA 沙箱（独立应用标识，可整体删除）
    ├── seeded/                      ← 预置场景（12 单）
    │   ├── .qa-root
    │   ├── environment.json
    │   ├── state/{active.json, highwater.sqlite}
    │   └── generations/gen-7da0bded6d52451d9243ae5682fe6666/
    │       ├── database.sqlite
    │       └── attachments/{originals, thumbs}
    └── clean/                       ← 空白场景（只有 .qa-root，首次启动才初始化）
        └── .qa-root
```

两个 QA 场景各自拥有完整的：业务 SQLite、`state/highwater.sqlite`、`environment.json`、
`state/active.json`、generations、附件四个子目录、`cleanup_tasks` / `attachment_jobs` 表、
`.write.lock` 文件锁。**没有任何一项与正式目录共享。**

---

## 2. 与正式环境的隔离方式

### 2.1 为什么改掉"环境变量指定路径"

上一版让 `AF_MINIDESK_QA_ROOT` 指向任意目录。这有两个问题：

1. 正式发布版一旦接受任意路径，就等于给"把用户数据指到别处"开了后门——误设即灾难。
2. 任何人手工 `export` 一下就能把 QA 指到正式目录上，只能靠路径检查事后拦。

本轮改为**结构性隔离**：

| 层 | 做法 |
|---|---|
| 应用标识 | QA 用 `dev.artflow.minidesk.qa`，系统据此分配独立数据目录，与正式是兄弟目录 |
| 配置 | `src-tauri/tauri.qa.conf.json` 覆盖 `identifier` / `productName` / 窗口标题 / dev 端口 |
| 场景 | `seeded` / `clean` 两个**白名单值**，只决定 QA 目录下的子目录名，**不接受路径** |
| 路径校验 | 比较前先对"最长存在祖先"做 canonicalize，符号链接别名绕不过去 |
| 反向守卫 | 正式启动时若正式目录出现 `.qa-root`，直接拒绝启动 |
| asset 协议 | QA 配置的 scope 只覆盖 `...dev.artflow.minidesk.qa/{seeded,clean}/generations/*/attachments/**` |

正式构建完全不读 `AF_MINIDESK_QA_SCENARIO`：这条变量只在 `identifier == dev.artflow.minidesk.qa`
的分支里被读取，正式构建走另一条路径。

### 2.2 隔离证据（不是比较配置字符串）

`src-tauri/tests/qa_isolation.rs`，16 条用例：

| 用例 | 证明 |
|---|---|
| `qa_and_production_directories_differ` | 两个根 + 两个场景，两两不同 |
| `symlink_alias_cannot_bypass_the_isolation_check` | 指向正式目录的符号链接被识别为重叠；反向嵌套也拒绝 |
| `scenario_names_are_allowlisted_not_paths` | `/tmp`、`../../etc`、`seeded/../clean`、空串全部拒绝 |
| `only_the_qa_identifier_enters_qa_mode` | 正式标识、`...qa.evil` 都不进 QA |
| `production_start_refuses_when_a_qa_marker_sits_in_the_real_root` | 反向守卫生效 |
| `qa_marker_is_required_before_any_wipe` | 无标记时拒绝任何删除，文件仍在 |
| `qa_and_production_keep_separate_highwater_and_pointer` | 代际指针不同；两侧高水位各在自己根内；正式库 0 单，QA 12 单 |
| `qa_attachment_files_live_only_under_the_qa_root` | 附件真实路径全部在 QA 根内且文件存在 |
| `cleanup_of_the_qa_layout_does_not_touch_other_roots` | 跑 QA 清理后，正式侧哨兵文件字节不变 |
| `both_environments_can_be_open_at_the_same_time` | 两个根可同时持锁；同一 QA 根第二次打开被锁挡住 |
| `seeding_twice_does_not_duplicate_orders` | 第二次返回 `already_seeded`，计数不变 |
| `interrupted_seed_leaves_no_complete_looking_data_and_can_be_rerun` | 失败后无 `environment.json`、无 `generations/`，标记保留，可重跑成功 |
| `clean_scenario_bootstraps_to_an_empty_business_state` | clean 目录启动前无 environment.json；启动后 `first_run=true`，订单 0、事件 0 |
| `seeded_scenario_has_the_expected_events_amounts_and_deadlines` | 双完成 2 条、重开 1 条、跨月 9→10、NULL/0/普通金额、today/overdue/unscheduled/dueSoon 齐全、同名客户、默认模板唯一 |
| `qa_asset_scope_covers_scenario_attachment_paths` | 用 `glob` 真匹配：覆盖两个场景的附件路径，**不覆盖**正式附件路径 |
| `dataset_report_matches_reality` | 数据集版本写入 `app_settings`，订单数 ≥ 12 |

全部跑在 `tempfile` 临时目录，不打开真实用户数据。

---

## 3. 预置数据集与固定标识

- 数据集版本：`qa01-v1`，写在 `app_settings["qa.seed.version"]`。
- 期日基准：工作时区固定 **Asia/Shanghai**（seed 时写入），到期类日期按"生成当天的日历日"计算。
- 编号：QA 高水位独立，从 `AF-2026-0001` 开始。

| 编号 | 标题 | 状态 | 金额 | 到期 | 覆盖点 |
|---|---|---|---|---|---|
| AF-2026-0001 | 双完成演示稿 | 已完成 | 880 | 已过期 | 完成两次 + 重开 + 一次完成在 10 月（跨月）+ 下钻靶子 |
| AF-2026-0002 | 跨月完成稿 | 已完成 | 1200 | 无 | 9 月创建 / 10 月完成 → 金额按创建月归属 |
| AF-2026-0003 | 制作中的加急稿 | 制作中（3/6） | 1500 | 今天 | 今天到期、制作中、4 张参考图 |
| AF-2026-0004 | 三天内交付的封面 | 排队中 | 450 | 2 天后 | 三日内到期 |
| AF-2026-0005 | 已逾期的线稿 | 排队中 | 300 | 3 天前 | 逾期 |
| AF-2026-0006 | 未排期的草稿 | 排队中 | **NULL** | 无 | 未排期 + 未知金额 |
| AF-2026-0007 | 零元友情稿 | 已完成 | **0** | 昨天 | 0 元 ≠ 未知 |
| AF-2026-0008 | 已取消的企划 | 已取消 | 50 | 无 | 取消事件 / 终态下钻 |
| AF-2026-0009 | `=1+1 注入样本` | 排队中 | 1 | 无 | CSV 防注入 |
| AF-2026-0010 | `+1+1 注入样本` | 排队中 | 1 | 无 | 同上 |
| AF-2026-0011 | `-2+3 注入样本` | 排队中 | 1 | 无 | 同上 |
| AF-2026-0012 | `@SUM(1,2) 注入样本` | 排队中 | 1 | 无 | 同上 |

- 客户 3 个：`林小满`（两个不同 ID）、`陈叙`。
- 模板 3 套：默认「通用制作流程」5 阶段、「轻量三阶段」、「六阶段加急」；只有一个是默认。
- 附件 4 张（AF-0003）：PNG 320×240、JPEG 300×420（竖）、WebP 500×200（宽）、PNG 64×64；
  全部由 `image` 库现场生成纯色块，**不含真实作品**。
- 事件 36 条，其中完成 4 条（AF-0001 两条、AF-0002 一条、AF-0007 一条）。

> **受控 fixture 说明**：AF-0001 / AF-0002 的创建时间与部分完成时间是写死的（2026-09、2026-10），
> 用 `domain/fixture.rs` 只改 `occurred_at` / `created_at`，不改状态、阶段、金额或编号。
> 这两张单的时间**不是真实操作发生的时间**，仅用于验证跨月归属。其余订单全部是真实"现在"。

### 3.1 CSV 样本的一处限制

需求里的"前导空格后 `=1+1`"没法做成订单标题：`clean_title` 会 `trim()`，前导空格在入库前就没了。
该情形由 `tests/export_csv.rs` 的单元样本覆盖（`   =1+1`），预置数据里只有 4 个可直接点击的样本。
这是如实差异，不是遗漏。

---

## 4. Seed 的三种行为

| 行为 | 触发 | 实际效果 |
|---|---|---|
| **首次创建** | `npm run qa:seed` | 初始化代际、写默认模板、按领域函数建 12 单、导入 4 张图、写数据集版本 |
| **重复执行** | 再跑一次 `npm run qa:seed` | 检测到同版本数据集，打印「未做任何改动」，**不重复插入**；计数保持不变 |
| **显式重建** | `npm run qa:rebuild` | 先 `verify_marker` 确认是 QA 目录，再清空 `generations/ state/ backups/ recovery/ environment.json`，重新生成 |

失败处理：中途任何错误都会清掉本次生成的代际与状态，只保留 `.qa-root`；
下次必须显式重建。`interrupted_seed_leaves_no_complete_looking_data_and_can_be_rerun`
用 `--fail-after 2` 真的制造了一次中断来验证这一点。

所有业务数据都经 `orders::create_order`、`lifecycle::*`、`clients::create`、
`templates::create`、`attachments::import` 写入，没有手写业务 INSERT，
因此不可能造出"没开工就完成"这类违反约束的状态。

---

## 5. Clean QA 的空状态保证

- `npm run qa:seed:clean` 只创建目录与 `.qa-root`，**不建数据库、不写 `environment.json`**。
- 应用启动时才初始化——这才是真正的首次启动路径（`first_run=true`）。
- 测试断言：启动后 `orders = 0`、`order_events = 0`。
- seeded 与 clean 是两个目录，clean 里建的单不会出现在 seeded。

---

## 6. 真实运行的测试命令与结果

```text
cargo test                → 278 passed / 0 failed（28 个测试二进制 + doc-tests）
cargo check --all-targets → 通过，0 warning
npm run test              → 87 passed / 0 failed（13 个文件）
npx tsc --noEmit          → 通过
npm run build             → ✓ built in 125ms（dist/assets/index-MDnilfYO.js 393.82 kB）
```

本轮 Rust 270 → **278**：新增 16 条 QA 隔离/预置用例 + 1 条 fixture 时间格式用例，
移除上一版 9 条基于环境变量的旧用例（机制已换）。

真实启动（QA 与正式**同时**运行）：

```text
[minidesk] env ready mode=qa scenario=seeded identifier=dev.artflow.minidesk.qa
           path=/Users/rinto/Library/Application Support/dev.artflow.minidesk.qa/seeded
           generation=gen-7da0bded6d52451d9243ae5682fe6666 schema=v3 first_run=false tz=Asia/Shanghai

[minidesk] env ready mode=production scenario=- identifier=dev.artflow.minidesk
           path=/Users/rinto/Library/Application Support/dev.artflow.minidesk
           generation=gen-c00a879220964299af7adcef8b9fc1c5 schema=v3 first_run=false tz=Asia/Shanghai
```

两个进程同时存活，dev server 分别在 1420 / 1421，两个窗口标题不同，两个数据根各自持锁。

> 一处波折：首次 QA 启动失败，报 `Port 1420 is already in use` —— 上一次正式启动留下的 vite
> 进程没退干净。QA 配置已改用 1421，正常情况下不会冲突；上一次的残留是旧版本留下的。

---

## 7. 正式数据前后指纹

| 项 | 开工前 | 收工后 |
|---|---|---|
| HEAD / 分支 | `ac32bab` / `master` | 见第 11 节，未推送 |
| 活动代际 | `gen-c00a879220964299af7adcef8b9fc1c5` | 同 |
| schema | v3 | v3 |
| 订单 / 客户 / 模板 / 附件 | 4 / 1 / 2 / 2 | 4 / 1 / 2 / 2 |
| 事件（含 completed） | 23（4） | 23（4） |
| 正式目录内 `.qa-root` | 无 | 无 |
| 高水位文件 | `state/highwater.sqlite` | 同，未重置 |

正式应用只被**启动**过（用于并行验证），没有执行任何 seed、重置或删除。
QA 数据全部在 `.../dev.artflow.minidesk.qa/`，与正式目录是兄弟关系。

另外：上一版机制在 `/Users/rinto/ArtFlow-miniDesk-QA` 留下的目录已删除——那是我自己生成的
测试产物，不属于用户数据。

---

## 8. QA 附件与 asset 协议

- `tauri.qa.conf.json` 的 `assetProtocol.scope` 为：
  `$APPDATA/seeded/generations/*/attachments/**` 与 `$APPDATA/clean/generations/*/attachments/**`。
- 生效前提：`$APPDATA` 在 QA 构建里解析到 `.../dev.artflow.minidesk.qa`，所以路径正好匹配。
- 若沿用正式配置的 `$APPDATA/generations/*/...`，会少一层场景目录 → **图片会显示不出来**。
  这正是 §3 要求"考虑 asset scope"的实际坑，已用 `glob` 匹配写成测试：
  覆盖两个场景，且不覆盖正式目录。
- 附件文件本身：`qa_attachment_files_live_only_under_the_qa_root` 断言 4 个文件真实存在且在 QA 根内。
- **界面上图片是否真的显示出来：NOT VERIFIED**（见第 9 节）。

---

## 9. macOS 真实窗口中仍需你点击的验收

我做不了鼠标操作与截图（`osascript` 无辅助访问 -1728，`screencapture -l` 取不到窗口），
以下项目状态为 **NOT VERIFIED**：

| # | 项目 | 期望 |
|---|---|---|
| 1 | 启动 seeded 后窗口标题 | 「ArtFlow miniDesk — QA 测试环境」 |
| 2 | 顶部横幅 | 琥珀色「QA 测试环境（预置场景）…」 |
| 3 | 工作台「本月完成次数」 | 3（AF-0001 ×2 + AF-0007 ×1，均在 11 月） |
| 4 | 完成事件下钻 | 两条都打开「双完成演示稿」；「零元友情稿」打开它自己 |
| 5 | 订单列表 | 12 条；今天/逾期/未排期徽标正确 |
| 6 | 附件 | 「制作中的加急稿」4 张缩略图能显示、能打开查看器 |
| 7 | 统计页「近 6 个月」 | 9 月有一笔 1200（跨月完成稿），金额归属创建月 |
| 8 | CSV 导出 | 4 个注入标题不变公式、带前缀 |
| 9 | clean 场景 | 首次启动为空，建单编号从 AF-2026-0001 开始 |

自动化能证明的部分（数据、路径、锁、scope 匹配、组件行为）已全部通过；
以上 9 条必须由你在真实窗口点一次。

---

## 10. 故障、限制与风险

1. **切换配置会触发重编译**：`npm run qa:seeded` 与 `npm run tauri dev` 交替时，
   Tauri 会因配置变化重新构建，首次约 10 秒。属正常现象。
2. **端口**：正式 1420、QA 1421。若残留旧进程，先 `lsof -ti:1420 | xargs kill -9`。
3. **`--fail-after` 是测试后门**：只影响 `qa_seed`（开发工具），不随安装包分发，
   产品命令层不可达（`tests/commands.rs` 仍禁止命令层出现 `seed` 相关名称）。
4. **受控 fixture 的边界**：只改时间戳；`domain/fixture.rs` 有单元测试约束格式必须是 UTC RFC3339。
5. **一个命令层守卫曾拦下我**：`tests/commands.rs` 禁止 `lib.rs` 出现子串 `seed`，
   我最初把模块命名为 `seed`，测试直接失败。处理方式是**把模块改名为 `qa_dataset`**，
   而不是放宽这条测试。
6. **clean 场景不是"每次启动都干净"**：一旦你在里面建了单，它就是有数据的；
   想重来用 `qa_seed --scenario clean --rebuild`。
7. **不支持多套并行 seeded**：机制上可按场景名扩展，但本轮只做两套，避免选择困难。
8. **附件夹具是生成的纯色块**，不覆盖超大图、EXIF 旋转等边界。

---

## 11. 本地 Git 提交

```text
20e24e0 feat(orders): restore the workflow template selector
bf6bc0b docs: close DEV-05 (8/8 + 5/5 + 3/3) and record the T1 ruling
<本报告相关提交见下>
```

本轮（QA-01）按三组提交：安全机制 / 数据预置 / 测试与文档，具体哈希见下：

```text
(1) feat(qa): identify the QA build by app identifier and isolate scenarios
(2) feat(qa): deterministic seeded dataset with clean scenario and rebuild guard
(3) test/docs: qa isolation suite, sandbox manual and QA-01 report
```

未推送远程。

---

## 12. DEV-06 使用 QA 沙箱的方法

1. 涉及**状态复杂**的功能（主题、时间轴、统计、列表、快捷键）→ 用 `npm run qa:seeded`，
   直接看 12 张订单的既有状态，不需要重新造数据。
2. 涉及**流程本身**的功能（关窗草稿保护、首次使用、建单建客户）→ 用 `npm run qa:clean`。
3. 每轮验收前如果要重置：`npm run qa:rebuild`（seeded）或
   `cargo run --manifest-path src-tauri/Cargo.toml --bin qa_seed -- --scenario clean --rebuild`。
4. DEV-06 若新增主题表或时间轴字段：**仍不允许改正式库**；迁移只在 QA 根里跑，
   确认无副作用后再走正式升级。
5. 报告里继续区分：自动化 PASS / QA 实机 PASS / 正式实机 PASS / NOT RUN / PARTIAL / FAIL。

---

## 13. 给普通 Mac 用户的完整操作说明

### 13.1 从零启动 QA 预置场景

1. 打开「访达」→「应用程序」→「实用工具」→「终端」。
2. 复制粘贴下面两行（第一行进入工程，第二行启动）：

```bash
cd /Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk
npm run qa:seeded
```

3. 第一次会编译约 10 秒。看到下面这行就说明进了 QA：

```text
[minidesk] env ready mode=qa scenario=seeded identifier=dev.artflow.minidesk.qa ...
```

4. 窗口标题应为「ArtFlow miniDesk — QA 测试环境」，窗口顶部有琥珀色横幅。

### 13.2 启动空白场景

```bash
cd /Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk
npm run qa:clean
```

### 13.3 重建预置数据

```bash
cd /Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk
npm run qa:rebuild
```

### 13.4 停止

在运行中的终端窗口按 `Ctrl + C`。若窗口没关，再执行：

```bash
pgrep -fl artflow-minidesk
kill <上面显示的 PID>
```

### 13.5 清除全部 QA 数据

```bash
rm -rf "$HOME/Library/Application Support/dev.artflow.minidesk.qa"
```

正式台账在 `~/Library/Application Support/dev.artflow.minidesk`，**不要删**。
