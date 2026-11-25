//! FIN-07：财务数据的备份摘要、v12 完整性、旧版本迁移与「平台配置」回填（规则 B）。
//!
//! 证据边界与 `backup_v8_lineage` 一致：库由**正式迁移链**建到目标版本，
//! 包由程序自身 `create` 产出，恢复走真实 `restore` 全链路。
//! 数据是构造的——它证明链路与规则成立，**不证明**某台旧机器上真实导出的包可用。
//!
//! 版本矩阵里有一处必须说清的边界：v10 的库**不可能带着财务数据**升到 v11，
//! 因为 v11 的迁移以「三张表必须为空」为前提（v10 至今没有任何写入入口）。
//! 因此 v10 夹具只覆盖「表存在但为空」这一合法形态；带数据的严格恢复用 v11 夹具证明。

mod common;

use std::path::Path;

use minidesk::backup::{create, finance_guard, manifest, restore};
use minidesk::store::environment::Environment;
use minidesk::store::highwater::HighWater;
use minidesk::store::migrations;
use rusqlite::Connection;

// ------------------------------------------------------------------ 夹具

fn open_at(root: &Path, version: i64) -> Environment {
    Environment::open_with(
        root,
        &migrations::production(),
        version,
        Some(common::tz()),
    )
    .expect("打开数据环境失败")
}

fn hw(env: &Environment) -> HighWater {
    HighWater::open(&env.layout().highwater_db()).expect("打开编号记录失败")
}

fn backup(env: &Environment, target: &Path) {
    create::create(env, &hw(env), target).expect("导出备份失败");
}

fn new_order(env: &Environment, code: &str, title: &str) -> String {
    let mut conn = env.open_db().unwrap();
    common::insert_order(&mut conn, code, title)
}

fn platform(conn: &Connection, id: &str, name: &str, fee: Option<i64>, archived: i64, sort: i64) {
    conn.execute(
        "INSERT INTO payment_platforms
           (id, name, fee_rate_bp, archived, sort_position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, '2026-08-01T09:00:00+08:00', '2026-09-01T09:00:00+08:00')",
        rusqlite::params![id, name, fee, archived, sort],
    )
    .expect("插入平台失败");
}

fn schedule(
    conn: &Connection,
    id: &str,
    order_id: &str,
    kind: &str,
    amount: i64,
    expected: Option<&str>,
    sort: i64,
) {
    conn.execute(
        "INSERT INTO payment_schedules
           (id, order_id, kind, amount_cents, expected_date, sort_position, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, '2026-09-01T09:00:00+08:00')",
        rusqlite::params![id, order_id, kind, amount, expected, sort],
    )
    .expect("插入付款计划失败");
}

/// 收款流水：字段多且约束密（STRICT、费率快照、作废成对），用结构体省掉一长串位置参数。
struct Rec<'a> {
    id: &'a str,
    order_id: &'a str,
    schedule_id: Option<&'a str>,
    kind: &'a str,
    amount: i64,
    received_on: &'a str,
    platform_id: Option<&'a str>,
    platform_name: Option<&'a str>,
    fee_rate_bp: Option<i64>,
    fee: i64,
    voided: Option<(&'a str, &'a str)>,
    request_id: Option<&'a str>,
}

fn record(conn: &Connection, r: Rec<'_>) {
    let (voided_at, void_reason) = match r.voided {
        Some((at, why)) => (Some(at), Some(why)),
        None => (None, None),
    };
    conn.execute(
        "INSERT INTO payment_records
           (id, order_id, schedule_id, kind, amount_cents, received_on, platform_id, platform_name,
            fee_rate_bp, fee_cents, method, note, voided_at, void_reason, request_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'wechat', NULL, ?11, ?12, ?13,
                 '2026-09-02T09:00:00+08:00')",
        rusqlite::params![
            r.id,
            r.order_id,
            r.schedule_id,
            r.kind,
            r.amount,
            r.received_on,
            r.platform_id,
            r.platform_name,
            r.fee_rate_bp,
            r.fee,
            voided_at,
            void_reason,
            r.request_id
        ],
    )
    .expect("插入收款流水失败");
}

#[allow(clippy::too_many_arguments)]
fn refund(
    conn: &Connection,
    id: &str,
    order_id: &str,
    payment_record_id: Option<&str>,
    amount: i64,
    refunded_on: &str,
    voided: Option<(&str, &str)>,
    request_id: Option<&str>,
) {
    let (voided_at, void_reason) = match voided {
        Some((at, why)) => (Some(at), Some(why)),
        None => (None, None),
    };
    conn.execute(
        "INSERT INTO refund_records
           (id, order_id, payment_record_id, amount_cents, refunded_on, method, note,
            voided_at, void_reason, request_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'alipay', NULL, ?6, ?7, ?8, '2026-09-03T09:00:00+08:00')",
        rusqlite::params![
            id,
            order_id,
            payment_record_id,
            amount,
            refunded_on,
            voided_at,
            void_reason,
            request_id
        ],
    )
    .expect("插入退款失败");
}

/// 整表逐字段导出：`SELECT *` 拼出每一行的全部列值，排序后比对。
/// 用 `*` 是故意的——将来加列时这里会跟着比，不会因为只列了已知字段而漏掉。
fn dump(conn: &Connection, table: &str) -> Vec<String> {
    let sql = format!("SELECT * FROM {table}");
    let mut stmt = conn.prepare(&sql).unwrap();
    let cols = stmt.column_count();
    let mut rows: Vec<String> = stmt
        .query_map([], |r| {
            let mut line = String::new();
            for i in 0..cols {
                let value: rusqlite::types::Value = r.get(i)?;
                line.push_str(&format!("{value:?}"));
                line.push('\u{1f}');
            }
            Ok(line)
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    rows.sort();
    rows
}

/// 平台配置的「除 updated_at 外全字段」视图，用来做逐字段比对。
fn platform_rows(conn: &Connection) -> Vec<String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, fee_rate_bp, archived, sort_position, created_at
               FROM payment_platforms ORDER BY id",
        )
        .unwrap();
    let rows = stmt
        .query_map([], |r| {
            Ok(format!(
                "{}|{}|{:?}|{}|{}|{}",
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<i64>>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, String>(5)?
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    rows
}

fn count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

// ------------------------------------------------------------------ 1. v12 完整性

/// 四张表逐字段往返：归档平台、作废流水、作废退款、未关联退款、
/// 快照费率、`request_id` 幂等键、已解除计划关联的流水，一个都不许丢或变。
#[test]
fn v12_backup_restores_every_finance_field() {
    let dir = tempfile::tempdir().unwrap();
    let src = open_at(&dir.path().join("src"), migrations::APP_SCHEMA_VERSION);
    let o1 = new_order(&src, "AF-2026-3001", "双人插画");
    let o2 = new_order(&src, "AF-2026-3002", "封面绘制");
    {
        let conn = src.open_db().unwrap();
        platform(&conn, "p1", "米画师", Some(500), 0, 0);
        platform(&conn, "p2", "Pixiv", None, 1, 1); // 已归档、费率未配置
        schedule(&conn, "s1", &o1, "deposit", 30000, Some("2026-11-01"), 0);
        schedule(&conn, "s2", &o1, "final", 70000, None, 1);
        record(
            &conn,
            Rec {
                id: "r1",
                order_id: &o1,
                schedule_id: Some("s1"),
                kind: "deposit",
                amount: 30000,
                received_on: "2026-11-02",
                platform_id: Some("p1"),
                platform_name: Some("米画师"),
                fee_rate_bp: Some(500),
                fee: 150,
                voided: None,
                request_id: None,
            },
        );
        record(
            &conn,
            Rec {
                id: "r2",
                order_id: &o1,
                schedule_id: Some("s2"),
                kind: "final",
                amount: 70000,
                received_on: "2026-11-20",
                platform_id: Some("p2"),
                platform_name: Some("Pixiv"),
                fee_rate_bp: None, // 未配置费率 ≠ 0%
                fee: 0,
                voided: None,
                request_id: Some("req-fin-2"),
            },
        );
        // 作废流水 + 已解除计划关联（schedule_id 为空）
        record(
            &conn,
            Rec {
                id: "r3",
                order_id: &o2,
                schedule_id: None,
                kind: "full",
                amount: 50000,
                received_on: "2026-10-11",
                platform_id: Some("p1"),
                platform_name: Some("米画师"),
                fee_rate_bp: Some(500),
                fee: 250,
                voided: Some(("2026-10-12T10:00:00+08:00", "录错金额")),
                request_id: None,
            },
        );
        refund(&conn, "f1", &o1, Some("r1"), 10000, "2026-11-05", None, None);
        refund(&conn, "f2", &o2, None, 5000, "2026-10-13", None, None); // 未关联原收款
        // 作废退款 + 幂等键。不挂收款：v12 禁止把退款关联到已作废的收款上。
        refund(
            &conn,
            "f3",
            &o2,
            None,
            2000,
            "2026-10-14",
            Some(("2026-10-15T10:00:00+08:00", "重复登记")),
            Some("req-refund-3"),
        );
    }

    let zip = dir.path().join("v12.zip");
    backup(&src, &zip);

    // 目的机先有自己的平台，用来证明「备份有平台表时以备份为准，不合并」。
    let dst_root = dir.path().join("dst");
    let dst = open_at(&dst_root, migrations::APP_SCHEMA_VERSION);
    {
        let conn = dst.open_db().unwrap();
        platform(&conn, "local-a", "本机甲", Some(100), 0, 0);
        platform(&conn, "local-b", "本机乙", Some(200), 0, 1);
    }

    let done = restore::restore(&dst, &hw(&dst), &zip, &migrations::production()).unwrap();
    assert_eq!(done.migrated_from, migrations::APP_SCHEMA_VERSION);

    drop(dst);
    let after = common::open(&dst_root);
    let src_conn = src.open_db().unwrap();
    let dst_conn = after.open_db().unwrap();

    for table in [
        "payment_platforms",
        "payment_schedules",
        "payment_records",
        "refund_records",
    ] {
        assert_eq!(
            dump(&dst_conn, table),
            dump(&src_conn, table),
            "{table} 逐字段不一致"
        );
    }

    // 摘要与真实库存对齐；本机那两条平台没有混进来。
    assert_eq!(done.summary.payment_platforms, 2);
    assert_eq!(done.summary.payment_schedules, 2);
    assert_eq!(done.summary.payment_records, 3);
    assert_eq!(done.summary.refund_records, 3);

    // 触发器必须跟着回来（v12 备份的约束不是装饰）。
    let triggers: i64 = dst_conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger'
               AND name IN ('refund_records_void_irreversible',
                            'payment_records_void_blocked_by_refunds',
                            'payment_records_kind_match_insert')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(triggers, 3);

    let integrity: String = dst_conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .unwrap();
    assert_eq!(integrity, "ok");
    assert_eq!(done.missing_thumbs, 0);
}

// ------------------------------------------------------------------ 2. 摘要口径

/// 摘要是**库存清单**：已归档平台、已作废流水、回收站订单挂着的收款都要数。
#[test]
fn summary_counts_finance_rows_like_an_inventory() {
    let dir = tempfile::tempdir().unwrap();
    let env = open_at(&dir.path().join("src"), migrations::APP_SCHEMA_VERSION);
    let o1 = new_order(&env, "AF-2026-3101", "正常订单");
    let o2 = new_order(&env, "AF-2026-3102", "将被删掉的订单");
    {
        let conn = env.open_db().unwrap();
        platform(&conn, "p1", "米画师", Some(500), 0, 0);
        platform(&conn, "p2", "已停用平台", None, 1, 1);
        schedule(&conn, "s1", &o1, "full", 100000, Some("2026-11-10"), 0);
        record(
            &conn,
            Rec {
                id: "r1",
                order_id: &o1,
                schedule_id: Some("s1"),
                kind: "full",
                amount: 100000,
                received_on: "2026-11-10",
                platform_id: Some("p1"),
                platform_name: Some("米画师"),
                fee_rate_bp: Some(500),
                fee: 500,
                voided: None,
                request_id: None,
            },
        );
        record(
            &conn,
            Rec {
                id: "r2",
                order_id: &o2,
                schedule_id: None,
                kind: "deposit",
                amount: 20000,
                received_on: "2026-11-11",
                platform_id: None,
                platform_name: None,
                fee_rate_bp: None,
                fee: 0,
                voided: Some(("2026-11-12T09:00:00+08:00", "重复录入")),
                request_id: None,
            },
        );
        refund(&conn, "f1", &o1, Some("r1"), 1000, "2026-11-13", None, None);
        refund(
            &conn,
            "f2",
            &o2,
            None,
            200,
            "2026-11-14",
            Some(("2026-11-15T09:00:00+08:00", "误记")),
            None,
        );
        // 订单进回收站：财务记录仍属于库内容，必须照数。
        conn.execute(
            "UPDATE orders SET deleted_at = '2026-11-16T09:00:00+08:00' WHERE id = ?1",
            [&o2],
        )
        .unwrap();
    }

    let conn = env.open_db().unwrap();
    let summary = manifest::summarize(&conn).unwrap();
    assert_eq!(summary.payment_platforms, 2, "已归档平台也要数");
    assert_eq!(summary.payment_schedules, 1);
    assert_eq!(summary.payment_records, 2, "已作废流水也要数");
    assert_eq!(summary.refund_records, 2, "已作废退款也要数");
    assert_eq!(summary.trashed_orders, 1);

    // 摘要是数量清单，不含金额/客户信息：JSON 里不该出现金额字段名与客户名。
    let json = serde_json::to_string(&summary).unwrap();
    for forbidden in ["amount", "fee", "客户", "米画师"] {
        assert!(!json.contains(forbidden), "摘要里泄漏了 {forbidden}：{json}");
    }
}

/// 导出摘要与恢复预览摘要必须说同一件事——两处口径不同会让人以为恢复了另一份数据。
#[test]
fn backup_export_and_preview_summaries_agree() {
    let dir = tempfile::tempdir().unwrap();
    let env = open_at(&dir.path().join("src"), migrations::APP_SCHEMA_VERSION);
    let o1 = new_order(&env, "AF-2026-3201", "订单");
    {
        let conn = env.open_db().unwrap();
        platform(&conn, "p1", "米画师", Some(500), 0, 0);
        schedule(&conn, "s1", &o1, "full", 60000, None, 0);
        record(
            &conn,
            Rec {
                id: "r1",
                order_id: &o1,
                schedule_id: Some("s1"),
                kind: "full",
                amount: 60000,
                received_on: "2026-11-09",
                platform_id: Some("p1"),
                platform_name: Some("米画师"),
                fee_rate_bp: Some(500),
                fee: 300,
                voided: None,
                request_id: None,
            },
        );
        refund(&conn, "f1", &o1, Some("r1"), 600, "2026-11-10", None, None);
    }

    let zip = dir.path().join("v12.zip");
    let created = create::create(&env, &hw(&env), &zip).unwrap();
    let preview = restore::preview(&env, &zip).unwrap();

    assert_eq!(preview.summary.payment_platforms, created.summary.payment_platforms);
    assert_eq!(preview.summary.payment_schedules, created.summary.payment_schedules);
    assert_eq!(preview.summary.payment_records, created.summary.payment_records);
    assert_eq!(preview.summary.refund_records, created.summary.refund_records);
    assert_eq!(preview.summary.payment_records, 1);
    assert!(preview.can_restore);
    // v12 备份没有兼容补丁要交代。
    assert!(
        !preview.warnings.iter().any(|w| w.contains("平台配置")),
        "{:?}",
        preview.warnings
    );
}

// ------------------------------------------------------------------ 3. 缺表 ≠ 0 的边界

#[test]
fn old_schema_without_finance_tables_reports_zero() {
    let dir = tempfile::tempdir().unwrap();
    let env = open_at(&dir.path().join("src"), 9);
    new_order(&env, "AF-2026-3301", "旧订单");

    let conn = env.open_db().unwrap();
    let tables = finance_guard::inspect(&conn).unwrap();
    assert_eq!(
        tables,
        finance_guard::Tables::default(),
        "v9 不该有财务表"
    );

    let summary = manifest::summarize(&conn).unwrap();
    assert_eq!(summary.payment_platforms, 0);
    assert_eq!(summary.payment_schedules, 0);
    assert_eq!(summary.payment_records, 0);
    assert_eq!(summary.refund_records, 0);
}

/// 结构损坏不能被 `unwrap_or(0)` 伪装成「这个版本一条都没有」。
#[test]
fn broken_finance_table_errors_instead_of_reporting_zero() {
    let dir = tempfile::tempdir().unwrap();
    let env = open_at(&dir.path().join("src"), migrations::APP_SCHEMA_VERSION);
    {
        let conn = env.open_db().unwrap();
        conn.execute_batch(
            "DROP TABLE refund_records;
             CREATE VIEW refund_records AS SELECT * FROM table_that_never_existed;",
        )
        .unwrap();
    }

    let conn = env.open_db().unwrap();
    let err = manifest::summarize(&conn).expect_err("统计失败必须冒泡，不能记 0");
    assert_eq!(err.code, "DB", "{}", err.code);
    assert!(err.message.contains("refund_records"), "{}", err.message);
}

/// v12 备份少一条退款触发器 → 结构不完整，恢复必须在切换前失败。
///
/// 这条守的是「表在但约束没了」：那样的库能读能写，却会放过跨订单退款。
#[test]
fn v12_backup_missing_finance_trigger_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let src = open_at(&dir.path().join("src"), migrations::APP_SCHEMA_VERSION);
    new_order(&src, "AF-2026-3851", "订单");
    {
        let conn = src.open_db().unwrap();
        conn.execute_batch("DROP TRIGGER refund_records_void_irreversible;")
            .unwrap();
    }
    let zip = dir.path().join("v12-no-trigger.zip");
    backup(&src, &zip);

    let dst_root = dir.path().join("dst");
    let dst = open_at(&dst_root, migrations::APP_SCHEMA_VERSION);
    new_order(&dst, "AF-2026-0975", "现有订单");

    let err = restore::restore(&dst, &hw(&dst), &zip, &migrations::production()).unwrap_err();
    assert_eq!(err.code, "SCHEMA", "{}", err.message);
    assert!(err.message.contains("触发器"), "{}", err.message);

    let conn = dst.open_db().unwrap();
    assert_eq!(count(&conn, "orders"), 1, "失败不得改动现有数据");
}

// ------------------------------------------------------------------ 4. 规则 B

/// B1 / B2 / B3 / B11 / B12：旧备份没有平台表 → 回填本机平台，
/// 但付款计划、收款、退款一行都不搬。
#[test]
fn v9_backup_backfills_current_platforms_and_nothing_else() {
    let dir = tempfile::tempdir().unwrap();
    let src = open_at(&dir.path().join("src"), 9);
    new_order(&src, "AF-2026-3401", "旧年委托");
    let zip = dir.path().join("v9.zip");
    backup(&src, &zip);

    let dst_root = dir.path().join("dst");
    let dst = open_at(&dst_root, migrations::APP_SCHEMA_VERSION);
    let keep = new_order(&dst, "AF-2026-0900", "现有订单");
    {
        let conn = dst.open_db().unwrap();
        platform(&conn, "cur-1", "米画师", Some(500), 0, 2);
        platform(&conn, "cur-2", "画加", None, 1, 0); // 已归档、费率未配置
        platform(&conn, "cur-3", "Pixiv", Some(0), 0, 1); // 明确 0%
        schedule(&conn, "s-keep", &keep, "full", 80000, None, 0);
        record(
            &conn,
            Rec {
                id: "r-keep",
                order_id: &keep,
                schedule_id: Some("s-keep"),
                kind: "full",
                amount: 80000,
                received_on: "2026-11-01",
                platform_id: Some("cur-1"),
                platform_name: Some("米画师"),
                fee_rate_bp: Some(500),
                fee: 400,
                voided: None,
                request_id: None,
            },
        );
        refund(&conn, "f-keep", &keep, Some("r-keep"), 800, "2026-11-02", None, None);
    }
    let before = platform_rows(&dst.open_db().unwrap());
    assert_eq!(before.len(), 3);

    let done = restore::restore(&dst, &hw(&dst), &zip, &migrations::production()).unwrap();
    assert_eq!(done.migrated_from, 9);
    assert!(
        done.warnings.iter().any(|w| w.contains("保留当前设备的 3 个平台")),
        "{:?}",
        done.warnings
    );
    assert!(
        done.warnings.iter().any(|w| w.contains("付款计划")),
        "必须说清业务历史不会被补：{:?}",
        done.warnings
    );

    drop(dst);
    let after = common::open(&dst_root);
    let conn = after.open_db().unwrap();

    // B3：除 updated_at 外逐字段一致；updated_at 记为本次恢复时刻。
    let got = platform_rows(&conn);
    assert_eq!(got, before, "平台配置必须逐字段原样保留");

    let stale: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM payment_platforms WHERE updated_at = '2026-09-01T09:00:00+08:00'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(stale, 0, "updated_at 应写成恢复时刻");

    // B11 / B12：业务历史一律不回填。
    assert_eq!(count(&conn, "payment_schedules"), 0, "付款计划不得回填");
    assert_eq!(count(&conn, "payment_records"), 0, "收款不得回填");
    assert_eq!(count(&conn, "refund_records"), 0, "退款不得回填");
    assert_eq!(
        count(&conn, "orders"),
        1,
        "恢复后订单应来自备份，而不是与现有数据合并"
    );
    assert_eq!(done.summary.payment_platforms, 3, "摘要要报回填后的真实数量");
    assert_eq!(done.summary.payment_records, 0);
}

/// B4 / B8 / B9：备份的平台表存在但为空 → 保持空表，不与本机配置合并。
///
/// 这条是规则 B 最容易做错的地方：判断依据必须是「备份原本有没有这张表」，
/// 而不是「备份里有没有平台」。旧库迁移后也会出现这张表，用迁移后的表存在性判断
/// 就永远会回填。
#[test]
fn v10_backup_with_empty_platform_table_is_not_merged() {
    let dir = tempfile::tempdir().unwrap();
    let src = open_at(&dir.path().join("src"), 10);
    new_order(&src, "AF-2026-3501", "v10 订单");
    {
        let conn = src.open_db().unwrap();
        assert_eq!(count(&conn, "payment_platforms"), 0);
    }
    let zip = dir.path().join("v10.zip");
    let created = create::create(&src, &hw(&src), &zip).unwrap();
    assert_eq!(created.summary.payment_platforms, 0);

    let dst_root = dir.path().join("dst");
    let dst = open_at(&dst_root, migrations::APP_SCHEMA_VERSION);
    {
        let conn = dst.open_db().unwrap();
        platform(&conn, "local-a", "本机甲", Some(100), 0, 0);
        platform(&conn, "local-b", "本机乙", Some(200), 0, 1);
    }

    let done = restore::restore(&dst, &hw(&dst), &zip, &migrations::production()).unwrap();
    assert!(
        !done.warnings.iter().any(|w| w.contains("保留当前设备")),
        "备份本来就有平台表，不该回填：{:?}",
        done.warnings
    );
    assert!(
        done.warnings.iter().any(|w| w.contains("退款记录结构")),
        "v10 没有退款表，必须提前说明：{:?}",
        done.warnings
    );

    drop(dst);
    let after = common::open(&dst_root);
    let conn = after.open_db().unwrap();
    assert_eq!(count(&conn, "payment_platforms"), 0, "空表就是空表");
    assert_eq!(done.summary.payment_platforms, 0);
}

/// B5：v11 备份带着平台与流水 → 严格恢复备份内容，本机的另一套平台不混入。
#[test]
fn v11_backup_keeps_its_own_platforms_and_ledger() {
    let dir = tempfile::tempdir().unwrap();
    let src = open_at(&dir.path().join("src"), 11);
    let o1 = new_order(&src, "AF-2026-3601", "v11 订单");
    {
        let conn = src.open_db().unwrap();
        platform(&conn, "bp-1", "备份平台一", Some(800), 0, 0);
        platform(&conn, "bp-2", "备份平台二", None, 1, 1);
        schedule(&conn, "bs-1", &o1, "deposit", 40000, Some("2026-10-20"), 0);
        record(
            &conn,
            Rec {
                id: "br-1",
                order_id: &o1,
                schedule_id: Some("bs-1"),
                kind: "deposit",
                amount: 40000,
                received_on: "2026-10-20",
                platform_id: Some("bp-1"),
                platform_name: Some("备份平台一"),
                fee_rate_bp: Some(800),
                fee: 320,
                voided: None,
                request_id: Some("req-v11-1"),
            },
        );
        record(
            &conn,
            Rec {
                id: "br-2",
                order_id: &o1,
                schedule_id: None,
                kind: "deposit",
                amount: 5000,
                received_on: "2026-10-21",
                platform_id: None,
                platform_name: None,
                fee_rate_bp: None,
                fee: 0,
                voided: Some(("2026-10-22T09:00:00+08:00", "录重了")),
                request_id: None,
            },
        );
    }
    let zip = dir.path().join("v11.zip");
    backup(&src, &zip);

    let dst_root = dir.path().join("dst");
    let dst = open_at(&dst_root, migrations::APP_SCHEMA_VERSION);
    let local = new_order(&dst, "AF-2026-0950", "本机订单");
    {
        let conn = dst.open_db().unwrap();
        platform(&conn, "local-a", "本机甲", Some(100), 0, 0);
        schedule(&conn, "local-s", &local, "full", 1000, None, 0);
    }

    let done = restore::restore(&dst, &hw(&dst), &zip, &migrations::production()).unwrap();
    assert_eq!(done.migrated_from, 11);

    drop(dst);
    let after = common::open(&dst_root);
    let src_conn = src.open_db().unwrap();
    let dst_conn = after.open_db().unwrap();

    for table in ["payment_platforms", "payment_schedules", "payment_records"] {
        assert_eq!(
            dump(&dst_conn, table),
            dump(&src_conn, table),
            "{table} 必须以备份为准"
        );
    }
    assert_eq!(count(&dst_conn, "refund_records"), 0, "v11 升级后是空退款表");
    assert_eq!(done.summary.payment_platforms, 2);
    assert_eq!(done.summary.payment_records, 2);
    assert_eq!(done.summary.refund_records, 0);
}

// ------------------------------------------------------------------ 5. 版本与结构闸门

/// B7：v10 声称有财务表，实际没有 → 拒绝，且不动现有数据。
#[test]
fn v10_missing_platform_table_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let src = open_at(&dir.path().join("src"), 10);
    new_order(&src, "AF-2026-3701", "v10 订单");
    {
        let conn = src.open_db().unwrap();
        conn.execute_batch("DROP TABLE payment_records; DROP TABLE payment_platforms;")
            .unwrap();
    }
    let zip = dir.path().join("v10-broken.zip");
    backup(&src, &zip);

    let dst_root = dir.path().join("dst");
    let dst = open_at(&dst_root, migrations::APP_SCHEMA_VERSION);
    new_order(&dst, "AF-2026-0960", "现有订单");
    {
        let conn = dst.open_db().unwrap();
        platform(&conn, "local-a", "本机甲", Some(100), 0, 0);
    }

    let err = restore::restore(&dst, &hw(&dst), &zip, &migrations::production()).unwrap_err();
    assert!(
        err.code == "SCHEMA" || err.code == "ZIP",
        "必须明确拒绝：{} {}",
        err.code,
        err.message
    );
    assert!(
        err.message.contains("payment_platforms") || err.message.contains("结构"),
        "{}",
        err.message
    );

    let conn = dst.open_db().unwrap();
    assert_eq!(count(&conn, "orders"), 1, "失败不得改动现有数据");
    assert_eq!(count(&conn, "payment_platforms"), 1);
}

/// v12 声称有退款表，实际没有 → 预览就要拦住，恢复也必须拒绝。
#[test]
fn v12_missing_refund_table_is_refused_in_preview_and_restore() {
    let dir = tempfile::tempdir().unwrap();
    let src = open_at(&dir.path().join("src"), migrations::APP_SCHEMA_VERSION);
    new_order(&src, "AF-2026-3801", "订单");
    {
        let conn = src.open_db().unwrap();
        conn.execute_batch("DROP TABLE refund_records;").unwrap();
    }
    let zip = dir.path().join("v12-broken.zip");
    backup(&src, &zip);

    let dst_root = dir.path().join("dst");
    let dst = open_at(&dst_root, migrations::APP_SCHEMA_VERSION);
    new_order(&dst, "AF-2026-0970", "现有订单");

    let preview = restore::preview(&dst, &zip).unwrap();
    assert!(!preview.can_restore, "预览必须拦住结构不一致的包");
    let reason = preview.block_reason.clone().unwrap();
    assert!(reason.contains("refund_records"), "{reason}");

    let err = restore::restore(&dst, &hw(&dst), &zip, &migrations::production()).unwrap_err();
    assert_eq!(err.code, "SCHEMA", "{}", err.message);
    let conn = dst.open_db().unwrap();
    assert_eq!(count(&conn, "orders"), 1);
}

/// manifest 声明的版本与库内 `user_version` 不一致 → 拒绝。
#[test]
fn manifest_version_that_disagrees_with_database_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let src = open_at(&dir.path().join("src"), 11);
    new_order(&src, "AF-2026-3901", "订单");
    let zip = dir.path().join("v11.zip");
    backup(&src, &zip);

    // 把 manifest 说成 v12，库其实停在 v11。
    let bumped = dir.path().join("bumped.zip");
    rewrite_manifest(&zip, &bumped, |v| {
        v["schemaVersion"] = serde_json::Value::from(12);
    });

    let dst_root = dir.path().join("dst");
    let dst = open_at(&dst_root, migrations::APP_SCHEMA_VERSION);
    new_order(&dst, "AF-2026-0980", "现有订单");

    let err = restore::restore(&dst, &hw(&dst), &bumped, &migrations::production()).unwrap_err();
    assert_eq!(err.code, "SCHEMA", "{}", err.message);
    assert!(err.message.contains("版本号"), "{}", err.message);
    let conn = dst.open_db().unwrap();
    assert_eq!(count(&conn, "orders"), 1);
}

/// 低版本号却带着高版本财务表 → 版本号是假的，拒绝。
#[test]
fn old_version_declaration_with_finance_tables_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let src = open_at(&dir.path().join("src"), migrations::APP_SCHEMA_VERSION);
    new_order(&src, "AF-2026-4001", "订单");
    {
        let conn = src.open_db().unwrap();
        platform(&conn, "p1", "米画师", Some(500), 0, 0);
    }
    let zip = dir.path().join("v12.zip");
    backup(&src, &zip);

    // 构造「自称 v9、实际有财务表」的不自洽包：两处一起改，才能走到结构判定。
    let lying = dir.path().join("lying.zip");
    rewrite_manifest(&zip, &lying, |v| {
        v["schemaVersion"] = serde_json::Value::from(9);
    });
    rewrite_database(&lying, &lying, |conn| {
        conn.pragma_update(None, "user_version", 9i64).unwrap();
    });

    let dst_root = dir.path().join("dst");
    let dst = open_at(&dst_root, migrations::APP_SCHEMA_VERSION);
    new_order(&dst, "AF-2026-0990", "现有订单");

    let err = restore::restore(&dst, &hw(&dst), &lying, &migrations::production()).unwrap_err();
    assert_eq!(err.code, "SCHEMA", "{}", err.message);
    assert!(err.message.contains("财务表"), "{}", err.message);
    let conn = dst.open_db().unwrap();
    assert_eq!(count(&conn, "orders"), 1);
}

// ------------------------------------------------------------------ 6. 故障注入

/// B10：平台回填写到一半失败 → 不切活动代际，现有数据一字不动。
#[cfg(debug_assertions)]
#[test]
fn platform_backfill_failure_midway_keeps_active_generation() {
    let dir = tempfile::tempdir().unwrap();
    let src = open_at(&dir.path().join("src"), 9);
    new_order(&src, "AF-2026-4101", "旧年委托");
    let zip = dir.path().join("v9.zip");
    backup(&src, &zip);

    let dst_root = dir.path().join("dst");
    let dst = open_at(&dst_root, migrations::APP_SCHEMA_VERSION);
    new_order(&dst, "AF-2026-1000", "现有订单");
    {
        let conn = dst.open_db().unwrap();
        platform(&conn, "cur-1", "米画师", Some(500), 0, 0);
        platform(&conn, "cur-2", "画加", None, 0, 1);
    }
    let generation_before = dst.active_generation().to_string();

    // 让第 2 条 INSERT 失败：第 1 条已经写进隔离代际，之后整步必须放弃。
    finance_guard::__arm_platform_backfill_failure(1);
    let result = restore::restore(&dst, &hw(&dst), &zip, &migrations::production());
    let inserted = finance_guard::__platform_backfill_inserted();
    finance_guard::__disarm_platform_backfill_failure();

    assert_eq!(inserted, 1, "应当先成功写入 1 条，再让第 2 条失败");
    let err = result.expect_err("回填中途失败必须整次失败");
    assert_eq!(err.code, "DB", "{}", err.message);
    assert!(err.message.contains("平台配置回填失败"), "{}", err.message);

    assert_eq!(
        dst.active_generation(),
        generation_before,
        "失败不得切换活动代际"
    );
    let conn = dst.open_db().unwrap();
    assert_eq!(count(&conn, "payment_platforms"), 2, "现有平台仍在");
    assert_eq!(count(&conn, "orders"), 1, "现有订单未受影响");

    // 失败现场被挪到 recovery/，不会留在 generations/ 里冒充代际。
    let recovery = dst.layout().recovery_dir();
    assert!(recovery.exists(), "应保留失败现场供排查");
}

/// `state/` 写不进去 → 不切代际、现有数据不动。
///
/// `state/` 里放着编号高水位、`recovery/state.json` 与 `active.json`，三者走同一条
/// 「先写、再原子切换」的路径。这条用例证明「前面全部通过、最后要落状态时失败」
/// 不会留下半切换状态。把失败精确卡在 `active.json` 那一步、而不影响同目录的前两次写入，
/// 在文件系统层面构造不出来——这一点报告里如实写明，不假装覆盖到了。
#[cfg(unix)]
#[test]
fn state_write_failure_before_the_switch_keeps_the_previous_generation() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let src = open_at(&dir.path().join("src"), migrations::APP_SCHEMA_VERSION);
    let o1 = new_order(&src, "AF-2026-4201", "备份里的订单");
    {
        let conn = src.open_db().unwrap();
        platform(&conn, "p1", "米画师", Some(500), 0, 0);
        record(
            &conn,
            Rec {
                id: "r1",
                order_id: &o1,
                schedule_id: None,
                kind: "full",
                amount: 1000,
                received_on: "2026-11-01",
                platform_id: Some("p1"),
                platform_name: Some("米画师"),
                fee_rate_bp: Some(500),
                fee: 5,
                voided: None,
                request_id: None,
            },
        );
    }
    let zip = dir.path().join("v12.zip");
    backup(&src, &zip);

    let dst_root = dir.path().join("dst");
    let dst = open_at(&dst_root, migrations::APP_SCHEMA_VERSION);
    new_order(&dst, "AF-2026-1020", "现有订单");
    let generation_before = dst.active_generation().to_string();
    // 句柄先打开：锁目录之后连打开都会失败，那就测不到「合并/切换」这一段了。
    let watermarks = hw(&dst);

    let state_dir = dst.layout().state_dir();
    let original = std::fs::metadata(&state_dir).unwrap().permissions();
    let mut locked = original.clone();
    locked.set_mode(0o500);
    std::fs::set_permissions(&state_dir, locked).unwrap();

    let result = restore::restore(&dst, &watermarks, &zip, &migrations::production());

    std::fs::set_permissions(&state_dir, original).unwrap();

    let err = result.expect_err("状态落不下去时必须整次失败");
    assert_eq!(err.code, "NUMBERING", "{} {}", err.code, err.message);
    assert_eq!(
        dst.active_generation(),
        generation_before,
        "失败不得切换活动代际"
    );
    let conn = dst.open_db().unwrap();
    assert_eq!(count(&conn, "orders"), 1, "现有订单仍在");
    assert_eq!(count(&conn, "payment_records"), 0, "备份里的流水没有落进来");
}

// ------------------------------------------------------------------ 工具

fn rewrite_manifest<F: FnOnce(&mut serde_json::Value)>(source: &Path, target: &Path, edit: F) {
    let entries = read_zip(source);
    let mut edit = Some(edit);
    write_zip(target, entries, |name, data| {
        if name == "manifest.json" {
            let mut value: serde_json::Value = serde_json::from_slice(data).unwrap();
            (edit.take().unwrap())(&mut value);
            return serde_json::to_vec(&value).unwrap();
        }
        data.to_vec()
    });
}

/// 改库内 `user_version`（不是改 manifest），用来构造「版本号说谎」的包。
fn rewrite_database<F: FnOnce(&Connection)>(source: &Path, target: &Path, edit: F) {
    let entries = read_zip(source);
    let db = entries
        .iter()
        .find(|(name, _)| name == "database.sqlite")
        .map(|(_, data)| data.clone())
        .expect("包里没有数据库");
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("db.sqlite");
    std::fs::write(&path, &db).unwrap();
    {
        let conn = Connection::open(&path).unwrap();
        edit(&conn);
    }
    let patched = std::fs::read(&path).unwrap();
    let sha = sha_hex(&patched);

    write_zip(target, entries, |name, data| {
        if name == "database.sqlite" {
            return patched.clone();
        }
        if name == "manifest.json" {
            let mut value: serde_json::Value = serde_json::from_slice(data).unwrap();
            for file in value["files"].as_array_mut().unwrap() {
                if file["path"] == "database.sqlite" {
                    file["bytes"] = serde_json::Value::from(patched.len());
                    file["sha256"] = serde_json::Value::String(sha.clone());
                }
            }
            return serde_json::to_vec(&value).unwrap();
        }
        data.to_vec()
    });
}

fn read_zip(path: &Path) -> Vec<(String, Vec<u8>)> {
    use std::io::Read;
    let mut archive = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
    let mut out = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).unwrap();
        let name = entry.name().unwrap().to_string();
        let mut data = Vec::new();
        entry.read_to_end(&mut data).unwrap();
        out.push((name, data));
    }
    out
}

fn write_zip<F: FnMut(&str, &[u8]) -> Vec<u8>>(
    target: &Path,
    entries: Vec<(String, Vec<u8>)>,
    mut map: F,
) {
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    let out = std::fs::File::create(target).unwrap();
    let mut writer = zip::ZipWriter::new(out);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, data) in entries {
        let mapped = map(&name, &data);
        writer.start_file(name, options).unwrap();
        writer.write_all(&mapped).unwrap();
    }
    writer.finish().unwrap();
}

fn sha_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
