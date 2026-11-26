# 下一阶段开发基线（自 v0.1.2 起）

给接手的人或 AI：先读这一页，再动代码。基线提交 `4a31eb3`，tag `v0.1.2`，schema v14。

---

## 一、技术栈与目录

- **外壳**：Tauri 2（Rust）+ React 19 + TypeScript + Vite；样式是原生 CSS + Arctic Blue 设计令牌，没有 UI 框架。
- **数据**：本地 SQLite（rusqlite，bundled 3.54.1），代际目录 + `state/active.json` 指针；软删除 + `vis_*` 视图做可见性。
- **前端**
  - `src/pages/` 页面；`src/components/` 组件；`src/lib/` 纯函数（排序、格式化、拖拽判定等，优先往这里沉淀可测逻辑）
  - `src/bridge/commands.ts` 是**唯一** IPC 出口，所有 `invoke` 都集中在此；新增命令必须同步这个文件
- **后端**
  - `src-tauri/src/commands/` 命令层（薄，只做参数与状态装配）
  - `src-tauri/src/domain/` 领域逻辑（orders / clients / attachments / client_attachments / trash / finance 等）
  - `src-tauri/src/store/` 迁移、路径、可见性、高水位
  - `src-tauri/src/infra/` 启动、单实例、锁、自启动
- **测试**
  - 前端：`src/**/*.test.tsx`（Vitest + Testing Library）
  - 后端：`src-tauri/tests/*.rs`（集成）+ 模块内 `#[cfg(test)]`

## 二、数据库

`APP_SCHEMA_VERSION = 14`。迁移链在 `src-tauri/src/store/migrations/`，每次版本 +1，**不允许跳过编号**。

近期结构：

| 版本 | 内容 |
| --- | --- |
| v8 | 软删除 + `vis_*` 视图 |
| v9 | `orders.archived_at` |
| v10 | 财务三表（平台 / 付款计划 / 收款流水） |
| v11 | STRICT 重建 |
| v12 | 退款表 |
| v13 | `orders.pinned_at` |
| v14 | `client_attachments`（客户参考图，独立归属） |

新增表时同步：`require_tables` 的版本门（`store/environment.rs`）、迁移清单连续性断言（`tests/migration_v9.rs`）、命令白名单（`tests/commands.rs`）。

## 三、两条必须遵守的边界

1. **可见性**：读走 `vis_*` 视图；按 id 写走 `visibility::require_visible_order` / `require_visible_client`。`tests/sql_visibility_lint.rs` 会扫描直连基表的查询。
2. **命令白名单**：任何新 `#[tauri::command]` 都要加进 `tests/commands.rs` 的 `APPROVED`，否则测试直接红。

## 四、附件与图片

- 订单附件：`attachments` 表（归属订单），文件在 `attachments/originals/`、`attachments/thumbs/`。
- 客户参考图：`client_attachments` 表（归属客户），文件在 `attachments/originals/clients/<客户ID>/`、`attachments/thumbs/clients/<客户ID>/`。
- 两者共用同一棵受管目录树，所以备份、恢复、完整性校验、隔离区天然覆盖；**不要**把客户图放进订单目录，也不要给 `attachments` 加 `client_id` 把归属混在一张表。
- 列表封面：`attachment_covers`（订单）、`client_ref_covers`（客户），一次批量查询，禁止逐行请求。

## 五、测试与构建命令

```bash
npx tsc --noEmit
npx vitest run

# 完整 Rust 测试必须带 devtools，否则三组探针用例是被跳过而不是通过
cargo test --manifest-path src-tauri/Cargo.toml --features devtools --no-fail-fast

# 正式包（只出 .app）
npm run tauri build -- --bundles app
```

开发 CLI（`minidesk-probe` / `attachments-probe` / `qa_seed`）挂在 `devtools` 特性下，不加特性不会构建、也不会进包。

## 六、发布流程（已验证可行）

1. 全量测试 + `tsc` + `npm run build`；
2. `npm run tauri build -- --bundles app` → zip → `SHA256SUMS.txt`；
3. 推送 master；
4. `gh workflow run windows-build --ref master`（GitHub Actions 原生 `windows-latest`，不要在本机折腾 `cargo xwin`）；
5. 下载 Production artifact，核对 EXE 文件名/大小/SHA-256；
6. Tag 与 master 对齐后 `gh release upload v0.1.2 <files> --clobber`。

**发布构建必须来自干净提交**：工作区有改动时前端构建标识会带 `-dirty`。

## 七、当前遗留（下一阶段开工前必须知道）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| macOS 正式包实机启动 | 未验收 | 启动会迁移生产数据根（v13 → v14），需产品负责人执行 |
| Windows 真机安装/验收 | 未验收 | 仅 CI Runner 冒烟（两轮启停、11 项检查） |
| 截图 | 未交付 | `docs/assets/screenshots/0.1.2/` 为空；采集脚本需修窗口串扰后再拍 |
| 恢复备份后界面看图 | 未验证 | 只证到文件层 |
| 880×500 / 深色观感 | 未验证 | 无新一轮实机截图 |

## 八、冻结功能（不要顺手实现）

1. 时间线同月堆叠 4 行 + `+N`
2. 登录后默认页面设置
3. 自动定时备份
4. 备份包加密
5. 旧代际清理入口

另有：设置页「接单平台与手续费」版式未重做（功能已完整）；存储用量统计未实现；救援模式（P2）未做。

## 九、下一阶段建议顺序

1. 补 macOS 实机验收与截图（发布工程的尾巴，先关掉）；
2. 从产品功能缺口里挑一项，按「先核查 → 明确范围 → 实施 → 定向测试 → 记录实机待验」推进；
3. 每次改动只跑相关用例，发布前再统一全量。

## 十、这轮踩过的坑（省下一次重蹈）

- `tauri build` 用 `--bins`，会把 `target/release` 下所有可执行文件拷进 `.app`；排除只能靠 `required-features`，不能靠事后删。
- `CreateFileW` 的 `htemplatefile` 是 `HANDLE`（`*mut c_void`），要 `null_mut()`；这类错误只有原生 Windows 构建能暴露。
- WKWebView 会缓存 `http://127.0.0.1:1421/` 的 `index.html`，本地取图必须加 `?v=` 破缓存。
- 主题取值是 `arctic` / `dark`，不是 `light`；传错会被静默拒绝，界面停在旧主题。
- 截图前必须确认上一个实例已退出，否则单实例锁会让新进程直接激活旧窗口，`screencapture` 抓到的是上一张。
