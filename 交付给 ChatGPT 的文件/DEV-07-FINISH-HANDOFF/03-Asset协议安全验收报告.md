# 03 · Asset 协议安全验收报告

## 一、协议事实（读代码得出，不是假设）

| 项 | 值 |
| --- | --- |
| 协议 | `asset:`（Tauri v2 内置），macOS 上实际 URL 形如 `asset://localhost/<encodeURIComponent(绝对路径)>` |
| 注册 | `tauri.conf.json → app.security.assetProtocol.enable = true` |
| 允许根 | `$APPDATA/generations/*/attachments/**`（**不是**整个 AppData） |
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
| 9 | 另一个 generation | `…/gen-f2b20e25…/attachments/originals/qa-blue.png` | 404 | error | 拒绝 ✅ |
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
