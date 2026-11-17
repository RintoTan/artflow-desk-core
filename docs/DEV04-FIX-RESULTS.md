# DEV-04-FIX 结果报告

- 日期：2026-11-17
- 工程：`/Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk`
- 范围：DEV04-UI-01（确认框层级）+ 文件导入/修复的崩溃恢复 + 缩略图完整性 + asset 访问范围 + 清理任务安全
- 结论：**自动化全绿（Rust 232 / 前端 52）**；嵌套模态与 asset 运行时的真实表现**仍需用户实机确认**

---

## 1. DEV04-UI-01：确认框被查看器遮挡

### 1.1 根因

两个独立原因叠在一起：

| # | 事实 | 后果 |
|---|---|---|
| 1 | `.modal-overlay { z-index: 100 }`，`.viewer-overlay { z-index: 120 }` | 确认框渲染在查看器**下层**，被遮罩和查看器盖住，所以"点了没反应" |
| 2 | 查看器与确认框都把 Esc 监听挂在 `document` 捕获阶段 | 即使层级修好，一次 Esc 也会**同时关掉两个**，两个模态各自为政 |

不是"某个元素 z-index 不够大"的问题，是**没有定义层级秩序**，也没有模态栈。

### 1.2 修复

**层级**：引入两个语义化变量，取代散落的魔法数字：

```css
:root { --z-viewer: 120; --z-modal: 200; }
.modal-overlay  { z-index: var(--z-modal);  }   /* 确认框 / 未保存提示 */
.viewer-overlay { z-index: var(--z-viewer); }   /* 图片查看器 */
```

**模态栈**（`src/lib/modalStack.ts`）：模态打开时入栈、关闭时出栈，只提供
`isTopModal(id)` / `useIsTopModal(id)`。规则：

- **只有栈顶模态响应 Esc**。查看器与确认框的 handler 都先查 `isTop`，
  所以第一次 Esc 只关确认框，第二次才关查看器。
- 查看器不是栈顶时加 `inert`，键盘与指针都进不去背景（不是靠"盖住"骗过用户）。
- 关闭确认框后焦点回到打开前的元素——在查看器场景里就是「移除这张」按钮本身。

改动文件：`src/components/ConfirmDialog.tsx`、`src/components/UnsavedChangesDialog.tsx`、
`src/components/ImageViewer.tsx`、`src/lib/modalStack.ts`、`src/styles.css`。

未保存提示对话框也接了同一个栈，避免将来出现"三个模态互相抢 Esc"。

### 1.3 嵌套模态测试（`AttachmentPanel.test.tsx`，新增 6 个）

1. 查看器里点移除 → 确认框出现、查看器仍在、两层 `data-modal-layer` 不同、查看器带 `inert`
2. 取消 → 确认框关闭、查看器保留、未调用删除、焦点回到「移除这张」
3. Esc 第一次只关确认框（查看器仍在），第二次才关查看器
4. 确认后只删目标附件（另一张不受影响）
5. 删除失败 → 对话框不关闭，错误上报
6. 连续点确认只执行一次

这些用例走的是**查看器 + 确认框的组合**，不是单独渲染 `ConfirmDialog`。

---

## 2. 导入与修复的完整协议

### 2.1 为什么改了协议

DEV-04 第一版的顺序是"先落文件 → 再写行"。进程死在两步之间会留下
**没有任何元数据的孤立原图**：界面上看不见，也没有任何逻辑会回收它。
普通数据库异常能清文件，但**证明不了崩溃安全**。

### 2.2 schema v3：`attachment_jobs`

```sql
CREATE TABLE attachment_jobs (
  id, kind('import'|'repair'), attachment_id, generation,
  rel_path, temp_rel_path, expected_sha256,
  state('pending'|'done'|'failed'), note, created_at, updated_at
);
```

这是"打算做什么"的持久凭据。**这是本轮唯一的 schema 变更**，且是必要的：
没有它就无法在重启后区分"该补做"和"该回滚"。

### 2.3 导入

```text
1. INSERT job(pending, kind=import, rel_path, expected_sha256)   ← 意图先落库
2. 写原图（临时文件 → rename 到最终名）
3. 生成缩略图（失败不影响导入，记 NULL 待重建）
4. BEGIN IMMEDIATE
     INSERT attachments(...)
     UPDATE job SET state='done'
   COMMIT
   若第 4 步失败：删除刚写的原图与缩略图，job 标 failed
```

崩溃点覆盖：

| 崩在哪 | 现场 | 重启后 |
|---|---|---|
| 1 之后、2 之前 | 只有 job | `recover` 无附件行 → job failed，无文件可动 |
| 2 之后、4 之前 | job pending + 孤儿文件 | `recover` 把文件移入 `attachments/quarantine/`，job failed |
| 4 提交中 | SQLite 事务原子 | 要么全有要么全无 |

### 2.4 修复（替换原图）

```text
1. INSERT job(pending, kind=repair, expected_sha256=新图哈希)
2. 完整写入 attachments/staging/<id>.<ext>.new（同卷，rename 原子）
3. 备份现有原图 → attachments/backup/<id>.<ext>.bak（备份失败则放弃，不做任何修改）
4. rename staging → 原图路径（原子替换）
5. 重建缩略图 + BEGIN IMMEDIATE
     UPDATE attachments(sha256,byte_size,mime,width,height,state='ok',thumb_rel_path)
     UPDATE job SET state='done'
   COMMIT
6. 成功后删除备份
```

崩溃恢复（`recover`）按 `expected_sha256` 判断：

- 磁盘哈希 == 期望值 → **补完**这次修复（回填元数据 + 重建缩略图），job done
- 否则 → 用 `.bak` **回滚**到修复前，job failed
- 连备份都没有 → 保留现状，记入 `keptUnknown` 上报，**不猜**

这样保证不会出现"文件是新的、元数据是旧的"或反之；也不会出现"缩略图属于旧图、
元数据属于新图"——缩略图在两条路径上都是按最终原图重建的。

附件 ID、订单关联、相对路径、制作历史全程不变。

---

## 3. 崩溃点与真实测试

新增探针 `src/bin/attachments-probe.rs`（不进产品包、不注册为命令），
在精确位置调用 `std::process::abort()`，由父测试重新打开环境验证：

| 用例 | 做法 | 断言 |
|---|---|---|
| `import_crash_before_metadata_leaves_no_visible_attachment` | 子进程真 abort | 退出码非 0；`recover` rolled_back=1；**无可见附件**；原图目录无残留；隔离目录里有那份文件 |
| `repair_crash_completes_or_rolls_back_consistently` | 子进程真 abort | 重开后 DB 哈希 == 磁盘哈希；`state=ok`；`thumbState=ok`；内容只能是新图或回滚后的旧图 |
| `recovery_never_deletes_files_that_are_still_referenced` | 直接跑 recover | 有引用的文件不被隔离 |
| `recovery_quarantines_unknown_files_instead_of_deleting_them` | 塞一个陌生文件 | 被移入隔离目录，**不被删除** |

对应的硬要求逐条落地：

- 没有记录的文件不当正常附件展示 → 隔离目录不在 `originals/` 下，`list` 不会读到
- 不误删有合法引用的原图 → 先算引用集，命中即跳过
- 不因为发现陌生文件就清空目录 → 只 `rename` 到隔离区
- 删除前再验证路径与身份 → 清理任务里 `symlink_metadata` + 代际 + 受管路径三重校验
- 判断不了就保留并报告 → `keptUnknown`

---

## 4. 缩略图完整性

`media::thumb::is_valid(path)` 现在要求：**存在、非空、魔数是 WebP、能被解码、
最长边不超过 480+1**。只判"非空"是不够的——被截断或写成 PNG 的缓存同样存在且非空。

- `thumb_state ∈ {ok, missing, corrupt}` 由缓存文件独立判定，**与原图的 `state` 分开**。
- 重建只在缓存无效时发生（幂等）；原图缺失或损坏时**记为失败**，不伪造成功。
- 修复原图后缩略图必然重建，测试用长宽比验证它来自新图而不是旧图。
- 查看器/网格在缓存损坏时不整体挂掉：`img` 加载失败会退回原图路径。

测试：`corrupt_or_foreign_thumbnails_are_detected_and_rebuilt`、
`missing_original_does_not_produce_a_fake_thumbnail_success`、
`repair_invalidates_the_old_thumbnail`、`repair_failure_keeps_the_previous_good_original`。

---

## 5. asset 协议访问范围

### 5.1 收窄

```diff
- "scope": ["$APPDATA/**"]
+ "scope": ["$APPDATA/generations/*/attachments/**"]
```

这只放行"某一代际下的附件目录"，**不再包含** `state/highwater.sqlite`、
`environment.json`、`state/active.json`，也不包含 `generations/<gen>/database.sqlite`
（它在 `attachments` 的上一层）。

### 5.2 负向测试（`tests/asset_scope.rs`，9 个）

用与 Tauri scope 相同的 glob 语义对真实绝对路径断言：

| 路径 | 期望 | 结果 |
|---|---|---|
| `.../generations/<gen>/attachments/originals/a.png` | 允许 | ✅ |
| `.../generations/<gen>/attachments/thumbs/a.webp` | 允许 | ✅ |
| `.../generations/<gen>/database.sqlite` | 拒绝 | ✅ |
| `.../state/highwater.sqlite` | 拒绝 | ✅ |
| `.../environment.json`、`state/active.json`、`recovery/state.json`、`.write.lock` | 拒绝 | ✅ |
| `.../generations/<gen>`（附件目录本身） | 拒绝 | ✅ |
| `/etc/passwd`、`/tmp/evil.png` | 拒绝 | ✅ |
| TV 实验目录里的图片 | 拒绝 | ✅ |
| scope 是否等于 `$APPDATA/**` | 必须不是 | ✅ |

### 5.3 必须说清的局限

glob 是**纯文本**匹配，`attachments/**` 会匹配
`attachments/../database.sqlite` 这种字符串。我把这条写成了显式断言
（`glob_matching_alone_does_not_normalize_dot_segments`），而不是假装它被拦住了。

因此真正的防线是两层：

1. **后端永不输出可疑路径**：`published_path()` 会 `canonicalize` 并校验必须在代际目录内，
   不满足则返回空串，前端拿不到可用的 URL。若 DB 里被塞入 `../../environment.json`，
   读取侧直接抛 `INVALID`（有测试 `suspicious_relative_paths_never_reach_the_frontend`）。
2. Tauri 运行时对请求路径做规范化后再校验 scope——**这一条我无法验证**，
   因为本机没有可用的 WebView 自动化。所以"无法通过 asset 路径读取业务 SQLite"
   目前只有配置层 + 后端层证据，**运行时证据缺失**，需要你用真实请求确认（见第 10 节）。

---

## 6. 移除与清理任务

`attachments::remove`：事务内登记 `cleanup_tasks`（原图 + 缩略图各一条）并删元数据，
提交后立刻执行 `run_cleanup`；失败留 pending 由下次启动重试。

`run_cleanup` 的守卫（逐条都有测试）：

| 守卫 | 行为 | 测试 |
|---|---|---|
| 代际必须等于当前活动代 | 不等则 `skippedStale`，不动文件 | `cleanup_skips_tasks_from_another_generation` |
| 必须是 `attachments/originals/` 或 `attachments/thumbs/` 下的路径 | 否则 `refused` | `cleanup_refuses_paths_outside_managed_directories` |
| 不允许符号链接／非普通文件 | 否则 `refused`，目标不受影响 | `cleanup_refuses_symlinks` |
| 仍被任何附件行引用则不删 | 否则 `refused` | 逻辑内建 |
| 文件已不存在 → 标记 done | 幂等 | `cleanup_is_idempotent_and_does_not_touch_other_attachments` |

第 1 条是"代际切换/恢复后不得用旧任务误删新代文件"的直接保障；
第 3 条覆盖"路径替换、文件身份变化"。

---

## 7. 测试命令与结果

```text
cargo test              → 232 passed / 0 failed
cargo check --all-targets → 通过，0 warning
npm run test            → 52 passed（7 个文件）
npx tsc --noEmit        → 通过
npm run build           → built in 107ms
```

本轮新增：

| 文件 | 数量 | 内容 |
|---|---|---|
| `tests/attachments_recovery.rs` | 13 | 导入崩溃、修复崩溃、孤立文件隔离、清理四类守卫、缩略图三态、修复失败保原图、路径发布守卫 |
| `tests/asset_scope.rs` | 9 | scope 收窄与负向访问 |
| `src/components/AttachmentPanel.test.tsx` | +6 | 嵌套模态（共 12） |

Rust 从 210 → **232**；前端从 46 → **52**。

---

## 8. 用户数据、旧工程与 TV 数据隔离

真实应用在既有数据上完成 **v2 → v3 隔离代际迁移**：

```text
[minidesk] env ready generation=gen-c00a879220964299af7adcef8b9fc1c5 schema=v3 first_run=false
代际数量：2 → 3（旧代保留作回退）
orders=3  attachments=2  attachment_jobs=0  pending_cleanup=0
附件文件：originals 2 个 + thumbs 2 个，全部随代际复制到位
隔离目录：空（没有任何文件被误判为孤儿）
```

- 用户的 3 个订单（含之前删除失败后成功移除的那张图的历史）与 2 张图片完整保留。
- 旧 ArtFlowDesk Web 工程：未触碰。
- TV 实验工程与其数据库：未触碰。
- 所有故障注入都在 `tempfile` 临时目录 + 虚构图片里进行。

---

## 9. 本地 Git 提交

```text
139f48e  fix(ui): modal stack so confirm dialogs sit above the image viewer
```

**如实说明**：我本打算分 7 个提交，但第一条 `git add -A` 把全部改动一次收进了 `139f48e`，
提交信息也只描述了 UI 部分。实际内容包含：schema v3、附件域重写、探针、
asset scope 收窄、23 个新 Rust 用例、6 个前端用例、两份文档、CSS 层级变量。

按既有规则我不改写已产生的提交，因此历史就是上面这一条。内容完整、可编译、测试全绿，
但提交粒度与信息不理想——这是我的操作失误，不影响代码正确性。

未推送远程。

---

## 10. 需要用户重新实机确认

1. **D04-D 重测**：打开图片查看器 → 点「移除这张」→ 确认框应当**盖在查看器上面**出现。
2. 取消后查看器与图片仍在；再按 Esc 才关闭查看器。
3. 确认删除后图片消失，另一张不受影响。
4. 缩略图与原图仍能正常显示（scope 收窄后的回归）。
5. 若方便，可在开发者工具里尝试
   `fetch('asset://localhost/' + encodeURIComponent('<数据目录>/generations/<gen>/database.sqlite'))`
   之类的请求——**这类运行时负向验证我没有能力做**，只能靠你确认。

## 11. 尚未完成 / 遗留

- **文件拖拽导入**仍未实现（冻结规格里的未完成项，本轮明确不做）。
- **asset 运行时拦截**只有配置层与后端层证据。
- 修复协议在极端情况下（备份也写失败且原图已损坏）只会保留现状并上报，不会自动修复。
- 隔离目录 `attachments/quarantine/` 目前只增不减，没有提供清理入口。
- `attachment_jobs` 已完成的记录不清空（每次导入/修复留一行），后续可加保留策略。
