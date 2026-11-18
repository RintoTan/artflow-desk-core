# QA-FIXTURE-01 实施报告 · DEV-06D-2 时间线验收数据扩充

**性质：** QA 数据工具扩充。不碰数据库 schema、业务代码、生产接口、DEV-06D-2 功能实现。
**基线：** `77f3961`（dev06d-2 + FIX-01 之后）
**日期：** 2026-11-18

---

## 1. 结论先行

四个验收场景已在真实 QA 数据根下生成，各自独立目录、独立代际，`seeded` 未被触碰，正式目录指纹前后完全一致。

| 场景 | 目录 | 订单 | 状态构成 | 日期构成 |
|---|---|---|---:|---|
| A `timeline-unscheduled` | `<qa>/timeline-unscheduled` | 5 | 活动 5 | 两空 2 / 仅开始 1 / 仅交付 1 / 双日期 1 |
| B `timeline-empty` | `<qa>/timeline-empty` | 0 | — | — |
| C `timeline-no-dates` | `<qa>/timeline-no-dates` | 2 | 活动 2 | 两空 2 |
| D `timeline-terminal` | `<qa>/timeline-terminal` | 2 | 完成 1 / 取消 1 | 两空 2 |
| （原有）`seeded` | `<qa>/seeded` | 14 | 活动 10 / 完成 3 / 取消 1 | 本轮未写入（见 §6 说明） |

---

## 2. 修改文件

| 路径 | 改动 |
|---|---|
| `src-tauri/src/store/qa.rs` | `Scenario` 枚举 +4 变体；`as_str` / `parse` 白名单扩充；新增 `is_timeline_fixture()`。路径拼接仍走 `scenario_root`，**仍然不接受路径** |
| `src-tauri/src/qa_dataset/timeline_fixtures.rs` | **新增**（461 行）：四个场景的构建、数据集版本标记、幂等、失败回滚、形状校验（`FixtureFacts`） |
| `src-tauri/src/qa_dataset/mod.rs` | 挂 `mod timeline_fixtures;` 并导出；把 `has_environment` / `wipe_generated` / `report_from_conn` 从私有改为 `pub(super)`（同一 crate 内复用，无外部接口变化） |
| `src-tauri/src/bin/qa_seed.rs` | `--scenario` 分发到新场景；help 与启动提示同步 |
| `src-tauri/tests/qa_timeline_fixtures.rs` | **新增**（240 行）：9 条集成测试，直接查 SQLite 断言行数/日期/隔离/幂等/失败回滚/不动 seeded |
| `package.json` | 新增 8 个脚本：`qa:timeline-*`（启动）与 `qa:seed:timeline-*`（预置） |

**未修改：** `domain/*`、迁移、`ProjectTimeline.tsx`、`timeline.ts`、`styles.css`、`tauri.qa.conf.json`、正式 identifier 相关任何代码。

---

## 3. 机制说明（为什么不需要改生产逻辑）

原有 QA 隔离机制已经是"白名单场景名 → QA 根的子目录"：

```
~/Library/Application Support/dev.artflow.minidesk.qa/
├── seeded/                 ← 原有，未动
├── clean/                  ← 原有，未动
├── timeline-unscheduled/   ← 新增
├── timeline-empty/         ← 新增
├── timeline-no-dates/      ← 新增
└── timeline-terminal/      ← 新增
```

- 新增场景只是扩充 `Scenario` 白名单；`scenario_root()` 的 `join(scenario.as_str())` 一行未改，因此**路径逃逸仍然不可能**（`timeline-oops` 被拒，`../timeline-empty` 被拒，均有测试）。
- 每个场景目录带自己的 `.qa-root` 标记与自己的 `qa.seed.version`，互不识别对方数据。
- 每个场景首次打开会自建代际（`generations/gen-<uuid>`），因此四套数据物理隔离。
- 应用侧无需改动：`lib.rs` 已是 `if is_qa_identifier(identifier) { scenario_from_env() → scenario_root(...) }`，新场景自动走同一条路。

---

## 4. 场景启动与切换

预置（一次性，幂等）：

```bash
npm run qa:seed:timeline-unscheduled
npm run qa:seed:timeline-empty
npm run qa:seed:timeline-no-dates
npm run qa:seed:timeline-terminal
```

启动（各自独立进程，切换＝换场景名重启）：

```bash
npm run qa:timeline-unscheduled
npm run qa:timeline-empty
npm run qa:timeline-no-dates
npm run qa:timeline-terminal
```

脚本内容即 `AF_MINIDESK_QA_SCENARIO=<场景> tauri dev --config src-tauri/tauri.qa.conf.json`，identifier 仍是 `dev.artflow.minidesk.qa`。

重建（会先校验 `.qa-root` 标记再清空该目录）：

```bash
cargo run --manifest-path src-tauri/Cargo.toml --bin qa_seed -- --scenario timeline-terminal --rebuild
```

---

## 5. 重置的影响与恢复

| 操作 | 影响范围 | 恢复方式 |
|---|---|---|
| `qa_seed --scenario timeline-*`（无 `--rebuild`） | 无：已存在同版本数据时直接返回 | — |
| `--rebuild` | **只清空该场景目录**的 `generations/`、`state/`、`backups/`、`recovery/`、`environment.json`，保留 `.qa-root` | 重新跑一次同名 seed 即恢复（数据是确定性生成的） |
| 删除某场景目录 | 只影响该场景 | `qa_seed --scenario <名>` 重新生成 |
| 正式数据目录 | **任何情况下都不被触碰**：`ensure_not_production()` 会拒绝与正式目录重叠/嵌套/别名 | — |

本轮**没有**对 `seeded` 或 `clean` 执行任何 `--rebuild`。

---

## 6. 测试与证据

| # | 命令 | 结果 |
|---|---|---|
| 1 | `cargo test --manifest-path src-tauri/Cargo.toml --test qa_timeline_fixtures` | **9 passed / 0 failed** |
| 2 | `cargo test --manifest-path src-tauri/Cargo.toml`（全量 Rust） | **329 passed / 0 failed** |
| 3 | `npx vitest run src/components/ProjectTimeline.test.tsx src/lib/timeline.test.ts` | **2 files / 48 tests passed** |
| 4 | `npx tsc --noEmit` | exit 0 |
| 5 | `npm run build` | `✓ built in 111ms`（仅既有 dynamic-import 警告） |

真实数据核对（`sqlite3` 直查活动代际，不依赖 `qa_seed` 自述）：

```text
seeded               qa01-v1                    orders 14   active 10 / complete 3 / cancelled 1
timeline-unscheduled qa-timeline-unscheduled-v1 orders  5   active 5   两空 2 / 仅开始 1 / 仅交付 1 / 双日期 1
timeline-empty       qa-timeline-empty-v1       orders  0
timeline-no-dates    qa-timeline-no-dates-v1    orders  2   active 2   两空 2
timeline-terminal    qa-timeline-terminal-v1    orders  2   complete 1 / cancelled 1   两空 2
```

场景 A 的完整清单：

```text
code          status  start       delivery
AF-2026-0001  active  NULL        NULL      → 完全未排期
AF-2026-0002  active  NULL        NULL      → 完全未排期
AF-2026-0003  active  2026-11-19  NULL      → 轨道（仅开始）+ 后端计入待定交付日
AF-2026-0004  active  NULL        2026-11-24 → 轨道（仅交付）
AF-2026-0005  active  2026-11-15  2026-11-22 → 区间条
两空=2 / delivery IS NULL=3   ← 两套口径的差异就在这里
```

隔离与不动原有场景：

```text
四个新场景 generation   各自不同 UUID，均带 .qa-root，各自独立 database.sqlite
seeded  活动代际         gen-f410eeb0f1e24c6d90c376a3680f600d
seeded  DB mtime         Nov 18 19:04:55（早于本轮首次 seed 的 19:11:01）
正式目录文件指纹 前/后    e515a55d…4eaf / e515a55d…4eaf（完全一致）
正式目录 .qa-root        不存在
```

**关于 `seeded` 的 14 单（必须如实说明）**：这个数字不是本轮造成的。
本机此刻有你自己启动的 QA 应用在运行（`tauri dev --config tauri.qa.conf.json`，PID 76888，
`lsof` 显示它锁的是 `…/dev.artflow.minidesk.qa/seeded/.write.lock`），它在 19:04:55 写入了
`AF-2026-0014「国庆跨年订单」`——也就是你在实机里手动建的那一单。本轮四个 seed 从 19:11:01 才开始，
且每个 seed 只打开自己的目录（新场景能拿到锁即证明它们与 `seeded` 不是同一个目录）。
本轮没有任何代码路径写入 `seeded`，也没有对它执行 `--rebuild`。

---

## 7. Git

- 本轮提交只含上述 6 个文件。
- REVISION-01 / DOC-CLEANUP 的 13 个未提交文档修改仍在工作区，未暂存。
- `交付给 ChatGPT 的文件/AFD-CORE-STABILIZATION-01/screenshots.zip` 未跟踪、未删除。
- 未推送远程。

---

## 8. 未完成 / 边界

| 项 | 状态 |
|---|---|
| U4 Mac 实机验收（逐场景看真实界面） | **NOT RUN**——按要求本轮只准备数据，等 ChatGPT 审查后再继续 |
| Windows WebView2 下的场景验收 | NOT RUN |
| 场景 A 里"跨年区间"、"200 行以上" | 未覆盖，不是本次要求（属 DEV-06D-2 既有 NOT RUN） |
| `seeded` 场景是否也需要补齐"完全未排期" | 不需要：场景 A 专门承担；`seeded` 保持原样以免破坏既有证据 |

数据已就绪，可以在 `timeline-empty` / `timeline-no-dates` / `timeline-terminal` 三个场景分别验证三种空状态，在 `timeline-unscheduled` 验证未排期分类与单端日期。
