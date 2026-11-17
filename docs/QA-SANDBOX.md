# QA 沙箱与分层实机验收

- 生效范围：DEV-05-FIX 起，DEV-06～DEV-09 沿用。
- 工程：`/Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk`
- 一句话：**同一份程序，两套完全独立的数据根**；测试数据永远进不了正式台账。

---

## 1. 先评估：原来有没有独立数据根

| 检查 | 结论 |
|---|---|
| 数据根来源 | `lib.rs` 里只有 `app.path().app_data_dir()`，没有命令行参数或环境变量 |
| 是否支持测试模式 | 无 |
| 是否有可复用的隔离机制 | **有**：`store/paths.rs` 的 `Layout` 把所有路径都从单一 root 派生（`state/`、`generations/`、`backups/`、`recovery/`、`highwater.sqlite`、`attachments/`），`Environment::open_with(root, …)` 本来就接受任意根 |

所以没有另造一套存储：**只是把 root 的来源从"写死"改成"可配置 + 可验证"**，
其余代际、编号高水位、附件目录、清理任务、跨进程锁全部沿用原有代码。
这也意味着隔离强度等于原有单根结构——它们本来就只认自己的 root。

---

## 2. 隔离机制（四条硬约束）

启动阶段就决定，先于任何数据库读写：

| # | 约束 | 失败结果 |
|---|---|---|
| 1 | **双钥匙**：`AF_MINIDESK_QA=1` 与 `AF_MINIDESK_QA_ROOT=<绝对路径>` 必须同时设置 | 只设一个 → `ENV` 错误，**拒绝启动**，不会回退到正式目录 |
| 2 | **标记文件**：QA 根里必须有 `.qa-root`，内容为 `artflow-minidesk-qa` | 缺失或内容不符 → 拒绝启动 |
| 3 | **互相包含检查**：QA 根与正式数据目录在任一方向互相包含都拒绝 | 拒绝启动 |
| 4 | **反向守卫**：正式模式启动时，若正式数据目录里出现 `.qa-root` | 拒绝启动并提示先确认数据来源 |

实现：`src-tauri/src/store/qa.rs`（约 130 行，不读数据库）。

界面标识：`environment_status` 返回 `qaMode`，外壳顶部显示琥珀色横幅
「QA 测试环境 · 数据目录与正式应用完全隔离」，侧栏副标题同时变为「QA 测试环境」，
「数据环境」页把「运行模式」列在最前面。状态查询失败时不显示横幅，也不猜测。

### 证据（`src-tauri/tests/qa_isolation.rs`，9 用例）

| 用例 | 证明什么 |
|---|---|
| `without_env_vars_the_app_stays_in_production_mode` | 不设变量时行为不变 |
| `only_one_key_is_rejected_in_both_directions` | 单钥匙不会静默降级成正式模式 |
| `qa_root_without_marker_is_refused` | 普通目录（含正式目录）不会被当成 QA |
| `qa_root_with_wrong_marker_body_is_refused` | 标记内容被改也拒绝 |
| `qa_root_cannot_overlap_production_in_either_direction` | 相同 / 嵌套 / 反向嵌套三种都拒绝 |
| `production_start_refuses_when_a_qa_marker_sits_in_the_real_root` | 反向守卫生效 |
| `a_valid_qa_root_resolves_only_to_itself` | 合法 QA 根解析为自身 |
| `two_roots_stay_separate` | 在 QA 根启动后，正式目录**文件数量不变**、哨兵内容不变、不产生 `environment.json` |
| `maintenance_of_one_root_does_not_touch_the_other` | 对 A 根执行代际回收，B 根的数据库完好 |

> 这些用例全部跑在 `tempfile` 临时目录，不打开真实用户数据。

---

## 3. 数据预置（`qa_seed`）

工具：`src-tauri/src/bin/qa_seed.rs`（开发/QA 专用，不随安装包分发）。

**所有数据都经正式领域函数写入**：`orders::create_order`、`lifecycle::start_work /
advance_stage / complete_order / reopen_order / cancel_order`、`clients::create`、
`templates::create`、`attachments::import`。没有一条手写 INSERT，因此不可能造出
违反业务约束的状态（例如"没开工就完成"）。

### 命令

```bash
cd /Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk/src-tauri
cargo run --bin qa_seed -- --root /Users/rinto/ArtFlow-miniDesk-QA
# 重建（会先校验 .qa-root 标记，再清空）
cargo run --bin qa_seed -- --root /Users/rinto/ArtFlow-miniDesk-QA --reset
```

规则：

- 目标必须绝对路径，且不能与 `~/Library/Application Support/dev.artflow.minidesk` 互相包含。
- 已有数据时**不加 `--reset` 一律失败**，不静默覆盖。
- `--reset` 只在目录带 `.qa-root` 时允许；没有标记就拒绝删除任何东西。

### 本轮预置内容

| 编号 | 标题 | 状态 | 金额 | 交付日 | 用途 |
|---|---|---|---|---|---|
| AF-2026-0001 | 双完成演示稿 | 已完成（完成两次） | 880.00 | 昨天之前 | **S3 下钻靶子**：`completed`(id 7) + 重开 + `completed`(id 9) |
| AF-2026-0002 | 制作中的加急稿 | 制作中（第三阶段） | 1500.00 | 今天 | 今天到期 / 制作中徽标 |
| AF-2026-0003 | 已逾期的线稿 | 排队中 | 300.00 | 3 天前 | 逾期提醒 |
| AF-2026-0004 | 未排期的草稿 | 排队中 | NULL | 无 | 未排期 + 未知金额 |
| AF-2026-0005 | 零元友情稿 | 已完成 | 0.00 | 昨天 | 0 元 ≠ 未知金额 |
| AF-2026-0006 | 已取消的企划 | 已取消 | 50.00 | 无 | 终态订单下钻 |
| AF-2026-0007 | `=1+1 公式注入标题` | 排队中 | 123.45 | 无 | CSV 防注入 + 3 张附件 |

其它：

- 客户 2 个，**同名不同人**（都叫「林小满」，联系方式不同），验证同名不合并。
- 模板 2 个：默认「通用制作流程」5 阶段、非默认「轻量三阶段」3 阶段。
- 附件 3 张（PNG / JPEG / WebP），**由 `image` 库现场生成纯色渐变块**，
  不是真实作品；经正式导入通道写入 QA 代际的 `attachments/` 下。
- 时间口径：交付日以**工作时时区**的今天为基准做相对偏移（-3 / 0 / -1 天），
  写入的是日历日期字符串；事件时间是真实 UTC 时间戳，所以"本月完成次数"当前为 **3**
  （AF-0001 两次 + AF-0005 一次）。没有任何伪造的历史时间戳。

---

## 4. 两类实机入口

| 入口 | 用途 | 适用 |
|---|---|---|
| **A. 预置场景验收** | 直接看复杂状态：两次完成事件下钻、逾期/今天/未排期、零元与未知金额、同名客户、附件 | 统计口径、下钻、列表筛选、附件这类"状态难造"的检查 |
| **B. 从零流程验收** | 在干净 QA 环境里由你亲手建单、选模板、导入图片、推进、完成 | 新建/编辑/导入这类"流程本身"的检查 |

每轮由 ChatGPT 按变更风险选择；两者结合时，先 A 看状态，再 B 走流程。
**自动化通过不等于 A 或 B 通过**，也不允许用预置数据展示成功代替新建流程通过。

---

## 5. 启动、停止、重建

### 启动（从打开「终端」开始）

```bash
cd /Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk
AF_MINIDESK_QA=1 AF_MINIDESK_QA_ROOT=/Users/rinto/ArtFlow-miniDesk-QA npm run tauri dev
```

首次运行需要编译，会出现 `Running target/debug/artflow-minidesk`。
判定是否真的进了 QA：

- 终端出现 `[minidesk] env ready mode=qa path=/Users/rinto/ArtFlow-miniDesk-QA …`
- 窗口顶部有琥珀色横幅「QA 测试环境 · 数据目录与正式应用完全隔离」
- 「数据环境」页第一行为「运行模式：QA 测试环境（与正式数据隔离）」，数据目录显示 `/Users/rinto/ArtFlow-miniDesk-QA`

> 三者缺一，就说明没进 QA 环境，请停止操作并按第 9 节报告。

### 停止

在终端窗口按 `Ctrl + C`，等进程退出（窗口关闭）。
确认没有残留：

```bash
pgrep -fl artflow-minidesk
```

有输出就 `kill <PID>`。

**停止不会删除任何数据**，下次启动仍是同一套预置场景。

### 重建

```bash
cd /Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk/src-tauri
cargo run --bin qa_seed -- --root /Users/rinto/ArtFlow-miniDesk-QA --reset
```

### 彻底清除 QA 数据

```bash
rm -rf /Users/rinto/ArtFlow-miniDesk-QA
```

这个目录与正式数据目录无任何关联；删掉不影响正式台账。

---

## 6. 验收证据口径

报告中只会使用以下六种标记，且**实机结论一律由你提供**：

| 标记 | 含义 |
|---|---|
| 自动化 PASS | 我这边 `cargo test` / `npm run test` 通过 |
| QA 实机 PASS | 你在 QA 沙箱里点击确认 |
| 正式实机 PASS | 你在正式应用里点击确认 |
| PARTIAL | 部分证据（例如后端有断言、界面未点） |
| NOT RUN | 尚未执行 |
| FAIL | 实际不符合预期 |

我不会把"自动化 PASS"写成"实机 PASS"，也不会替你把 QA 结果转成正式环境结论。

---

## 7. 本轮（DEV-05-FIX）的验收步骤

### A. 预置场景：完成事件下钻（S3 复测）

1. 启动（第 5 节命令）。
2. 左侧点「工作台」，看「本月完成次数」应为 **3**。
3. 点这张卡片 → 跳到「历史统计」并滚到「完成事件明细」。
4. 应该看到 **3 条**事件，其中两条属于「双完成演示稿」（AF-2026-0001）。
5. 点第一条「查看订单」→ 右侧详情标题必须是 **双完成演示稿**（不是列表第一张）。
6. 返回，点另一条同订单事件 → 仍应打开 **双完成演示稿**。
7. 再点「零元友情稿」那条 → 详情应变为 **零元友情稿**。
8. 反例：把地址栏改成 `#/orders?orderId=not-exist` 回车 → 应显示「订单不存在」，
   且**不应**自动显示别的订单。

**正确结果**：每次点击后详情标题 = 该事件所属订单；同一订单两条事件打开同一张订单；
伪造 ID 得到明确错误。

### B. 从零流程：新建订单用默认模板

1. 左侧点「订单」→「新建」。
2. 只填标题（例如「QA 新建检查」），其它留空。
3. 点「创建订单」。
4. 打开该订单详情，看阶段列表：必须是默认模板的 **5 个阶段**
   （草稿 / 线稿 / 固有色 / 细化 / 最终调整），第一个为当前阶段。
5. 编号应为 `AF-2026-0008`（QA 根内的新编号，与正式编号无关）。

**正确结果**：新单阶段 = 5 个默认阶段；编号在 QA 根内递增。

> 顺带观察：本轮没有「制作流程」下拉。按单选择模板仍是**待产品决策项**
> （见 `DEV05-FIX-RESULTS.md` 第 4 节与 `REMAINING-WORK.md` #20），
> 因此这里只验证"默认模板"这一条。

### 不需要你做的事

- 不需要手动造完成事件（预置好了）。
- 不需要重复建单（只有 B 一次）。
- 不需要准备图片（预置了 3 张）。

---

## 8. 已知限制

1. **窗口像素无法自证**：本机 `osascript` 无辅助访问（-1728），`screencapture` 取不到窗口，
   所以横幅是否真的画出来只能由你确认。
2. **QA 只解决数据隔离**，不解决"程序版本隔离"：QA 与正式用的是同一个安装/同一份源码。
3. **不自动重置**：每次启动都是同一套数据；只有 `--reset` 才会重建。
4. **附件夹具是生成的纯色块**，不覆盖真实大图、EXIF 旋转、超大图边界。
5. **WebP 依赖 `image` 特性**：编码不可用时会少一张，预置结束后终端会打印实际导入张数。
6. **QA 根位置固定写死在你指定的路径**，不提供多套并行沙箱（多套需要多个 `--root`，
   机制本身支持，只是本轮没建）。

---

## 9. 出问题怎么报

请提供这四样（缺哪样我就只能猜）：

1. 终端里 `[minidesk] env ready …` 那一整行（确认是否 `mode=qa`、`path=` 是否 QA 根）。
2. 出问题的页面名 + 你点了哪个按钮 + 屏幕上出现的文字。
3. 期望结果 vs 实际结果各一句话。
4. 如果可以，截图（我没有录屏权限，截图对我帮助最大）。

停止应用后再执行：

```bash
pgrep -fl artflow-minidesk        # 应无输出
ls -a /Users/rinto/ArtFlow-miniDesk-QA
```

---

## 10. 与正式数据的边界（不可逾越）

- 正式数据目录：`~/Library/Application Support/dev.artflow.minidesk`，
  QA 机制**只读不写**，且启动前就用路径检查把它排除在候选之外。
- QA 根：`/Users/rinto/ArtFlow-miniDesk-QA`，可随时整体删除。
- 旧 ArtFlowDesk Web 工程、TV-01/TV-03 实验工程与数据库：本机制不涉及、也不修改。
