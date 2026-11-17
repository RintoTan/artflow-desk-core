# DEV-04 本地图片附件管理 — 结果报告

- 日期：2026-11-17
- 工程：`/Users/rinto/Documents/ChatGPT/ArtFlow-miniDesk`
- 结论：导入、缩略图、列表/查看、移除、校验、修复全部落地，**Rust 210 / 前端 46 个测试通过**；
  **界面操作未经我验证**（无辅助功能与录屏权限），需要用户实机确认。

> **关于本次指令**：收到任务的文本在第 3 节末尾被截断
> （"对于超限、无法解码、格式不匹配、截断文件和伪…" 之后缺失）。
> 我按冻结规格 D-00-15 / D-00-16 / FIX-11 补齐了其余实现范围，并在第 12 节列出
> **我自行判断的地方**，请 ChatGPT 核对是否与原意一致，不一致我再改。

---

## 1. 执行摘要

| 目标（本任务第 2 节） | 状态 |
|---|---|
| 1 系统文件选择器导入 | 已实现（`plugin-dialog` 多选） |
| 2 原图复制到受管目录 | 已实现（代际目录内 `attachments/originals/`） |
| 3 元数据与订单关联 | 已实现（`attachments` 表，v1 已有） |
| 4 自动生成可重建缩略图 | 已实现（WebP，最长边 480） |
| 5 订单详情展示网格 | 已实现 |
| 6 点击查看大图 | 已实现（缩放/平移/前后切换/Esc） |
| 7 从订单移除 | 已实现（确认 + 清理任务） |
| 8 缺失/损坏识别与修复 | 已实现（校验 + 重新选择原图） |
| 9 文件与元数据可恢复一致 | 已实现（先落文件后写行；移除先登记任务） |
| 10 兼容 DEV-07 备份模型 | 已满足（相对路径 + SHA-256 + 单库元数据） |

**没有 schema 迁移。** `attachments` 表在 v1 就已完整，本轮只新增代码。

---

## 2. 工程与数据状态

| 项 | 值 |
|---|---|
| 起始 HEAD | `618e8be`，工作区干净 |
| 分支 | `master`，未推送 |
| 应用标识 | `dev.artflow.minidesk` |
| 数据代际 | 2 个（与 DEV-03-FIX 结束时一致，未新增） |
| schema | v2（未变） |
| 用户数据 | 3 个订单 / 1 个客户 / 1 个模板全部保留 |

---

## 3. 数据模型（为什么不需要迁移）

`attachments`（v1 已存在）字段与本轮需求一一对应：

| 需求 | 字段 |
|---|---|
| 原始文件名 | `original_name` |
| 展示名称 / 备注 / 分类标签 | `display_name` / `note` / `tag` |
| 可移植相对路径 | `rel_path`（唯一）、`thumb_rel_path` |
| 完整性 | `sha256`、`byte_size` |
| 尺寸 | `width` / `height` |
| 原图状态 | `state ∈ {ok, missing, corrupt}` |

缺失/损坏状态用 `state` 表达，不需要新表。**没有为了版本号好看而造迁移。**

---

## 4. 导入管线与校验

`media/import.rs::read_and_validate`，顺序严格：

```text
1. 元数据：必须是普通文件、非空、≤ 100 MB（超限在读文件之前就拒绝）
2. 读字节 → image::guess_format 按**魔数**判断真实格式（忽略扩展名）
3. 只不认识 PNG/JPEG/WebP → 拒绝
4. 只读文件头拿尺寸 → check_dimensions（单边 ≤ 20000，总像素 ≤ 6000 万）
5. 用带 Limits 的解码器真正解一次（挡住截断/损坏/伪装文件）
6. 计算 SHA-256 → 落盘 → 写元数据
```

落盘顺序：**先写原图临时文件 → rename 到最终名 → 生成缩略图 → 插入元数据行**。
若插入失败，立刻删除刚写的原图与缩略图，不留孤立行；若缩略图失败，元数据仍写入但
`thumb_rel_path` 为 NULL（可后续重建），**不因为缩略图失败而丢掉原图**。

批量导入逐张独立处理，返回 `ImportOutcome[]`：成功/失败数量与每张的错误原因都会回到界面，
成功的照常保留。

---

## 5. 缩略图

- `media/thumb.rs::render_webp`：最长边缩到 480，Lanczos3 重采样，编码 WebP。
- 只读原图字节，**不修改原图**。
- 可重建：`attachment_rebuild_thumbs` 对每张图检查缩略图是否已存在且非空，有则跳过（幂等），
  没有才重建；原图缺失时记失败但**不删原图、不删元数据**。

---

## 6. 移除与清理任务

`attachments::remove`：

```text
BEGIN IMMEDIATE
  为原图与缩略图各插一条 cleanup_tasks（pending, reason=attachment_removed）
  DELETE FROM attachments
COMMIT
然后逐条删除文件，成功则把任务标 done 并累加 attempts
```

崩溃在提交之后、删文件之前 → 任务保持 pending，下次可重试（FIX-05 的机制）。
删除失败不会把已删的元数据"复活"，也不会假装成功。

跨订单隔离：`attachments.order_id` 外键 + 删除只按 `attachment_id`，有测试覆盖
"删甲的图不影响乙的图与原图文件"。

---

## 7. 校验与修复

- `attachment_verify(order_id)`：逐张检查文件存在性与 SHA-256，
  把 `state` 更新为 `ok / missing / corrupt` 并落库，返回 `{ok, missing, corrupt, attachments}`。
- `attachment_repair(attachmentId, sourcePath)`：用一张新的有效图片替换原图内容，
  **附件 ID 与相对路径不变**（所以订单关联、备份引用都不受影响），
  同时更新 sha/size/尺寸/MIME 并重建缩略图。
- `attachment_update_meta`：改展示名称/备注/标签；原始文件名永不改变。

---

## 8. 界面

订单详情新增「参考图片」面板（位于「资料」之后、「制作流程」之前）：

- 缩略图网格（4:3 裁剪、`object-fit: cover`），缺失/损坏的卡片用危险色边框 + 状态徽章。
- 「导入图片」（多选，过滤 png/jpg/jpeg/webp）、「校验」、「重建缩略图」。
- 点击缩略图打开查看器：缩放（按钮 + 滚轮）、拖动平移、上一张/下一张、适应、Esc 关闭；
  底部可编辑展示名称/标签/备注并保存；可「替换原图」或「移除这张」。
- 移除走 `ConfirmDialog`（默认焦点取消、Esc 取消、处理中防重复提交）。

图片通过 Tauri `asset` 协议加载：`tauri.conf.json` 开启
`assetProtocol.enable = true`、`scope = ["$APPDATA/**"]`，CSP 允许 `asset:` 与
`http://asset.localhost`。`Cargo.toml` 的 tauri features 相应加入 `protocol-asset`。

---

## 9. 命令白名单（40 项）

本轮新增 7 项，全部登记并通过负向测试：

```text
attachment_list            attachment_verify
attachment_import          attachment_rebuild_thumbs
attachment_remove          attachment_repair
attachment_update_meta
```

仍然是「独立维护的批准清单 + 精确比对 + 未知命令注入必失败」。

---

## 10. 测试

```text
cargo test        → 210 passed / 0 failed（新增 16）
npm run test      → 46 passed（新增 6）
npx tsc --noEmit  → 通过
npm run build     → built in 90ms
```

`tests/attachments.rs`（16）：

1. PNG 导入：原图逐字节一致、SHA-256 相同、缩略图 ≤480 且为 WebP
2. JPEG 与 WebP 都可导入，MIME 正确
3. 内容检测优先于扩展名（PNG 存成 .jpg 仍按 PNG 处理）
4. 截断 / 非图片 / GIF / 空文件全部拒绝，且**不留元数据**
5. 单边超 20000 像素 → 拒绝，提示含"像素/尺寸"
6. 超过 100 MB → 读文件前就拒绝（用稀疏文件，不产生真实大文件）
7. 批量导入部分失败 → 成功的保留、失败的逐项报错
8. 移除：原图与缩略图删除、元数据删除、清理任务标记 done
9. 跨订单隔离：删甲不影响乙的文件与元数据
10. 校验：缺失 / 损坏 / 正常三种状态识别并落库
11. 修复：缺失后可替换，ID 与路径不变、哈希更新、尺寸更新
12. 重建缩略图：只补缺失、第二次全部跳过（幂等）
13. 原图损坏时缩略图失败：原图与元数据都保留
14. 元数据编辑（展示名/备注/标签）与长度校验
15. 落库路径是可移植相对路径，且位于代际目录内
16. 未知订单导入 → `NOT_FOUND`

`src/components/AttachmentPanel.test.tsx`（6）：空状态、网格与尺寸、缺失徽章与修复入口、
移除确认可取消、确认后真正调用删除、查看器打开与 Esc 关闭。

---

## 11. 未验证 / 未实现

1. **整个图片 UI 我没有点击验证过。** 导入对话框、缩略图渲染、查看器缩放/平移、
   移除确认、修复流程，全部只有自动化测试覆盖（jsdom），**没有真实窗口证据**。
2. **asset 协议加载是否在真实 WKWebView 里正常显示**，只有启动检查（窗口正常、无崩溃），
   没有肉眼确认图片确实显示出来。这是本轮最需要你确认的一项。
3. 未实现拖拽文件到窗口导入（D-00-15 提到"拖拽导入"，本轮只做了文件选择器）。
   原因：Tauri 的 `dragDropEnabled` 与前端事件的关系需要单独验证，且上一轮刚因它踩过坑。
4. 未实现"按标签筛选/分组"，只有标签字段本身。
5. 未做图片顺序调整（网格按导入时间排序）。
6. 缩略图为有损 WebP（image crate 默认参数），未调质量参数。

---

## 12. 我自行判断的地方（因指令截断）

第 3 节之后的原文缺失，以下几条是我按冻结规格做的判断，请核对：

1. **缩略图格式**：选用 WebP（沿用 DEV-01 `media` 常量与 TV-03 实验结论），
   而非 PNG/JPEG。若你要求无损，需换编码器并改扩展名。
2. **缩略图尺寸**：沿用既有 `THUMB_EDGE = 480`。
3. **像素上限**：沿用 DEV-01 的 `MAX_IMAGE_EDGE = 20000`、`MAX_IMAGE_PIXELS = 6000 万`。
4. **移除语义**：删除原图与缩略图文件（不可撤销），而不是只解除关联。
5. **坏图处理**：`state` 只做三态（ok/missing/corrupt），没有"部分可用"。
6. **批量导入**：单张失败不影响其它张，不做整批回滚。
7. **拖拽导入未做**：见 11.3。

---

## 13. 隔离核验

| 对象 | 结果 |
|---|---|
| 正式应用数据 | 3 订单 / 1 客户 / 1 模板保留；代际 2 个未变；schema v2 未变；`attachments` 0 行 |
| 旧 ArtFlowDesk Web 工程 | 未触碰 |
| TV 实验工程与数据库 | 未触碰 |
| 测试数据 | 全部 `tempfile` 临时目录 + jsdom，不接触真实数据目录 |

启动实测：

```text
[minidesk] env ready generation=gen-e05d7ce… schema=v2 first_run=false tz=Asia/Shanghai
窗口: WIN 35950 owner=artflow-minidesk 1120×760 @ (400,103)
```

---

## 14. 需要用户验证（约 3 分钟）

1. 打开任一订单 → 「参考图片」→「导入图片」→ 选 1～2 张 PNG/JPG。
2. **确认缩略图真的显示出来**（这一项最关键，涉及 asset 协议）。
3. 点缩略图 → 查看器能否缩放、拖动、左右切换、Esc 关闭。
4. 在查看器里改「展示名称」并保存 → 回到网格看名称是否变化。
5. 点「移除」→ 确认框（默认焦点在取消）→ 取消不删，确认后消失。
6. 到数据目录 `generations/<gen>/attachments/originals/` 确认原图文件存在；
   手动删掉其中一张 → 回应用点「校验」→ 应显示「原图缺失」，并可用「重新选择原图」修复。

---

## 15. Git

```text
feat(media): image validation, webp thumbnails and asset protocol
feat(domain): attachment import, list, remove, verify, repair and meta editing
feat(commands): attachment surface (40 total)
feat(ui): attachment grid, image viewer and repair flow
test: attachment coverage (16 rust + 6 frontend)
docs: DEV04 results
```

未推送远程。未进入 DEV-05。
