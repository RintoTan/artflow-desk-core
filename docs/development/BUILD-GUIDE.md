# 构建指南

## macOS

```bash
npm ci
npm run build
npx tauri build --bundles app            # 正式版 .app
npx tauri build --config src-tauri/tauri.qa.conf.json --bundles app   # QA 版
```

产物：`src-tauri/target/release/bundle/macos/*.app`

- 当前为 ad-hoc 签名，未公证；
- 打包会把 workspace 的开发 CLI（`minidesk-probe`/`attachments-probe`/`qa_seed`）一起放进 `Contents/MacOS/`，发布前需要剔除并重新 `codesign --force --sign -`；
- DMG 用 `hdiutil create -volname … -srcfolder <stage> -format UDZO` 生成，stage 里放 `.app` 与 `Applications` 软链接。

## Windows

**只支持在 Windows 原生环境构建**（本机 macOS 交叉编译因缺 `llvm-rc` 不可行，已放弃）。

### GitHub Actions（推荐）

`.github/workflows/windows-build.yml`，`workflow_dispatch` 手动触发：

```bash
gh workflow run windows-build -f build_qa=true
gh run download <run-id> -n ArtFlowDesk-Windows-Production -D out/Production
```

流程：`npm ci` → `typecheck` → `build` → `cargo test` → `tauri build --target x86_64-pc-windows-msvc --bundles nsis` → 校验产物与 `VersionInfo` → 上传 artifact。

### 本地 Windows

```powershell
npm ci
npx tauri build --target x86_64-pc-windows-msvc --bundles nsis
```

需要：Rust MSVC 工具链 + Visual Studio Build Tools（C++ 桌面开发）+ Node 20。

## 配置

| 文件 | 用途 |
| --- | --- |
| `src-tauri/tauri.conf.json` | 正式版：identifier `dev.artflow.minidesk` |
| `src-tauri/tauri.qa.conf.json` | QA 版：identifier `dev.artflow.minidesk.qa` |

## 常见问题

| 现象 | 处理 |
| --- | --- |
| `failed to find tool "llvm-lib"` | macOS 交叉编译 MSVC 缺归档器；改用 Windows 原生或 CI |
| `NotAttempted("llvm-rc")` | 同上，缺资源编译器 |
| `could not find unix in os` | 测试用了 unix-only API，加 `#[cfg(unix)]` |
| 前端白屏 | 检查 `frontendDist` 是否指向已构建的 `dist/` |
