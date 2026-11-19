# DEV-09B 构建报告｜Windows 原生 CI

**结论：构建工作流已就绪但尚未运行 → 本轮没有产物。**

阻断点从"macOS 缺 `llvm-rc`"转移到"仓库没有远程地址"。按任务 §10 的规定，
需要你确认后我才能整理提交并推送；在此之前不制造"已构建"的假象。

## 一、环境与 Git 审查

| 项 | 实际值 |
| --- | --- |
| 分支 / HEAD | `master` / `e4b4f33` |
| `git remote -v` | **空**（从未配置远程） |
| 工作区未提交改动 | 43 项 |
| `.github/workflows/` | 本轮新建（此前不存在） |
| 版本 | 0.1.0（package.json / Cargo.toml / tauri.conf.json 一致） |
| Tauri CLI / crate | 2.12.4 / 2.12.5 |
| Node | 本地 22.x；工作流固定 20（满足 Vite 5 + Tauri 2 要求） |
| lockfile | `package-lock.json` v3，工作流用 `npm ci` |

### DEV-09A 的两项适配仍在

| 文件 | 变更 | 已提交？ |
| --- | --- | --- |
| `src-tauri/tauri.conf.json` | `bundle.icon` 增加 `icons/icon.ico` | **未提交**（`M`） |
| `src-tauri/src/store/qa.rs` | `platform_app_data_base()` + `platform_app_data_base` 驱动的 `production_data_dir()` / `default_root()` | **未提交**（`M`） |

## 二、本轮新增

| 文件 | 作用 |
| --- | --- |
| `.github/workflows/windows-build.yml` | 两个独立 job（Production / QA），`workflow_dispatch` 手动触发，只上传 artifact，不建 Release |
| `build/windows/launchers/启动 QA Clean（空白环境）.cmd` | 双击即以 clean 场景启动已安装的 QA 版（自动探测安装路径，不改系统环境变量） |
| `build/windows/launchers/README.txt` | 给用户看的场景说明 |
| `docs/DEV-09-WINDOWS-MANUAL-TEST.md` | 重写为以真实产物为准、T01–T59 全部 NOT RUN 的手册 |
| `DEV-09-WINDOWS-HANDOFF/` | 交付目录（installers 为空并说明原因） |

## 三、工作流设计要点

1. **两个 job 分别构建**，避免正式版与 QA 版在同一 `target/` 目录互相覆盖。
2. QA job 用 `--config src-tauri/tauri.qa.conf.json`，并在校验步骤里**断言安装包名含 "QA"**，防止误用正式配置。
3. 构建前端前先 `npm run typecheck`，与本地脚本一致（`build` 里已含 `tsc --noEmit`，这里显式再跑一次便于定位）。
4. Rust 侧跑 `cargo test`（**不加 `--offline`**，runner 需要联网拉依赖）。
5. 打包用 `--bundles nsis`，只出 NSIS；不生成 MSI（任务未要求）。
6. 校验步骤会打印 EXE 体积与 `VersionInfo`，并把 `SHA256SUMS.txt` 一起打进 artifact。
7. `retention-days: 30`，artifact 名称固定为 `ArtFlowDesk-Windows-Production` / `ArtFlowDesk-Windows-QA`。

## 四、WebView2 与 NSIS

- 配置里没有显式写 `bundle.windows.webviewInstallMode`，即采用 Tauri 2 默认 **`downloadBootstrapper`**：安装时若缺 WebView2 Runtime，会引导联网下载。
- 未签名：不改配置、不伪造证书。SmartScreen 提示属预期，已写进手册 T02。

## 五、QA Clean 入口方案

问题：Windows 上双击 QA 图标进的是 `seeded`（`scenario_from_env()` 缺省 `Seeded`），而手册要求的人机验收需要一个空白环境。

方案：`.cmd` 脚本，`set AF_MINIDESK_QA_SCENARIO=clean` 后启动已安装的 exe，变量只对本次进程有效（`setlocal`），并在 6 个候选安装路径里自动查找 exe（按用户安装 / 按机器安装 / 两种 exe 名）。

不修改业务代码、不新增构建目标、不影响正式版与 seeded。

**未验证**：脚本只在 macOS 上做了语法与路径逻辑检查，尚未在 Windows 实机跑过——手册 T09 把它列为待验收项。

## 六、完成度对照

| 完成标准 | 状态 |
| --- | --- |
| Windows 原生 Runner 实际执行成功 | **未执行**（无远程） |
| 正式版 `.exe` | **未生成** |
| QA 版 `.exe` | **未生成** |
| 正式版 NSIS | **未生成** |
| QA 版 NSIS | **未生成** |
| identifier / 版本核对 | 配置层已核对（见下），产物层未生成 |
| SHA256 | 无产物，`SHA256SUMS.txt` 为空并说明 |
| QA Clean 启动方案 | 已提供脚本，未实机验证 |
| 测试手册 | **已完成**（全部 NOT RUN） |
| 构建报告 | 本文件 |

配置层核对：

| | 正式版 | QA 版 |
| --- | --- | --- |
| productName | `ArtFlow Desk Core` | `ArtFlow Desk Core QA` |
| identifier | `dev.artflow.minidesk` | `dev.artflow.minidesk.qa` |
| version（继承） | 0.1.0 | 0.1.0 |
| 窗口标题 | `ArtFlow Desk Core` | `ArtFlow Desk Core — QA 测试环境` |

## 七、要跑起来还差什么（需要你确认）

1. **建一个 GitHub 远程仓库**（私有即可），并把下面这批文件纳入版本控制；
2. 确认我可以执行一次提交 + 推送（本轮没有做，也不会做）；
3. 在 Actions 页面手动 Run `windows-build`（或授权我用 API 触发）。

### 需要纳入构建的最小文件清单

新增（必须提交）：

```
.github/workflows/windows-build.yml
build/windows/launchers/启动 QA Clean（空白环境）.cmd
build/windows/launchers/README.txt
```

修改（Windows 构建必需，DEV-09A 遗留未提交）：

```
src-tauri/tauri.conf.json          （bundle.icon 加 icons/icon.ico）
src-tauri/src/store/qa.rs          （跨平台 AppData 基础目录）
```

已在版本控制内、无需改动：

```
package.json / package-lock.json / tsconfig*.json / vite.config.* / index.html
src/**  （前端全部）
src-tauri/{Cargo.toml,Cargo.lock,tauri.conf.json,tauri.qa.conf.json,capabilities,icons}
```

**不需要**提交的：`docs/assets/**`（历史截图）、`docs/prototypes/**`、`DEV-06D-*` 历史交付目录、
`交付给 ChatGPT 的文件/**`、`DEV-09-WINDOWS-HANDOFF/**`、`screenshots.zip` 等与本轮构建无关的内容。

## 八、已知风险（构建成功后仍可能出现）

| 风险 | 说明 |
| --- | --- |
| 三个开发 CLI 被打进包 | `minidesk-probe` / `attachments-probe` / `qa_seed` 是 workspace 的 `[[bin]]`，Windows 上同样会被 bundler 收集；macOS 侧是构建后删除再重签，Windows 上 NSIS 打包在 build 内部完成，无法事后剔除。预计包体 +13 MB，功能不受影响 |
| `cargo test` 在 runner 上首次编译较慢 | 已用 `Swatinem/rust-cache` 缓存，仍可能 8–12 分钟 |
| NSIS 中文安装路径 | Tauri NSIS 支持 Unicode，但未实测；若安装到中文目录出问题，请在反馈里写清楚 |
