//! FIN-07：恢复期财务结构判定，以及「平台配置」的跨版本回填。
//!
//! 恢复面对的是**别的机器导出的库**，所以版本号与真实表结构可能对不上。
//! 本模块只做三件事：
//!
//! 1. 在**迁移之前**记录这份备份到底有没有四张财务表。迁移会把缺的表建出来，
//!    事后再判断就分不清「备份原本就有这张表」还是「迁移刚补的」——而规则 B
//!    的全部判断都压在这个区别上。
//! 2. 按声明的 schema 版本核对结构，不自洽就拒绝，不猜用户停在哪个版本。
//! 3. 回填平台配置。**只回填平台**：付款计划、收款与退款是业务历史，
//!    永远不从当前数据库搬进一份旧备份。
//!
//! 平台回填与 `domain::reset` 里那段回填有一处**刻意的不同**：重置是数据维护
//! 动作，时间戳原样搬运；备份恢复是「用这份快照重建环境」，产品裁定
//! `payment_platforms.updated_at` 记为本次恢复时刻，其余字段原样。两处语义不同，
//! 因此各自保留实现，不抽成一个公共函数假装它们是一回事。

use rusqlite::{params, Connection, TransactionBehavior};

use crate::error::{AppError, AppResult};

/// 业务历史三表：任何版本都**不回填**，只做前后行数比对。
pub const LEDGER_TABLES: [&str; 3] = [
    "payment_schedules",
    "payment_records",
    "refund_records",
];

/// v11 迁移的空表断言正好覆盖这三张表。
///
/// 判定 v10 备份能不能安全升级时必须三张一起看：只查计划与流水会放过
/// 「只有一个平台」的包，那照样会卡在迁移里。
pub const V10_GATE_TABLES: [&str; 3] = [
    "payment_platforms",
    "payment_schedules",
    "payment_records",
];

/// v11 + v12 建出来的 12 条触发器。v12 备份必须一条不少地带回来。
///
/// 名单与迁移脚本重复是有意的：恢复侧要断言的正是「迁移产物还在」，
/// 直接复用迁移里的常量，会让同一个笔误在两边一起隐身。
pub const FINANCE_TRIGGERS: [&str; 12] = [
    "payment_records_same_order_insert",
    "payment_records_same_order_update",
    "payment_schedules_order_update",
    "payment_records_kind_match_insert",
    "payment_records_kind_match_update",
    "payment_schedules_kind_locked",
    "refund_records_same_order_insert",
    "refund_records_same_order_update",
    "refund_records_payment_valid_insert",
    "refund_records_payment_valid_update",
    "refund_records_void_irreversible",
    "payment_records_void_blocked_by_refunds",
];

/// 某一份库里的财务表存在性快照。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Tables {
    pub platforms: bool,
    pub schedules: bool,
    pub records: bool,
    pub refunds: bool,
}

impl Tables {
    fn entries(&self) -> [(&'static str, bool); 4] {
        [
            ("payment_platforms", self.platforms),
            ("payment_schedules", self.schedules),
            ("payment_records", self.records),
            ("refund_records", self.refunds),
        ]
    }

    /// 已存在的财务表（用于「低版本不该有这些表」的报错列举）。
    pub fn present(&self) -> Vec<&'static str> {
        self.entries()
            .into_iter()
            .filter(|(_, exists)| *exists)
            .map(|(name, _)| name)
            .collect()
    }

    /// 缺失的财务表。
    pub fn missing(&self) -> Vec<&'static str> {
        self.entries()
            .into_iter()
            .filter(|(_, exists)| !exists)
            .map(|(name, _)| name)
            .collect()
    }
}

/// 名字存在即算存在，不管它是 table 还是 view 还是 index。
///
/// 用「名字」而不是「type='table'」是为了让后面的 COUNT 有机会报错：
/// 一个被换成坏视图的 `payment_records` 不该被当成「这版还没有财务表」而记 0。
pub fn object_exists(conn: &Connection, name: &str) -> AppResult<bool> {
    let found: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE name = ?1",
        [name],
        |r| r.get(0),
    )?;
    Ok(found > 0)
}

pub fn inspect(conn: &Connection) -> AppResult<Tables> {
    Ok(Tables {
        platforms: object_exists(conn, "payment_platforms")?,
        schedules: object_exists(conn, "payment_schedules")?,
        records: object_exists(conn, "payment_records")?,
        refunds: object_exists(conn, "refund_records")?,
    })
}

/// 表不存在 = 该版本还没有它，记 0；表存在却查不动 = 真故障，必须冒泡。
///
/// 这条区分是 FIN-07 的硬要求：`unwrap_or(0)` 会把「结构损坏」伪装成
/// 「这个版本一条都没有」，用户看到一份干净的空库，然后恢复出一份坏库。
pub fn count_table(conn: &Connection, table: &str) -> AppResult<i64> {
    if !object_exists(conn, table)? {
        return Ok(0);
    }
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| {
        r.get::<_, i64>(0)
    })
    .map_err(|e| AppError::db(format!("统计 {table} 失败：{e}")))
}

/// 迁移前的行数，用于迁移后比对「没多也没少」。
pub fn ledger_counts(conn: &Connection) -> AppResult<[i64; 3]> {
    Ok([
        count_table(conn, LEDGER_TABLES[0])?,
        count_table(conn, LEDGER_TABLES[1])?,
        count_table(conn, LEDGER_TABLES[2])?,
    ])
}

/// 版本号声明的结构，必须与库里真实存在的表一致。
///
/// - v9 及以前：四张表都不该存在（谁要是带了一张，说明版本号是假的）；
/// - v10 / v11：三张业务表必须在，退款表不该存在；
/// - v12：四张全在。
pub fn check_consistency(declared: i64, tables: &Tables) -> AppResult<()> {
    if declared <= 9 {
        let present = tables.present();
        if !present.is_empty() {
            return Err(AppError::schema(format!(
                "备份自称 schema v{declared}，却已经包含财务表（{}）。版本号与真实结构不一致，拒绝恢复。",
                present.join("、")
            )));
        }
        return Ok(());
    }

    let mut missing: Vec<&str> = Vec::new();
    if !tables.platforms {
        missing.push("payment_platforms");
    }
    if !tables.schedules {
        missing.push("payment_schedules");
    }
    if !tables.records {
        missing.push("payment_records");
    }
    // v12 才引入退款表。
    if declared >= 12 && !tables.refunds {
        missing.push("refund_records");
    }
    if !missing.is_empty() {
        return Err(AppError::schema(format!(
            "备份自称 schema v{declared}，但缺少财务表（{}）。版本号与真实结构不一致，拒绝恢复；不会替用户猜这个库属于哪个版本。",
            missing.join("、")
        )));
    }

    // 反过来也要拦：v10 / v11 声称的版本里没有退款表。
    if declared < 12 && tables.refunds {
        return Err(AppError::schema(format!(
            "备份自称 schema v{declared}，却已经包含退款表 refund_records。版本号与真实结构不一致，拒绝恢复。"
        )));
    }
    Ok(())
}

/// v10 备份若已经装了三张财务表里的数据，就没有安全的升级路径。
///
/// v11 的迁移以「三表为空」为前提：它按「建新表 → 确认旧的为空 → 删旧 → 改名」走，
/// `PRAGMA foreign_keys` 在事务内又是 no-op，非空时硬搬会静默抹掉关联。
/// 所以这里不改迁移，而是在用户按下确认之前把结论说清楚。
///
/// 预览与恢复**共用这一个谓词**：前端能不能点确认，不能代替后端自己再判一次。
/// 返回 `Some(说明)` 表示阻止，`None` 表示可以继续。
pub fn v10_blocker(declared: i64, conn: &Connection) -> AppResult<Option<String>> {
    if declared != 10 {
        return Ok(None);
    }
    let mut occupied: Vec<String> = Vec::new();
    for table in V10_GATE_TABLES {
        let rows = count_table(conn, table)?;
        if rows > 0 {
            occupied.push(format!("{table} {rows} 行"));
        }
    }
    if occupied.is_empty() {
        return Ok(None);
    }
    Ok(Some(format!(
        "该 v10 备份包含财务数据（{}），而当前版本的升级流程要求 v10 的财务表为空。为避免数据丢失，本次恢复已被阻止。当前设备的数据不会受到影响。",
        occupied.join("、")
    )))
}

/// 迁移完成后：四张表齐全、12 条触发器齐全。缺任何一样都说明这份库不完整。
pub fn require_complete_v12(conn: &Connection) -> AppResult<()> {
    let tables = inspect(conn)?;
    let missing = tables.missing();
    if !missing.is_empty() {
        return Err(AppError::schema(format!(
            "恢复后的数据库缺少财务表（{}），拒绝切换",
            missing.join("、")
        )));
    }
    let mut absent: Vec<&str> = Vec::new();
    for trigger in FINANCE_TRIGGERS {
        let found: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name = ?1",
            [trigger],
            |r| r.get(0),
        )?;
        if found != 1 {
            absent.push(trigger);
        }
    }
    if !absent.is_empty() {
        return Err(AppError::schema(format!(
            "恢复后的数据库缺少财务约束触发器（{}），拒绝切换",
            absent.join("、")
        )));
    }
    Ok(())
}

/// 一条平台配置在备份恢复之间的搬运形态。
///
/// 不含 `updated_at`：产品裁定恢复时把它写成「本次恢复时刻」，
/// 其余七个字段原样。
#[derive(Debug, Clone)]
pub struct Platform {
    pub id: String,
    pub name: String,
    pub fee_rate_bp: Option<i64>,
    pub archived: i64,
    pub sort_position: i64,
    pub created_at: String,
}

/// 读出当前代际的全部平台配置（含已归档）。NULL 费率仍然读成 NULL。
pub fn read_platforms(conn: &Connection) -> AppResult<Vec<Platform>> {
    if !object_exists(conn, "payment_platforms")? {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare(
        "SELECT id, name, fee_rate_bp, archived, sort_position, created_at
         FROM payment_platforms ORDER BY sort_position, created_at",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Platform {
                id: r.get(0)?,
                name: r.get(1)?,
                fee_rate_bp: r.get(2)?,
                archived: r.get(3)?,
                sort_position: r.get(4)?,
                created_at: r.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 把平台配置写进隔离代际。冲突就整体失败——绝不用 `INSERT OR IGNORE`
/// 把一份配置冲突悄悄咽下去。
pub fn backfill_platforms(conn: &mut Connection, rows: &[Platform], now: &str) -> AppResult<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    // release 构建里故障注入被编掉，`_index` 就没人用，前缀下划线避免编译告警。
    for (_index, row) in rows.iter().enumerate() {
        #[cfg(debug_assertions)]
        if fault::should_fail(_index) {
            return Err(AppError::db("平台配置回填失败（测试注入）"));
        }
        tx.execute(
            "INSERT INTO payment_platforms
               (id, name, fee_rate_bp, archived, sort_position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                row.id,
                row.name,
                row.fee_rate_bp,
                row.archived,
                row.sort_position,
                row.created_at,
                now
            ],
        )
        .map_err(|e| AppError::db(format!("平台配置回填失败（{}）：{e}", row.name)))?;
        #[cfg(debug_assertions)]
        fault::note_inserted();
    }
    tx.commit()?;
    Ok(())
}

/// 仅用于测试的故障注入点。
///
/// 为什么需要：「回填中途失败必须不切 activity 指针」是规则 B 唯一构造不出来的分支
/// ——新旧代际 schema 相同，不可能造出「旧合法、新非法」的平台数据。这里用一个
/// **只在 debug 构建里存在**的线程内计数器让第 N 次 INSERT 直接报错。
///
/// 边界：release 构建里整个 `fault` 模块与调用点都被编掉，没有命令、没有设置、
/// 没有环境变量能在生产环境打开它。
#[cfg(debug_assertions)]
mod fault {
    use std::cell::Cell;

    thread_local! {
        static FAIL_AFTER: Cell<Option<usize>> = const { Cell::new(None) };
        static INSERTED: Cell<usize> = const { Cell::new(0) };
    }

    pub fn arm(after: usize) {
        FAIL_AFTER.with(|cell| cell.set(Some(after)));
        INSERTED.with(|cell| cell.set(0));
    }

    pub fn disarm() {
        FAIL_AFTER.with(|cell| cell.set(None));
        INSERTED.with(|cell| cell.set(0));
    }

    pub fn should_fail(index: usize) -> bool {
        FAIL_AFTER.with(|cell| cell.get() == Some(index))
    }

    pub fn note_inserted() {
        INSERTED.with(|cell| cell.set(cell.get() + 1));
    }

    pub fn inserted() -> usize {
        INSERTED.with(|cell| cell.get())
    }
}

/// 供集成测试启用注入。`#[doc(hidden)]` + debug-only：不是 API。
#[cfg(debug_assertions)]
#[doc(hidden)]
pub fn __arm_platform_backfill_failure(after: usize) {
    fault::arm(after);
}

#[cfg(debug_assertions)]
#[doc(hidden)]
pub fn __disarm_platform_backfill_failure() {
    fault::disarm();
}

/// 本次注入已成功写入几条平台配置，用来证明「确实写到一半才失败」。
#[cfg(debug_assertions)]
#[doc(hidden)]
pub fn __platform_backfill_inserted() -> usize {
    fault::inserted()
}
