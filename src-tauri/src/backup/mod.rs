//! 数据备份与恢复（DEV-07 / FIN-07）。
//!
//! - `zip_read`：备份包读取与安全校验（DEV-01 已落地，这里复用，不另写一套规则）；
//! - `create`：SQLite 一致性快照 + 附件 + Manifest + SHA-256 → ZIP，写完自检；
//! - `restore`：隔离新代际解包 → 校验 → 迁移 → 引用核对 → 合并高水位 → 原子切换；
//! - `finance_guard`：恢复期的财务结构判定与平台配置回填（FIN-07）；
//! - `state`：最近成功备份时间与提醒周期（本机状态，不进业务库）。

pub mod create;
pub mod finance_guard;
pub mod manifest;
pub mod restore;
pub mod state;
pub mod zip_read;
