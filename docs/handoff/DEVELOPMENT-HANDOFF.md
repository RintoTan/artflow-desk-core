# 开发交接

**接手先读这一页，再动代码。** 读完大约 15 分钟；看不懂的地方先按 §三 把应用跑起来，再回来看。

| 项 | 值 |
| --- | --- |
| 应用 | ArtFlow Desk Core（独立画师的本地委托管理桌面应用） |
| 版本 / schema | `0.1.2` / **v14** |
| 发布状态 | `v0.1.2` 已发布（tag → `1935fb0`）；master 之后只有纯文档提交 |
| 栈 | Tauri 2 + React 19 + TypeScript + Vite + Rust + rusqlite（bundled SQLite） |
| 平台 | macOS 13+ (Apple Silicon) 本机构建；Windows x64 由 GitHub Actions 原生 Runner 构建 |
| 数据 | 单机 SQLite + 代际目录 + 附件文件树；无服务端、无账号、无遥测 |

---

## 一、角色与决策权

| 角色 | 谁 | 管什么 |
| --- | --- | --- |
| 产品负责人 | 用户 | 路线与优先级、功能规格、验收标准、产品口径裁定 |
| 开发执行 | 你 | 按已确认规格实现；px 取值、z-index、命名、测试写法自决 |
| 最终验收 | 用户 | 真机走查、体验拍板；**自动化 PASS ≠ 实机 PASS** |

必须上报的三类情况：与已确认规格冲突、触及已确认设计原则（见 [PRODUCT-DECISIONS](../product/PRODUCT-DECISIONS.md)）、不可逆或外部副作用（发版、覆盖 Release 资产、删数据）。

不允许做的两件事：把实现层的不确定性包装成「产品问题」抛回去；把没跑过的验证写成 PASS。

---

## 二、第一天：把应用跑起来

```bash
npm ci
npm run qa:seeded        # QA 沙箱 + 演示数据，日常开发就用它
```

正式 identifier 只用于打包。**不要拿 `npm run tauri dev` 试数据**——它会写正式数据目录并触发正式库迁移。

| 命令 | 作用 |
| --- | --- |
| `npm run qa:seeded` | QA 演示数据（客户 / 模板 / 订单齐全） |
| `npm run qa:clean` | QA 空白环境 |
| `npm run qa:timeline-empty` | 时间线空态（另有 `-unscheduled` / `-no-dates` / `-terminal`） |
| `npm run qa:seed` / `qa:rebuild` | 重灌 / 重建 seeded 场景 |
| `npm run dev` | 只起 Vite，纯前端调试（没有 Tauri 命令） |
| `npm run build` | `tsc --noEmit` + 生产构建 |
| `npm run layout:check` | 布局探针 |

三种 QA 场景的数据根互不覆盖；QA 与正式数据根也互不覆盖（identifier 与目录都不同）。

---

## 三、代码地图

```
src/                        前端（React SPA）
  pages/                    八个页面 + 回收站
  components/               订单、附件、财务、版本弹窗等
  lib/                      纯函数：排序、筛选、格式化、拖拽判定、统计口径
  bridge/commands.ts        唯一 IPC 出口，所有 invoke 都在这里
src-tauri/src/
  commands/                 命令层（薄：参数校验 + 状态装配 + 事务边界）
  domain/                   领域逻辑（orders / clients / attachments / client_attachments / trash / finance / backup）
  store/                    迁移、代际、路径、可见性守卫、高水位、时区
  infra/                    启动、单实例、锁、自启动、日志
src-tauri/tests/            集成测试（迁移、生命周期、备份、并发、跨平台）
```

新增前端逻辑优先落到 `src/lib/`（可测纯函数），不要在页面里堆判定。

---

## 四、数据层：先理解这四件事

1. **代际目录**：每次 schema 升级或备份恢复都新建 `generations/gen-<uuid>/`，`state/active.json` 原子切换，旧代际保留不自动删。
2. **删除是可见性**：`orders` / `clients` 的 `deleted_at` / `deleted_batch` 只表示「在回收站」，不改 `status`。所有读走 `vis_*` 视图。
3. **三层把关**：读 → 视图；按 id 写 → `visibility::require_visible_order` / `require_visible_client`；新查询 → `tests/sql_visibility_lint.rs` 拦截裸 `FROM orders` / `FROM clients`。豁免要登记并写理由。
4. **附件两棵树，一套受管目录**：订单附件在 `attachments/originals/`，客户参考图在 `attachments/originals/clients/<客户ID>/`。共用目录树是为了让备份、恢复、完整性校验、隔离区天然覆盖；**归属仍然是两张表**（`attachments` / `client_attachments`）。

---

## 五、八条硬规则

违反前六条会让测试直接红，后两条会让数据坏掉。

1. 任何新 `#[tauri::command]` 必须登记进 `tests/commands.rs` 的 `APPROVED`。
2. 迁移只能 `+1`，不能跳号、不能回改旧迁移文件（已落库的迁移改了只会让新旧库分叉）。
3. 新增表要同步：`require_tables` 的版本门（`store/environment.rs`）、`tests/migration_v9.rs` 的清单连续断言、命令白名单。
4. 改 `APP_SCHEMA_VERSION` 要同步 `tests/migration_v9.rs` 与各处版本门——这是一次性会红一片的改动，属正常。
5. 已存在视图加列要**重建视图**（`SELECT *` 建视图会冻结列），不是 `ALTER`。
6. 可见性豁免清单只增有理由的条目；不要为了让 lint 闭嘴去改 lint。
7. 备份格式是 v1，**不裁剪回收站**；`DataSummary` 的总数含回收站，另给 `trashedOrders` / `trashedClients`。
8. 资产协议按**活动代际**授权，不要改回 `generations/*/**` 宽 glob。

---

## 六、测试与构建

```bash
npx tsc --noEmit
npx vitest run

# 完整 Rust 测试必须带 devtools：不加特性时 lock / numbering / attachments_recovery
# 三组子进程用例是「跳过」，不是「通过」
cargo test --manifest-path src-tauri/Cargo.toml --features devtools --no-fail-fast

npm run tauri build -- --bundles app
```

- 开发 CLI（`minidesk-probe` / `attachments-probe` / `qa_seed`）挂在 `devtools` 特性下，不加特性既不构建也不进包。
- 日常只跑相关用例；发版前统一全量。
- 前端测试文件与页面同目录（`*.test.tsx`），后端是 `src-tauri/tests/*.rs`。

---

## 七、发布流程

```bash
# 1. 干净树 + 全量测试 + tsc + build
git status --porcelain          # 必须为空

# 2. macOS 包（只出 .app；dmg 需 Finder 自动化，当前不生成）
npm run tauri build -- --bundles app
# → src-tauri/target/release/bundle/macos/ArtFlow Desk Core.app
codesign --verify --deep --strict "src-tauri/target/release/bundle/macos/ArtFlow Desk Core.app"

# 3. 打 zip、算哈希
# 4. 推 master
# 5. Windows：GitHub Actions 原生 Runner，不在本机折腾 cargo xwin
gh workflow run windows-build --ref master

# 6. 下载 Production artifact，核对文件名 / 字节 / SHA-256
gh release upload v0.1.2 <files> --clobber
```

发布四条纪律：

- **构建必须来自干净提交**，否则前端构建标识带 `-dirty`。
- macOS 的 `bundle.macOS.signingIdentity` 必须是 `"-"`。少了它，`tauri build` 只留 linker-signed 二进制、没有 `_CodeSignature`，别人机器上 Gatekeeper 报**「已损坏」**而不是「未验证开发者」——右键「打开」也救不回来。
- Tag 一旦发布，**不因纯文档提交而移动**。
- 「CI 构建成功」不准写成「Windows 验收通过」。

产物与哈希的当前值见 [PROJECT-STATUS](../releases/PROJECT-STATUS.md)；逐步操作见 [RELEASE-GUIDE](../releases/RELEASE-GUIDE.md)。

---

## 八、验收状态（接手时不要重复宣称已完成）

| 项 | 状态 |
| --- | --- |
| 自动化测试 | 全绿（Rust 需 `--features devtools`；前端 97 文件） |
| macOS QA 构建 + 开发窗口 | 已实机走查（八页、详情、附件、备份、版本弹窗） |
| macOS **正式包**启动 | **未验证**。启动会迁移生产数据根（v13 → v14），这一步留给产品负责人 |
| macOS 干净机器首次打开 | **未验证**（开发机 Gatekeeper 评估被关闭，`spctl accepted` 不具代表性） |
| Windows 安装 / 日常使用 | **未验证**。只有 CI Runner 上的两轮启停冒烟（11 项检查 0 失败） |
| 恢复备份后界面内看图 | **未验证**（只证到文件层与自动化往返） |
| 880×500 窄窗 / 深色观感 | 深色有 8 张截图之一；窄窗只有自动化覆盖 |
| 关键操作实机回归（建单、推进、回收站、主题、自启动） | 0.1.2 批次**未整体执行** |

---

## 九、冻结功能（不要顺手实现）

1. 时间线「同月堆叠 4 行 + 超出合并 +N」
2. 登录后默认页面设置
3. 自动定时备份
4. 备份包加密
5. 旧代际清理入口

另有：设置页「接单平台与手续费」版式未重做（功能已通）、存储用量统计未实现、结构校验失败时的救援模式（P2）未做。

---

## 十、下一步从哪开始

顺序建议（详细待办见 [ROADMAP](../product/ROADMAP.md)）：

1. **先关发布尾巴**：macOS 正式包实机启动（迁移 v13 → v14）、干净机器首开、Windows 实机安装。这三项不写代码，但决定「0.1.2 是否真的可用」。
2. 再从产品缺口里挑一项，按「先核查 → 明确范围 → 实施 → 定向测试 → 记录实机待验」推进。
3. 每次改动只跑相关用例，发版前统一全量。

---

## 十一、踩过的坑（省下一次重蹈）

1. `tauri build` 用 `--bins`，会把 `target/release/` 下所有可执行文件拷进 `Contents/MacOS`。排除只能靠 `required-features`，事后删没用——下次打包又回来。
2. `bundle.macOS.signingIdentity` 缺失 = 无 `_CodeSignature` = 用户侧「已损坏」。adhoc 也要签。
3. `CreateFileW` 的 `htemplatefile` 是 `HANDLE`（`*mut c_void`），要 `null_mut()`；这类错只有原生 Windows 构建能暴露，macOS 上永远编不到。
4. 测试里不要硬编码 `/` 分隔符、`HOME`、unix 只读目录；跨平台用例要么归一化，要么 `#[cfg(unix)]` / `ignore` 并写原因。
5. WKWebView 会缓存 `http://127.0.0.1:1421/index.html`，本地取图或截图要加 `?v=<timestamp>`。
6. 主题取值只有 `arctic` / `dark`，传 `light` 会被静默拒绝，界面停在旧主题。
7. 截图前必须确认上一个实例已退出，否则单实例锁让新进程直接激活旧窗口，`screencapture` 抓到上一张。
8. 单实例路径不会跑 `setup`，用 `app.state()` 会 panic；要用 `try_state(...)`。
9. 退出闸门只拦「窗口还在且是应用级退出」的请求；无条件拦截会让关窗后进程残留。
10. `published_path` 即使文件不在也可能返回路径，列表封面必须 `is_file()` 过滤，否则前端拿到坏图。
11. 前端排序不要只按 `queue_position`：已结束订单约为 0，会跳到最前。先按状态分组，再按置顶组，再按排序键。
12. vitest 的 mock 工厂只在模块初始化时执行一次，`beforeEach` 里替换字段不会生效；用箭头函数转发。
13. `ConfirmDialog` 用的是 `role="alertdialog"`，不是 `dialog`。
14. 错误码是 `NOT_FOUND`（大写）；回收站里存在但不可见返回 `CONFLICT`，不要翻译成 `NOT_FOUND`。

---

## 十二、交接确认清单

接手后、第一次提交前，确认以下六项：

- [ ] `npm ci` + `npm run qa:seeded` 能起来，看到演示数据
- [ ] `npx tsc --noEmit`、`npx vitest run` 绿
- [ ] `cargo test --features devtools` 绿（知道为什么必须带特性）
- [ ] 读过 [PRODUCT-DECISIONS](../product/PRODUCT-DECISIONS.md)，知道哪些是已裁定不能改的
- [ ] 知道「发布 ≠ 验收」，能说出当前三项未验证
- [ ] 知道 tag 停在 `1935fb0`，master 领先的是纯文档提交
