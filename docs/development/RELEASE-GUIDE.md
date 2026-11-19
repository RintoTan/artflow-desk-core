# 发布指南

## 版本号

- 应用内部版本：`package.json` / `src-tauri/Cargo.toml` / `tauri.conf.json` 三处必须一致；
- GitHub Release 标签：`v<版本>-demo.<序号>`（如 `v0.1.0-demo.1`），**不代表**修改应用版本号。

## 产物命名

```
ArtFlowDesk-Core-macOS-v0.1.0-QA.zip
ArtFlowDesk-Core-macOS-v0.1.0-Production.zip
ArtFlow Desk Core_0.1.0_x64-setup.exe          # CI 原始名
ArtFlow Desk Core QA_0.1.0_x64-setup.exe
SHA256SUMS.txt
```

## 发布流程

1. 确认 `master` 干净、测试全绿；
2. 构建 macOS 两个 `.app` → 剔除开发 CLI → 重签 → 打 ZIP/DMG；
3. 触发 Windows CI，下载两个 artifact；
4. 本地复核：文件类型（`PE32`/`PE32+`）、大小、`VersionInfo`；
5. 生成 `SHA256SUMS.txt`（macOS 与 Windows 放一起）；
6. `gh release create v0.1.0-demo.N --prerelease --title … --notes-file …` 并上传全部资产；
7. 更新 `docs/releases/<version>.md` 与 CHANGELOG。

## 校验

```bash
shasum -a 256 *.zip *.exe
```

## Release 说明必须包含

- 版本与平台；
- 正式版与 QA 版的区别；
- 未签名/未公证状态；
- 未在实机验证的项目；
- 用户手册链接。

## 注意

- 仓库保持 Private；Private 仓库的 Release 只有有权限的账号能下载；
- 不要把安装包提交进 Git 历史，只用 Release 资产；
- 不伪造签名、不伪造实机验收结论。
