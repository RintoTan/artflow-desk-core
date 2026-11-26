# 0.1.2 开发清单与交付清单

状态截至 2026-11-26。本文只写**有证据**的结论；没有实机验证的一律标「未验证」。

---

## 一、开发完成清单

| 工作包 | 实现内容 | 主要代码位置 | 对应测试 |
| --- | --- | --- | --- |
| 01 新建入口 + 委托类型 | 新建按钮放大（`.orders-new-btn`）；七种预设 + 自由输入；标题按「客户 · 类型」生成且可手改；编辑可改类型 | `src/pages/OrdersPage.tsx`、`src/components/CommissionTypeField.tsx`、`src/lib/commissionType.ts` | `CommissionTypeField.test.tsx`、`commissionType.test.ts`、`OrdersPage.typeTitle.test.tsx` |
| 02 订单缩略图 | 批量封面查询；成品 → 参考图 → 占位三级回退；卡片/看板显示，表格不显示 | `src-tauri/src/domain/attachments.rs`（`covers`）、`src/components/OrderThumb.tsx` | `attachments.rs` 封面 3 例、`OrderThumb.test.tsx`、`OrdersPage.cover.test.tsx` |
| 03 客户参考图 | v14 独立表；文件落 `attachments/originals/clients/`；上传/拖拽、缩略图、看原图、删除确认；随备份走；客户清除前入队 | `src-tauri/src/domain/client_attachments.rs`、`src/components/ClientReferencePanel.tsx`、迁移 `v14.rs` | `client_attachments.rs` 10 例、`ClientReferencePanel.test.tsx` |
| 04 订单排序 | 四种展示排序 + 置顶分组；非手动模式禁用重排；不写回排队位置；看板回到平铺网格（模板 + 阶段筛选） | `src/lib/orderSort.ts`、`src/components/OrderBoard.tsx` | `orderSort.test.ts`、`OrderBoard.test.tsx` |
| 05 版本信息 | 左下角常驻入口；VersionDialog 复用 About 文案与构建元数据；渠道 / 发布标记 / 版本三者分列 | `src/components/VersionDialog.tsx`、`src/App.tsx` | `VersionDialog.test.tsx`、`App.test.tsx` |
| 支撑 | 登录自启动（macOS LaunchAgent / Windows Run 键）；打包排除开发 CLI；单实例退出 panic 修复 | `src-tauri/src/infra/autostart.rs`、`Cargo.toml`、`lib.rs` | `autostart` 5 例、`commands` 白名单、`SettingsPage.autostart.test.tsx` |

### 明确未实现（冻结）

1. 时间线同月堆叠 4 行 + 超出合并 `+N`
2. 登录后默认页面设置
3. 自动定时备份
4. 备份包加密
5. 旧代际清理入口

设置页「接单平台与手续费」UI 重做未做（纯版式，功能已全部接通）。

---

## 二、交付清单

| 项 | 内容 | 状态 |
| --- | --- | --- |
| macOS 产物 | `ArtFlow-Desk-Core-0.1.2-macos-arm64.zip`（6.5 MB） | 已产出 |
| 校验文件 | `SHA256SUMS.txt`（`shasum -a 256 -c` 通过） | 已产出 |
| Windows 产物 | — | **未产出** |
| 发布说明 | `CHANGELOG.md` v0.1.2 段 | 已更新 |
| 发布指南 | `docs/releases/RELEASE-GUIDE.md` | 已新增 |
| 项目状态 | `docs/releases/PROJECT-STATUS.md` | 已更新到 v14 |
| 开发清单 | 本文第一节 | 已整理 |
| 截图 | `docs/assets/screenshots/*` 仍是旧版 UI | **待更新** |
| GitHub Tag / Release | — | **未执行**（需推送授权） |

---

## 三、验收状态（四分类）

### 已在 macOS 实机验证

- QA 开发窗口启动、页面交互目视（版本入口、缩略图、表单、看板、统计头部）。
- 真实 QA 数据根 v13 → v14 升级：代际切换、`user_version` 14、行数 151/53/18/167/3 前后一致。

### 仅自动化测试验证

- 缩略图三级回退与加载失败降级。
- 四种排序、置顶分组、空值沉底、临时排序不改排队位置。
- 客户参考图导入 / 隔离 / 删除清理 / 客户清除入队 / 备份清单。
- 客户参考图备份 → 恢复到新根 → 逐字节比对 + 缩略图成套。
- 版本弹窗字段来源（渠道 vs 发布标记 vs 版本；Schema 取实库版本）。
- 登录自启动的 plist 写入 / 删除 / 指向失效判定。

### 已构建但未实机验证

- `ArtFlow Desk Core.app` 没有启动过：启动会打开并迁移**生产数据根**，这一步留给用户执行。
- 首次打开的 Gatekeeper 流程（本机 Gatekeeper 评估被关闭，`spctl accepted` 不具代表性）。

### 完全未验证

- Windows 构建与运行。
- 880×500 与深色主题下的最终观感（只有代码与测试，没有新一轮实机截图）。
- 恢复备份后图片在界面中的实际显示。
- 安装包在干净机器上的首次打开体验。

---

## 四、已知限制

1. macOS 为 adhoc 签名、未公证；首次打开需右键「打开」。
2. Windows 无产物，无 CI 记录。
3. 截图与 README 展示图仍是旧版界面。
4. 看板只按「一个流程模板 + 阶段筛选」展示，不提供多模板并排分组。
5. 列表缩略图不支持在列表内直接放大原图（订单详情的附件查看器承担）。
6. 存储用量统计仍未实现（设计已冻结，无命令与界面）。
7. 结构校验失败时仍无救援模式（P2，此前裁定不做）。

---

## 五、本轮测试基线（2026-11-26 实跑）

| 命令 | 结果 |
| --- | --- |
| `cargo test --features devtools --no-fail-fast` | 723 passed / 0 failed |
| `npx vitest run` | 97 文件 / 955 passed |
| `npx tsc --noEmit` | 通过 |
| `npm run build` | 通过 |
| `npm run tauri build -- --bundles app` | 成功，`.app` 22.11 MiB |
