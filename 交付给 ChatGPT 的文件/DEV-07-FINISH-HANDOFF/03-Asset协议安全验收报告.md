# 03 · Asset 协议安全验收报告

## 一、协议事实（读代码得出，不是假设）

| 项 | 值 |
| --- | --- |
| 协议 | `asset:`（Tauri v2 内置），macOS 上实际 URL 形如 `asset://localhost/<encodeURIComponent(绝对路径)>` |
| 注册 | `tauri.conf.json → app.security.assetProtocol.enable = true` |
| 允许根 | **运行时按活动代际授权**：`<root>/generations/<活动代际>/attachments/**`（`allow_directory(dir, true)`）；静态 `assetProtocol.scope` 为空 |
| 前端生成 | `convertFileSrc(absolutePath)`（`AttachmentPanel`、`ImageViewer`） |
| CSP | `img-src 'self' blob: data: asset: http://asset.localhost` —— 只允许作为图片来源/资源，不放宽为脚本源 |
| 后端守卫 | `attachment_*` 命令只返回代际内 `attachments/` 的相对路径，绝对路径由 `abs_path()` 拼接并校验 |

## 二、已有证据（配置层，`tests/asset_scope.rs`，9 项）

用与 Tauri 相同的 glob 语义断言：允许目录内可读、`generations/<其它代际>/…` 之外不可读、`$APPDATA/**` 未被使用。

**这层只证明配置写对了，不证明运行时真的拦截。**

## 三、本轮新增：真实 WKWebView 运行时负向测试

环境：QA 窗口（`dev.artflow.minidesk.qa`，schema v7）。
方法：在真实页面里用 `fetch()` 与 `new Image()` 请求 11 组 URL，记录 HTTP 状态与实际是否加载。
Canary 文件（本轮临时创建，非用户数据）：

- `/tmp/artflow-canary.txt`（AppData 之外）
- `<QA data root>/canary-inside.txt`（AppData 之内、attachments 之外）

| # | 场景 | URL 形态 | fetch | 图片加载 | 判定 |
| --- | --- | --- | --- | --- | --- |
| 1 | 合法缩略图 | `asset://localhost/<enc 当前代际 thumbs/x.webp>` | **200**（返回 RIFF/WEBP） | **loaded** | 正常放行 ✅ |
| 2 | `../../` 穿越到 AppData 根 | `…/thumbs/../../../canary-inside.txt`（整段编码） | 403 | error | 拒绝 ✅ |
| 3 | 未编码的 `../` | 同上但路径保留 `../` | 403 | error | 拒绝 ✅ |
| 4 | 编码穿越 `%2e%2e%2f` | 段内编码 | 403 | error | 拒绝 ✅ |
| 5 | 双重编码 `%252e` | 双层编码 | 404 | error | 拒绝 ✅ |
| 6 | AppData 内 canary | `<root>/canary-inside.txt` | 403 | error | 拒绝 ✅ |
| 7 | AppData 外 canary | `/tmp/artflow-canary.txt` | 403 | error | 拒绝 ✅ |
| 8 | 系统文件 | `/etc/passwd` | 403 | error | 拒绝 ✅ |
| 9 | 另一个 generation | `…/gen-f2b20e25…/attachments/originals/qa-blue.png` | 404 | error | 文件不存在（**当时并未真正验证跨代际拦截**，见第四节更正） |
| 10 | 重复分隔符 + `.` 段 | `…/attachments//originals//./x.png` | 404 | error | 拒绝 ✅ |
| 11 | 数据库文件本身 | `…/generations/<当前>/database.sqlite` | 403 | error | 拒绝 ✅ |

补充观察：

- 403 响应体为空，**没有泄露绝对路径或用户目录**；
- 合法请求返回真实字节（`RIFF..WEBP` 头），说明放行路径确实走通，不是「一律 403」的假通过；
- 跨代际访问返回 404 而非 403 —— 说明路径确实被解析到了 `generations/` 下的另一个目录，但被 scope 规则挡掉；两种拒绝码都属「不可读」。

## 四、结论

| 层 | 结论 |
| --- | --- |
| Rust 单元测试（路径拼接、`abs_path` 越界判定） | PASS（既有） |
| Tauri 配置校验（scope glob，9 项） | PASS（既有） |
| **真实 WKWebView 运行时** | **PASS（本轮新增，11 组，2026-11-20 实测）** |

三者不能互相替代：配置对但运行时若 scope 被放宽，第 2–11 项就会变成 200。本轮实测证明当前打包配置在真实 WebView 里是生效的。

## 五、DEV-08 必须复验的部分

- **打包后的 app bundle**（`.app` 内 WKWebView 与 dev 模式共用同一进程模型，但资源目录、`$APPDATA` 解析、签名沙箱可能不同）；
- Windows（WebView2）的 `http://asset.localhost` 路径形态与本轮 macOS 的 `asset://localhost/` 不同，需在 DEV-09 用同一组用例复跑；
- 若将来把备份包内的附件直接以 asset 协议预览（当前不这么做），必须重新评估 scope。

## 六、终轮补测：符号链接越界（DEV-07-FINISH-FINAL）

### 6.1 代码层先行审计

- `tauri 2.12.5` 的 asset 协议：`percent_decode` → `SafePathBuf::new`（拒绝 `..`/相对路径/非法形态）→ `scope.is_allowed(&safe_path)` → `File::open`。
- 关键点在 `scope/fs.rs:419`：`is_allowed()` 内部先调用 `try_resolve_symlink_and_canonicalize(path)`，**按解析后的真实路径**做 glob 匹配。
- 因此符号链接本身不是绕过手段：链接解析到哪儿，就按哪儿匹配。

### 6.2 真实 WKWebView 实测（QA 窗口，schema v7）

测试对象：

- 链接 A：`<QA>/generations/gen-2981276c…/attachments/originals/zz-symlink-outside.png` → `/tmp/artflow-canary.txt`
- 链接 B：`<QA>/generations/gen-2981276c…/attachments/originals/zz-symlink-crossgen.png` → `<QA>/generations/gen-f2b20e25…/attachments/originals/5dc6da4e-….jpg`

**收紧前**（scope = `generations/*/attachments/**`）：

| 场景 | fetch | 图片 | 判定 |
| --- | --- | --- | --- |
| S1 合法缩略图 | 200（RIFF/WEBP） | loaded | 正常放行 |
| S2 符号链接 → `/tmp` canary | 403 | error | **拒绝 ✅** |
| S3 符号链接 → 另一代际附件 | **200（JFIF 字节）** | **loaded** | **未隔离 ❌** |
| S4 `/../` 穿越到 AppData 根 | 403 | error | 拒绝 ✅ |
| S5 编码穿越 `%2e%2e%2f` | 403 | error | 拒绝 ✅ |
| S6 AppData 内 canary | 403 | error | 拒绝 ✅ |
| S7 AppData 外 canary | 403 | error | 拒绝 ✅ |
| S8 `/etc/passwd` | 403 | error | 拒绝 ✅ |
| S9 另一代际附件直连 | **200（JFIF 字节）** | **loaded** | **未隔离 ❌** |
| S10 `database.sqlite` | 403 | error | 拒绝 ✅ |

结论：**符号链接指向 scope 之外 → 拦住了**；问题出在 scope 本身跨代际（S3 与 S9 是同一个根因，S3 只是 S9 的链接版）。

### 6.3 修复（只收紧，不放宽）

```jsonc
// tauri.conf.json / tauri.qa.conf.json
"assetProtocol": { "enable": true, "scope": [] }
```
```rust
// lib.rs setup
app.asset_protocol_scope()
   .allow_directory(&layout.attachments_dir(active_generation), true)?;
```

静态 glob 表达不了「活动代际」，所以改成运行时授权：允许列表里只有当前代际的 `attachments/**`，别的代际目录不在列表内。

### 6.4 修复后复验（同一 QA 窗口，重新构建后）

| 场景 | fetch | 图片 | 判定 |
| --- | --- | --- | --- |
| S1 合法缩略图 | 200（RIFF/WEBP） | loaded | 正常放行 ✅ |
| S2 符号链接 → `/tmp` | 403 | error | 拒绝 ✅ |
| **S3 符号链接 → 另一代际** | **403** | error | **已隔离 ✅** |
| S4–S8、S10 | 403 | error | 拒绝 ✅ |
| **S9 另一代际直连** | **403** | error | **已隔离 ✅** |

附件预览回归：订单详情「参考图片」4 张 `asset:` 图片 `naturalWidth > 0` = **4/4 加载成功**（截图 `04-附件仍可预览-收紧后.png`）。

### 6.5 上一版报告的更正

上一版第 9 行写作「另一个 generation → 404 拒绝」，据此得出「跨代际不可读」的结论——**这是错的**：
当时用的 `qa-blue.png` 在那个代际里并不存在，404 是「文件不存在」，不是「被 scope 拒绝」。
本轮用真实存在的文件重测，才暴露出跨代际可读。已按实测结果更正并修复。
