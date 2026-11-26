# 发布指南 · ArtFlow Desk Core

本文件说明 0.1.2 的实际构建与分发方式，以及**已经做到**和**还没做到**的边界。
状态更新于 2026-11-26。

---

## 一、版本与身份

| 项 | 值 | 来源 |
| --- | --- | --- |
| 应用版本 | `0.1.2` | `src-tauri/Cargo.toml`（权威）、`tauri.conf.json`、`package.json`、CI 的 `APP_VERSION`，四处由 `tests/version_consistency.rs` 守 |
| 数据库 schema | `v14` | `store/migrations/mod.rs` 的 `APP_SCHEMA_VERSION` |
| Bundle Identifier | `dev.artflow.minidesk` | `tauri.conf.json` |
| QA Identifier | `dev.artflow.minidesk.qa` | `tauri.qa.conf.json` |
| 数据根（正式） | `~/Library/Application Support/dev.artflow.minidesk` | 运行时解析 |
| 数据根（QA） | `~/Library/Application Support/dev.artflow.minidesk.qa/<scenario>` | `qa:seeded` |

**不要为了这次发版改名**：Identifier、数据根、内部二进制名 `artflow-minidesk` 都保持原样，
改名等于把既有用户数据丢在原地。

---

## 二、构建命令

```bash
# 前端 + 类型
npx tsc --noEmit
npx vitest run

# 后端（必须带 devtools，否则三组探针用例会被跳过而不是通过）
cargo test --manifest-path src-tauri/Cargo.toml --features devtools --no-fail-fast

# 正式包（只出 .app；dmg 需要 Finder 自动化，当前不自动生成）
npm run tauri build -- --bundles app
```

产物位置：`src-tauri/target/release/bundle/macos/ArtFlow Desk Core.app`

**开发 CLI 不会进包**：`minidesk-probe` / `attachments-probe` / `qa_seed` 都挂在 `devtools` 特性下，
`tauri build` 不加该特性就不会构建它们，`Contents/MacOS` 里只有 `artflow-minidesk`。

**发布构建必须来自干净提交**：工作区有未提交改动时，前端构建标识会带 `-dirty`。
带 `-dirty` 的包不要当正式版发。

---

## 三、本次产出的资产（0.1.2）

| 文件 | 大小 | SHA-256 |
| --- | --- | --- |
| `ArtFlow-Desk-Core-0.1.2-macos-arm64.zip` | 6,711,914 B | `4a9282a1bfc99dcf1ecac348a7376a16d9c71cb3755a4b0248620280b3e128a5` |
| `ArtFlowDesk-Core-Windows-v0.1.2-Production-Setup.exe` | 4,297,447 B | `be04dd737835a9f981e369b5ad914284e162ea50aa18505733235614bddb39a8` |
| `ArtFlowDesk-Core-Windows-v0.1.2-Production-Portable.exe` | 17,362,944 B | `8b01f906eb629eeb3401724da8f718ffb0891eb7ad1730f45836cb532b06a01f` |
| `SHA256SUMS.txt` | 347 B | 三件产物 `shasum -a 256 -c` 可校验 |

包内结构（`Contents/` 四项，`MacOS` 只有一个可执行文件）：

```
ArtFlow Desk Core.app/Contents/MacOS/artflow-minidesk
ArtFlow Desk Core.app/Contents/Resources/icon.icns
ArtFlow Desk Core.app/Contents/Info.plist
ArtFlow Desk Core.app/Contents/_CodeSignature/CodeResources
```

校验方式：

```bash
shasum -a 256 -c SHA256SUMS.txt
unzip -l ArtFlow-Desk-Core-0.1.2-macos-arm64.zip | grep Contents/MacOS/
```

`Contents/MacOS` 只应出现 `artflow-minidesk` 一个可执行文件。多出任何名字（probe / seed）都说明
打包配置被改坏了。

---

## 四、签名与公证：adhoc、未公证

```
Identifier=dev.artflow.minidesk
CodeDirectory v=20500 ... flags=0x10002(adhoc,runtime) location=embedded
Signature=adhoc
TeamIdentifier=not set
```

`bundle.macOS.signingIdentity` 设为 `"-"` 才会产生 `Contents/_CodeSignature/CodeResources`。
少了这一步，包只剩 linker-signed 的裸二进制，用户侧报的是**「已损坏」**而不是「未验证的开发者」。

这是**明确选择**的当前方案，不是遗漏：个人项目不为 0.1.2 单独购买 Apple Developer 账号。

### 用户首次打开的提示与处理

未公证的包在别人的机器上会被 Gatekeeper 拦一次，提示「无法打开，因为 Apple 无法检查它是否包含恶意软件」。
处理方法（**不要关闭系统全局 Gatekeeper**）：

1. 在 Finder 里**右键**（或按住 Control 点击）`ArtFlow Desk Core.app` → 选择「打开」；
2. 弹窗里再点一次「打开」；
3. 之后这台机器就不再拦它。

不提供关闭全局 Gatekeeper 或批量移除隔离标记的做法：右键一次即可，代价更低，也不会留下长期放松的系统设置。

> 本机 `spctl -a` 显示 `accepted / override=security disabled`，说明这台开发机的 Gatekeeper 评估被关闭过。
> **因此本机的 `accepted` 不能证明用户机器上会接受**——这一项只能记为「未在干净机器验证」。

---

## 五、Windows：CI 原生构建

本机不做交叉编译：`cargo xwin` 卡在缺 `llvm-rc` / `llvm-lib`，补齐工具链的成本高于收益。
产物由 GitHub Actions 原生 `windows-latest` Runner 构建 x64（`.github/workflows/windows-build.yml`）：

```bash
gh workflow run windows-build --ref master
```

每次构建产出 Production 与 QA 两套，Runner 上会启动、等待窗口、优雅关闭、确认进程退出、再启动一次，
共 11 项检查；冒烟脚本见 `scripts/windows/smoke-test.ps1`。

必须同时记录：workflow run 编号、产物文件名 / 字节 / SHA-256，以及一句
**「已构建，未完成 Windows 真机安装与运行验收」**。

**不得**把「CI 构建成功」写成「Windows 验收通过」。

---

## 六、发布检查清单（0.1.2）

| 检查项 | 状态 |
| --- | --- |
| 四处版本号一致 | 通过（`version_consistency` 守护） |
| 前端构建标识来自干净提交 | 通过（无 `-dirty`） |
| `Contents/MacOS` 无开发 CLI | 通过（只有 `artflow-minidesk`） |
| Info.plist identifier / 版本 | 通过（`dev.artflow.minidesk` / `0.1.2` / 最低 macOS 13.0） |
| bundle 签名可校验 | 通过（`codesign --verify --deep --strict`，含 `_CodeSignature`） |
| ZIP / EXE 校验文件可复算 | 通过（`shasum -a 256 -c` OK） |
| 正式包启动验证 | **未执行**（会打开并迁移生产数据根，留给产品负责人） |
| Windows 真机安装与人工验收 | **未执行**（仅 CI Runner 冒烟） |
| 截图 | 已交付 8 张（`41a41b4` 构建） |
| GitHub Tag / Release | 已发布（`v0.1.2` → `1935fb0`，非草稿非预发布） |

---

## 七、回滚与数据安全

- 升级会生成新代际并切换 `state/active.json` 指针；回滚指针即可回到上一代际，旧代际目录不会自动删除。
- 恢复备份前应用会先做一次回退备份（见备份面板），失败时不会覆盖现有库。
- QA 与 Production 使用不同 identifier 与不同数据根，**不要把 QA 数据根指向正式目录**。
