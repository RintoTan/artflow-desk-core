# 开发与构建

从零把仓库跑起来、改代码、验证、发版，都在这一份里。

## 1. 环境要求

| 项 | 版本 / 说明 |
| --- | --- |
| Node.js | 20+（CI 使用 20） |
| Rust | stable；Windows 需要 MSVC 工具链 |
| macOS | 13.0+（本地构建） |
| Xcode CLT | 提供 clang 与 macOS SDK |
| Windows 构建 | Visual Studio Build Tools（C++ 桌面开发）+ Rust MSVC |

## 2. 安装依赖

```bash
npm ci
```

## 3. 本地启动

**开发一律用 QA 配置**，正式配置会写正式数据目录并触发正式库迁移：

```bash
npm run qa:seeded      # 演示数据（推荐）
npm run qa:clean       # 空白环境
npm run qa:timeline-empty   # 时间线空态（另有 -unscheduled / -no-dates / -terminal）
```

三种 QA 场景的数据互不覆盖。正式 identifier 只用于打包，不用来「看看效果」。

## 4. 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 只起 Vite（纯前端调试，无 Tauri 命令） |
| `npm run build` | `tsc --noEmit` + 生产构建到 `dist/` |
| `npm run typecheck` | 类型检查 |
| `npm test` | 前端测试（vitest run） |
| `npm run qa:seed` | 重灌 seeded 场景数据 |
| `npm run qa:rebuild` | 重建 seeded 场景 |
| `npm run layout:check` | 布局探针 |
| `cargo test --manifest-path src-tauri/Cargo.toml --features devtools` | Rust 测试（带特性才是完整集合） |
| `npx tauri build` | 本机打包（默认正式版） |

当前基线（2026-11-26 提交 `fec7f16` 实跑）：Rust **723 passed / 0 failed / 1 ignored**（需 `--features devtools`）、前端 **97 文件 / 956 passed**，`tsc --noEmit` 与 `npm run build` 通过。数字会变，重跑后再引用，别照抄。

## 5. 测试

```bash
# 完整集合：迁移 / 生命周期 / 备份 / 维护 / 并发 + 三组探针子进程用例
cargo test --manifest-path src-tauri/Cargo.toml --features devtools --no-fail-fast

npm test          # 页面与纯函数（vitest run）
npm run typecheck
npm run build
```

约定：

- 测试里不要硬编码平台假设（`HOME`、`/` 分隔符、unix 符号链接）。跨平台用例加 `#[cfg(unix)]` 或做路径归一化。
- 数据类测试用 `tempfile` 或 QA 场景目录，**不要碰正式数据根**。
- 部分测试通过 `CARGO_BIN_EXE_*` 依赖 `src-tauri/src/bin/` 下的三个开发 CLI，删这些 bin 会编译不过。

## 6. 构建

### macOS

```bash
npm ci && npm run build
npx tauri build --bundles app                                        # 正式版
npx tauri build --config src-tauri/tauri.qa.conf.json --bundles app  # QA 版
```

产物在 `src-tauri/target/release/bundle/macos/`。

- 当前是 ad-hoc 签名（`codesign --sign -`），未公证；
- 开发 CLI（`minidesk-probe` / `attachments-probe` / `qa_seed`）挂在 `devtools` 特性下，默认不构建、不会进 `.app`；
  需要它们时显式加特性：`cargo run --features devtools --bin qa_seed -- --scenario seeded`（`npm run qa:seed` 已带该特性）。
  **完整 Rust 测试要用 `cargo test --features devtools`**，否则 `lock` / `numbering` / `attachments_recovery` 三组子进程用例会被跳过；
- DMG 用 `hdiutil create -volname … -srcfolder <stage> -format UDZO` 制作，stage 内放 `.app` 与 `Applications` 软链接。

### Windows

**只支持 Windows 原生构建**。macOS 交叉编译因缺 `llvm-rc` / `llvm-lib` 不可行，已放弃。

推荐走 GitHub Actions（`.github/workflows/windows-build.yml`，手动触发）：

```bash
gh workflow run windows-build -f build_qa=true
gh run download <run-id> -n ArtFlowDesk-Windows-Production -D out/Production
```

流程：`npm ci` → `typecheck` → `build` → `cargo test` → `tauri build --target x86_64-pc-windows-msvc --bundles nsis` → 校验产物与 VersionInfo → 启动/关闭冒烟 → 上传 artifact。

本地 Windows：

```powershell
npm ci
npx tauri build --target x86_64-pc-windows-msvc --bundles nsis
```

## 7. 发布

### 版本号

- 应用版本**四处**必须一致：`src-tauri/Cargo.toml`（界面与备份 manifest 的权威来源）、
  `src-tauri/tauri.conf.json`（安装包元数据）、`package.json`、
  `.github/workflows/windows-build.yml` 的 `APP_VERSION`（决定 CI 产物文件名）。
- `cargo test --test version_consistency` 会实际读取这四个文件比对，任意一处漂移即失败。
- Release 标签 `v<版本>-demo.<序号>`（如 `v0.1.2-demo.1`）**不代表**修改应用版本号。

### 构建身份

- 构建号在 `vite build` 时注入（见 `vite.config.ts`）：7 位短 SHA；工作区有未提交改动时追加
  `-dirty`；取不到 Git 信息时为 `unknown`。`dist/`、`target/` 已被忽略，不会把干净的树误判成脏。
- 关于页「版本信息」显示构建号，QA 横幅显示同一个值，两处不会分叉。
- 可选发布标记：构建时设置 `VITE_RELEASE_LABEL="v0.1.2-demo.1"`，关于页「运行构建」追加
  `· Demo · <标记>`；未设置则什么都不显示。它不改应用版本，也不参与 QA 环境判定。

### 产物命名

```
ArtFlowDesk-Core-macOS-v0.1.2-Production.zip      ArtFlowDesk-Core-macOS-v0.1.2-QA.zip
ArtFlowDesk-Core-Windows-v0.1.2-Production-Setup.exe     ...-Production-Portable.exe
ArtFlowDesk-Core-Windows-v0.1.2-QA-Setup.exe             ...-QA-Portable.exe
SHA256SUMS.txt
```

### 流程

1. `master` 干净、四项测试全绿；
2. macOS：构建两个 `.app` → 剔除开发 CLI → 重签 → 打 ZIP / DMG；
3. 触发 Windows CI，下载两个 artifact；
4. 本地复核：文件类型（`PE32` / `PE32+`）、大小、VersionInfo；
5. 生成 `SHA256SUMS.txt`（两平台放一起）；
6. `gh release create v0.1.0-demo.N --prerelease --title … --notes-file …` 上传全部资产（`--target` 需要完整 SHA）；
7. 更新 `CHANGELOG.md` 与 [PROJECT-STATUS.md](../releases/PROJECT-STATUS.md)。

### 注意

- 仓库 Private，Release 只有有权限的账号能下载；
- 安装包不进 Git 历史，只作 Release 资产；
- 不伪造签名，不伪造实机验收结论；
- 校验哈希时注意 `SHA256SUMS.txt` 由 PowerShell 生成、行尾 CRLF，先在 macOS 上 `tr -d '\r'`。

## 8. 平台差异

| 项 | macOS | Windows |
| --- | --- | --- |
| WebView | WKWebView | WebView2（依赖系统运行时，Portable 版不捆绑） |
| 数据根 | `~/Library/Application Support/<id>` | `%APPDATA%\<id>` |
| 资产协议 URL | `asset://localhost/…` | `http://asset.localhost/…` |
| 内容区行为 | 标题栏内嵌、红绿灯按钮让位 | 标准窗口，最小 960×640 |
| 快捷键 | ⌘ | Ctrl（同一套映射） |
| 发布无控制台 | release 版仍可看 stdout | `windows_subsystem="windows"`，**没有控制台**，只能写 `logs/app.log` |
| DPI | Retina 自动缩放 | 150% 已验收；125% / 200% 未验证 |
| 进程退出 | 关窗即退出 | WebView2 渲染子进程异步收尾，判定残留需收敛窗口 |

## 9. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| `failed to find tool "llvm-lib"` | macOS 交叉编译 MSVC 缺归档器；改用 Windows 原生或 CI |
| `NotAttempted("llvm-rc")` | 同上，缺资源编译器 |
| `could not find unix in os` | 测试用了 unix-only API，加 `#[cfg(unix)]` |
| 前端白屏 | 检查 `frontendDist` 是否指向已构建的 `dist/` |
| 启动就报「已有实例在运行」 | 上一个进程没退干净；看 `logs/app.log`，确认后结束进程（不要直接删 `.write.lock`） |
| 关窗后进程还在 | 已被 DEV-11 修复；若复现，附 `logs/app.log` 反馈 |
| 冒烟测试报「仍有子进程」 | WebView2 收尾是异步的，15 秒内收敛属正常；固定短超时会误报 |
| 打包后打不开 | 检查是否缺少开发 CLI 之外的资源；macOS 看 `codesign -dv` 与 `spctl -a` |

## 10. 代码约定

- 前端不直接写库，所有写操作走 `commands`，内部 `BEGIN IMMEDIATE` + `revision` 乐观锁；
- 事件写入与状态变更在同一事务；
- 计划日期（纯日历日期）与事件时间（真实时间点）不混用；
- 新增事件类型必须同步：迁移、领域层校验、前端展示；
- 改动数据层前先读 [DATA-SAFETY.md](../architecture/DATA-SAFETY.md)。
