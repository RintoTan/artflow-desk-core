# ArtFlow Desk Core

面向单画师的本地优先桌面委托管理工具。数据完全保存在本机，不依赖云同步、在线账号或客户网页。

> 产品名：**ArtFlow Desk Core**（2026-11-17 由 ArtFlow miniDesk 更名）。
> 应用标识仍为 `dev.artflow.minidesk`，数据目录、数据库与编号规则均未改变。

- 桌面外壳：Tauri 2（macOS / Windows）
- 前端：React 19 + TypeScript + Vite
- 数据：Rust + rusqlite（SQLite），所有 SQL 集中在 Rust 侧
- 应用标识：`dev.artflow.minidesk`

## 当前状态

**DEV-01 已完成：正式工程骨架与数据基座。**

已实现：

- 单一业务数据库（订单、订单阶段、生命周期事件、客户、模板、附件元数据、清理任务、主题、设置）
- 可演进的 schema 迁移链（v1），升级在隔离数据代际执行，验证后才切换指针
- 订单编号 `AF-YYYY-NNNN`：独立年度高水位，恢复旧备份不回退，删除不复用
- 持久工作时区（IANA）：改时区不改已保存的时间点
- 跨进程数据目录独占锁，第二个进程返回 `BUSY`
- 启动自检：严格区分"真正首次启动"与"数据环境异常"
- 最小正式窗口（Arctic Blue 基线）+ 环境状态页 + 可用的工作时区设置

**尚未实现**（见 `docs/DEV-CONVENTIONS.md` 与各页面标注）：

订单列表与详情、制作流程推进/返工/开工、客户管理、模板管理、队列排序、
工作台统计、CSV 导出、主题编辑器、附件导入与图片查看器、
完整备份与恢复、Windows 构建。

这不是 v1.0 的可交付版本。

## 开发

```bash
npm install
npm run tauri dev      # 启动桌面应用（开发模式）
npm run typecheck      # TypeScript 类型检查
npm run build          # 前端生产构建
cd src-tauri && cargo test   # Rust 测试（含真实双进程锁测试）
```

## 数据目录

macOS：`~/Library/Application Support/dev.artflow.minidesk/`

```text
environment.json        环境标记（区分首次启动与数据异常）
.write.lock             跨进程独占锁
state/
  active.json           活动数据代际指针
  highwater.sqlite      年度编号高水位（独立于业务代际）
generations/
  gen-<id>/
    database.sqlite     唯一业务数据库
    attachments/originals/   原图
    attachments/thumbs/      缩略图缓存
backups/                本地备份产物
recovery/state.json     未完成的恢复/升级事务
```

## 文档

- [开发规范](docs/DEV-CONVENTIONS.md)
- [技术实验归档](docs/tv/README.md)：TV-01～TV-03.5 的实验结论，**不是**正式功能验收
