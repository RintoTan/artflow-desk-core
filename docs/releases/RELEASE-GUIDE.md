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

## 三、本次产出的资产（0.1.2 / macOS arm64）

| 文件 | 大小 | SHA-256 |
| --- | --- | --- |
| `ArtFlow-Desk-Core-0.1.2-macos-arm64.zip` | 6.5 MB | `3bdd0b5685f3a0910bb3b934c9e27a33c99c6b7df4691037340de6f5c5e57029` |
| `SHA256SUMS.txt` | — | 内容同上，`shasum -a 256 -c` 可校验 |

包内结构（`unzip -l` 只有 7 项）：

```
ArtFlow Desk Core.app/Contents/MacOS/artflow-minidesk    22,457,920 B
ArtFlow Desk Core.app/Contents/Resources/icon.icns
ArtFlow Desk Core.app/Contents/Info.plist
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
Identifier=artflow_minidesk
CodeDirectory ... flags=0x20002(adhoc,linker-signed)
Signature=adhoc
TeamIdentifier=not set
```

这是**明确选择**的当前方案，不是遗漏：个人项目不为 0.1.2 单独购买 Apple Developer 账号。

### 用户首次打开的提示与处理

未公证的包在别人的机器上会被 Gatekeeper 拦一次，提示「无法打开，因为 Apple 无法检查它是否包含恶意软件」。
处理方法（**不要关闭系统全局 Gatekeeper**）：

1. 在 Finder 里**右键**（或按住 Control 点击）`ArtFlow Desk Core.app` → 选择「打开」；
2. 弹窗里再点一次「打开」；
3. 之后这台机器就不再拦它。

命令行方式：`xattr -dr com.apple.quarantine "/Applications/ArtFlow Desk Core.app"`。

> 本机 `spctl -a` 显示 `accepted / override=security disabled`，说明这台开发机的 Gatekeeper 评估被关闭过。
> **因此本机的 `accepted` 不能证明用户机器上会接受**——这一项只能记为「未在干净机器验证」。

---

## 五、Windows：尚未产出

当前状态：**未构建**。本机 `cargo xwin` 缺 `llvm-rc`，没有可用的 Windows 交叉编译链。

计划路线（按产品决定）：GitHub Actions 原生 `windows-latest` Runner 构建 x64，不继续在本机折腾交叉编译。
前置条件是仓库已推送并存在对应 workflow 文件；这一步尚未执行。

Windows 产物一旦生成，必须同时记录：

- 构建日志（哪次 workflow run）
- 产物文件名、大小、SHA-256
- 明确标注「已构建，未完成 Windows 真机安装与运行验收」

**不得**把「CI 构建成功」写成「Windows 验收通过」。

---

## 六、发布检查清单（0.1.2）

| 检查项 | 状态 |
| --- | --- |
| 四处版本号一致 | 通过（`version_consistency` 3 例） |
| 前端构建标识来自干净提交 | 通过（`17fd755`，无 `-dirty`） |
| `Contents/MacOS` 无开发 CLI | 通过（只有 `artflow-minidesk`） |
| Info.plist identifier / 版本 | 通过（`dev.artflow.minidesk` / `0.1.2` / 最低 macOS 13.0） |
| ZIP 校验文件可复算 | 通过（`shasum -c` OK） |
| 正式包启动验证 | **未执行**（会打开并迁移生产数据根） |
| Windows 产物 | **未产出** |
| 截图更新 | **未执行** |
| GitHub Tag / Release | **未执行** |

---

## 七、回滚与数据安全

- 升级会生成新代际并切换 `state/active.json` 指针；回滚指针即可回到上一代际，旧代际目录不会自动删除。
- 恢复备份前应用会先做一次回退备份（见备份面板），失败时不会覆盖现有库。
- QA 与 Production 使用不同 identifier 与不同数据根，**不要把 QA 数据根指向正式目录**。
