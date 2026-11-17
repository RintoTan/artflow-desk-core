# QA 沙箱使用手册

- 适用范围：DEV-06～DEV-09 及以后所有实机验收。
- 实现说明与证据：见 `QA01-RESULTS.md`。
- 一句话：**QA 是一个独立的应用标识**，它有自己的数据目录，正式台账碰不到它。

---

## 1. 两套场景

| 场景 | 目录 | 内容 | 用来测什么 |
|---|---|---|---|
| **seeded**（预置） | `~/Library/Application Support/dev.artflow.minidesk.qa/seeded` | 12 张虚构订单、3 个客户、3 套模板、4 张附件、36 条事件 | 工作台、统计、下钻、列表筛选、到期提醒、附件查看 |
| **clean**（空白） | `~/Library/Application Support/dev.artflow.minidesk.qa/clean` | 空 | 首次启动、建单、建客户、建模板、导入第一张图、空状态 |

两套场景是两个目录，互不影响：在 clean 里建的单不会出现在 seeded 里。

正式应用的数据在 `~/Library/Application Support/dev.artflow.minidesk`，
与上面两个目录是**兄弟关系**，任何命令都不指向它。

---

## 2. 三条命令（复制到终端即可）

打开「终端」，先进入工程目录（只需一次）：

```bash
cd /Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk
```

### 2.1 启动预置场景

```bash
npm run qa:seeded
```

### 2.2 启动空白场景

```bash
npm run qa:clean
```

### 2.3 重建预置数据

```bash
npm run qa:rebuild
```

（重建只影响 `.../dev.artflow.minidesk.qa/seeded`，且该目录必须带 `.qa-root` 标记，
否则会拒绝执行。命令会打印它影响的目录与最终计数。）

想同时清理空白场景：

```bash
cargo run --manifest-path src-tauri/Cargo.toml --bin qa_seed -- --scenario clean --rebuild
```

### 2.4 首次使用前准备数据

仓库里已经预置好，通常**不需要**再跑。若要重新生成：

```bash
npm run qa:seed        # seeded 场景
npm run qa:seed:clean  # clean 场景（只建空目录）
```

---

## 3. 怎么确认自己真的在 QA 里

三条同时满足才算：

1. 终端有这一行：
   ```text
   [minidesk] env ready mode=qa scenario=seeded identifier=dev.artflow.minidesk.qa path=.../dev.artflow.minidesk.qa/seeded ...
   ```
2. 窗口**标题栏**写着「ArtFlow miniDesk — QA 测试环境」。
3. 窗口内顶部有琥珀色横幅「QA 测试环境（预置场景/空白场景）· 数据目录与正式应用完全隔离」。

侧栏副标题也会变成「QA 测试环境」，「数据环境」页第一行显示「运行模式：QA 测试环境 · 预置场景」。

> 三条缺一，就不要在那种状态下验收，按第 6 节报告。

---

## 4. 停止与清理

在运行的终端窗口按 `Ctrl + C`。确认没有残留：

```bash
pgrep -fl artflow-minidesk
```

有输出就 `kill <PID>`。

停止**不会删除任何数据**，下次启动还是同一套场景。

彻底清除 QA 数据（不影响正式台账）：

```bash
rm -rf "$HOME/Library/Application Support/dev.artflow.minidesk.qa"
```

---

## 5. 数据说明

### seeded 场景的 12 张订单

| 编号 | 标题 | 状态 | 金额 | 到期 |
|---|---|---|---|---|
| AF-2026-0001 | 双完成演示稿 | 已完成（完成两次，其中一次在 10 月） | 880 | 已过期 |
| AF-2026-0002 | 跨月完成稿 | 已完成（9 月创建、10 月完成） | 1200 | 无 |
| AF-2026-0003 | 制作中的加急稿 | 制作中（第 3/6 阶段） | 1500 | 今天 |
| AF-2026-0004 | 三天内交付的封面 | 排队中 | 450 | 2 天后 |
| AF-2026-0005 | 已逾期的线稿 | 排队中 | 300 | 3 天前 |
| AF-2026-0006 | 未排期的草稿 | 排队中 | **未知（NULL）** | 无 |
| AF-2026-0007 | 零元友情稿 | 已完成 | **0** | 昨天 |
| AF-2026-0008 | 已取消的企划 | 已取消 | 50 | 无 |
| AF-2026-0009～0012 | `=1+1` / `+1+1` / `-2+3` / `@SUM(1,2)` 注入样本 | 排队中 | 1 | 无 |

- 客户：`林小满`（两个不同 ID，同名不同人）、`陈叙`。
- 模板：默认「通用制作流程」5 阶段、「轻量三阶段」3 阶段、「六阶段加急」6 阶段。
- 附件：「制作中的加急稿」挂 4 张（PNG 横图 / JPEG 竖图 / WebP 宽图 / 小尺寸 PNG），
  全部由 `image` 库现场生成纯色块，不含任何真实作品。
- 时间口径：到期类按**工作时区（Asia/Shanghai）的今天**生成相对日期，所以永远"今天到期"；
  跨月订单的时间是**写死的**（2026-09 创建、2026-10 完成），用来验证金额按创建月份归属。

### 编号

QA 的编号高水位是独立的，从 `AF-2026-0001` 重新开始，与正式台账的编号无关。

---

## 6. 出问题怎么报

需要四样：

1. 终端里 `[minidesk] env ready ...` 那一整行。
2. 页面名 + 点了哪个按钮 + 屏幕上的文字。
3. 期望 vs 实际，各一句。
4. 截图（我没有录屏权限，截图最有帮助）。

然后执行：

```bash
pgrep -fl artflow-minidesk
ls -a "$HOME/Library/Application Support/dev.artflow.minidesk.qa"
```

---

## 7. 与正式数据的边界

- QA 使用独立应用标识 `dev.artflow.minidesk.qa`，数据目录由系统按标识分配，
  **不通过环境变量改路径**——正式版没有任何参数能改变它的数据目录。
- QA 场景名只接受 `seeded` / `clean` 两个值，输入路径会被拒绝。
- 启动时会检查：QA 根不得与正式目录等价、嵌套或经符号链接指向正式目录。
- 正式启动时若发现正式目录里有 QA 标记，会直接拒绝启动。
- 附件显示：QA 构建的 asset 协议 scope 只覆盖 `.../dev.artflow.minidesk.qa/{seeded,clean}/generations/*/attachments/**`，
  读不到正式附件。
