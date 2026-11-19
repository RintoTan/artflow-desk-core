# 开发指南

## 环境要求

| 项 | 版本 |
| --- | --- |
| Node.js | 20+（CI 使用 20） |
| Rust | stable（MSVC 工具链用于 Windows） |
| macOS | 13.0+ 用于本地构建 |
| Xcode CLT | 提供 clang 与 macOS SDK |

## 依赖安装

```bash
npm ci
```

## 本地启动

```bash
npm run tauri dev                                   # 正式 identifier（会写正式数据目录）
AF_MINIDESK_QA_SCENARIO=seeded \
  npx tauri dev --config src-tauri/tauri.qa.conf.json   # QA 环境（推荐用于开发）
```

QA 场景：`clean`（空白）、`seeded`（演示数据）、`timeline-*`（时间线空态）。

## 测试

```bash
cargo test --manifest-path src-tauri/Cargo.toml   # Rust：migration / lifecycle / backup / 维护
npx vitest run                                     # 前端：页面与纯函数
npx tsc --noEmit                                   # 类型检查
npm run build                                      # 生产构建
```

约定：测试里不要硬编码平台假设（`HOME`、`/` 分隔符、unix 符号链接），跨平台用例要加 `cfg(unix)` 或做路径归一化。

## 目录说明

```
src/            前端（pages / components / lib / bridge）
src-tauri/      Rust（commands / domain / store / backup）
build/windows/  Windows 启动脚本（随 CI 产物分发）
docs/           产品、架构、开发、手册、发布文档
.github/workflows/windows-build.yml   Windows 构建
```

## 代码约定

- 前端不直接写库：所有写操作走 `commands`，内部 `BEGIN IMMEDIATE` + `revision` 乐观锁；
- 事件写入与状态变更在同一事务；
- 计划日期（纯日历日期）与事件时间（真实时间点）不混用；
- 新增事件类型必须同步迁移、领域层校验与前端展示。

## 数据安全

- 不要用正式 identifier 启动来"看看效果"——会触发正式库迁移；
- 不要手工改数据库或删除代际；
- 测试只用 `tempfile` 或 QA 场景目录。
