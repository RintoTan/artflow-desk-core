# 02 · Asset 协议打包安全复验

## 一、为什么必须重测，且不能用 fetch 判分

- 开发环境（`tauri dev`）不注入 CSP，`fetch("asset://…")` 能拿到状态码；
- 打包环境注入 CSP（`default-src 'self'`，无 `connect-src`），`fetch` 在 JS 层就被拦，**拿不到 403/200**。

所以打包环境的判定手段改为：`new Image()` 加载 → `onload` 后读 `naturalWidth/naturalHeight`。
真正的合法附件会解码出真实尺寸；被拒绝的 URL 只会 `onerror`。

为排除「一律 error 的假通过」，本轮加了**正/负对照**：

- 正例：活动代际内的真实缩略图 → 必须 `loaded` 且尺寸非 0
- 负例：**同一张图的字节**复制到 `/tmp`，再用 asset URL 访问 → 必须 `error`

两张图字节完全相同、只有路径不同，因此结果差异只能来自路径授权。

## 二、逐条结果（QA 打包应用内实测）

环境：`ArtFlow Desk Core QA.app`，`gen-2981276c77b64b13b50fbb3911b7ab05`，schema v7

| # | 场景 | URL 形态 | 图片解码 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | 合法缩略图（正例） | `<gen>/attachments/thumbs/81567fef….webp` | **loaded 320×240** | **放行 ✅** |
| 13 | 同一字节放 /tmp（负例） | `/tmp/same-image.webp` | error 0×0 | 拒绝 ✅ |
| 2 | `../` 整段编码 | `…/thumbs/../../../canary-inside.txt`（整串 encodeURIComponent） | error | 拒绝 ✅ |
| 3 | 未编码 `../` | 同上，路径保留 `../`，空格转 `%20` | error | 拒绝 ✅ |
| 4 | 编码 `%2e%2e%2f` | 段内编码 | error | 拒绝 ✅ |
| 5 | 双重编码 `%252e` | 双层编码 | error | 拒绝 ✅ |
| 6 | AppData 内 canary | `<QA root>/canary-inside.txt` | error | 拒绝 ✅ |
| 7 | AppData 外 canary | `/tmp/artflow-canary.txt` | error | 拒绝 ✅ |
| 8 | 系统文件 | `/etc/passwd` | error | 拒绝 ✅ |
| 9 | 数据库文件 | `<gen>/database.sqlite` | error | 拒绝 ✅ |
| 10 | 另一代际直连 | `gen-f2b20e25…/attachments/originals/…jpg` | error | 拒绝 ✅ |
| 11 | 符号链接 → `/tmp` canary | `<gen>/attachments/originals/zz-symlink-outside.png` | error | 拒绝 ✅ |
| 12 | 符号链接 → 另一代际附件 | `<gen>/attachments/originals/zz-symlink-crossgen.png` | error | 拒绝 ✅ |

（编号沿用 DEV-07 报告的 1–12；第 13 条为本轮新增的负例对照。）

## 三、结论

| 判定项 | 结果 |
| --- | --- |
| 合法资源可访问 | ✅ 320×240 真实解码 |
| 非授权资源被拒绝 | ✅ 11 条全部 error |
| 不是「统一 403 假通过」 | ✅ 正例与负例同字节、结果相反 |
| 不泄露绝对路径/用户目录 | ✅ 图片加载失败不产生任何可读文本 |
| 符号链接不能绕过活动代际授权 | ✅ 两条链接均被拒 |
| 打包环境的 scope 机制真实生效 | ✅ 说明静态 `scope: []` + 运行时 `allow_directory` 在 release 里同样运行 |

界面侧交叉验证：订单详情「参考图片」4 张 `asset:` 图片在打包应用中全部解码成功
（`naturalWidth` = 320 / 300 / 480 / 64），见 `screenshots/04-订单详情与附件.png`。

## 四、边界

- 本轮在 macOS 26（arm64）上验证；Windows/WebView2 的 `http://asset.localhost` 路径形态不同，留待 DEV-09。
- 打包后未做 Apple 公证；Gatekeeper 路径（quarantine 属性）下的首次打开未测试。
