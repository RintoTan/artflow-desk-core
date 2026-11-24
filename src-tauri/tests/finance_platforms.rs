//! FIN-02：平台配置的领域规则。
//!
//! 这里盯三件事，而不是「能不能存进去」：
//! - NULL（未配置）和 0（明确免费）在库里、在返回值里始终是两个值；
//! - 名称唯一是**全局**的，归档平台照样占名，并且两种冲突要给不同的话；
//! - 删除平台只删配置行，历史流水的名称/费率/手续费快照一个字段都不能动。

mod common;

use common::Ctx;
use minidesk::domain::finance::{
    self, CreatePlatformInput, UpdatePlatformInput,
};
use rusqlite::params;

fn create(ctx: &Ctx, name: &str, rate: Option<&str>) -> finance::PlatformView {
    let conn = ctx.conn();
    finance::create(
        &conn,
        &CreatePlatformInput {
            name: name.into(),
            fee_rate: rate.map(str::to_string),
        },
    )
    .unwrap()
}

fn update(ctx: &Ctx, id: &str, name: &str, rate: Option<&str>) -> finance::PlatformView {
    let conn = ctx.conn();
    finance::update(
        &conn,
        &UpdatePlatformInput {
            id: id.into(),
            name: name.into(),
            fee_rate: rate.map(str::to_string),
        },
    )
    .unwrap()
}

/// 造一条挂在平台上的收款流水（直接写表：FIN-03 才有录入命令）。
fn attach_payment(ctx: &Ctx, platform_id: &str) -> (String, String) {
    let order = ctx.create_order("有流水的订单");
    let conn = ctx.conn();
    conn.execute(
        "INSERT INTO payment_schedules (id, order_id, kind, amount_cents, created_at)
         VALUES ('s-1', ?1, 'deposit', 30000, '2026-11-01T00:00:00.000Z')",
        [&order],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO payment_records
           (id, order_id, schedule_id, kind, amount_cents, received_on,
            platform_id, platform_name, fee_rate_bp, fee_cents, created_at)
         VALUES ('r-1', ?1, 's-1', 'deposit', 30000, '2026-11-01',
                 ?2, '米画师', 500, 1500, '2026-11-01T00:00:00.000Z')",
        params![order, platform_id],
    )
    .unwrap();
    (order, "r-1".to_string())
}

// ------------------------------------------------------------------ CRUD

#[test]
fn creating_a_platform_stamps_both_times_and_the_next_position() {
    let ctx = Ctx::new();
    let first = create(&ctx, "米画师", Some("5"));
    let second = create(&ctx, "画加", None);

    assert_eq!(first.sort_position, 0, "空表第一个位置是 0");
    assert_eq!(second.sort_position, 1, "之后追加到末尾");
    assert_eq!(first.created_at, first.updated_at, "新建时两个时间戳一致");
    assert!(!first.archived);
    assert_eq!(first.fee_rate_bp, Some(500));
    assert_eq!(second.fee_rate_bp, None, "没填就是未配置，不是 0");
}

#[test]
fn editing_keeps_created_at_and_updates_updated_at() {
    let ctx = Ctx::new();
    let created = create(&ctx, "米画师", Some("5"));
    std::thread::sleep(std::time::Duration::from_millis(3));
    let edited = update(&ctx, &created.id, "米画师（主）", Some("6.5"));

    assert_eq!(edited.created_at, created.created_at, "created_at 不得被改写");
    assert_ne!(edited.updated_at, created.updated_at, "用户修改要留痕");
    assert_eq!(edited.name, "米画师（主）");
    assert_eq!(edited.fee_rate_bp, Some(650));
}

// ------------------------------------------------------------------ 名称

#[test]
fn names_are_trimmed_and_length_checked() {
    let ctx = Ctx::new();
    assert_eq!(create(&ctx, "  米画师  ", None).name, "米画师");
    // 全角空格：Rust 的 trim 会去掉，SQLite 的 trim 不会。
    assert_eq!(create(&ctx, "\u{3000}画加\u{3000}", None).name, "画加");
    assert_eq!(create(&ctx, "甲", None).name, "甲");
    assert_eq!(create(&ctx, &"字".repeat(40), None).name.chars().count(), 40);

    let conn = ctx.conn();
    for bad in ["", "   ", "\u{3000}"] {
        let err = finance::create(
            &conn,
            &CreatePlatformInput {
                name: bad.into(),
                fee_rate: None,
            },
        )
        .unwrap_err();
        assert!(err.message.contains("不能为空"), "{bad:?} → {err:?}");
    }
    let err = finance::create(
        &conn,
        &CreatePlatformInput {
            name: "字".repeat(41),
            fee_rate: None,
        },
    )
    .unwrap_err();
    assert!(err.message.contains("最多 40"), "{err:?}");
}

#[test]
fn duplicate_names_tell_apart_active_and_archived() {
    let ctx = Ctx::new();
    let platform = create(&ctx, "米画师", Some("5"));
    let conn = ctx.conn();

    let err = finance::create(
        &conn,
        &CreatePlatformInput {
            name: "米画师".into(),
            fee_rate: None,
        },
    )
    .unwrap_err();
    assert!(err.message.contains("已有同名平台"), "正常的重名：{err:?}");
    assert!(!err.message.contains("已归档"));

    finance::archive(&conn, &platform.id).unwrap();
    let err = finance::create(
        &conn,
        &CreatePlatformInput {
            name: "米画师".into(),
            fee_rate: None,
        },
    )
    .unwrap_err();
    assert!(
        err.message.contains("已归档"),
        "归档平台的重名要说清楚可以恢复：{err:?}"
    );

    // 大小写不同按 SQLite 默认比较，视为不同名称（不做折叠）。
    create(&ctx, "Mihuashi", None);
    create(&ctx, "mihuashi", None);
}

#[test]
fn editing_a_platform_does_not_collide_with_itself() {
    let ctx = Ctx::new();
    let platform = create(&ctx, "米画师", Some("5"));
    let edited = update(&ctx, &platform.id, "米画师", Some("6"));
    assert_eq!(edited.fee_rate_bp, Some(600));

    // 改成别人的名字仍然要拦。
    create(&ctx, "画加", None);
    let conn = ctx.conn();
    let err = finance::update(
        &conn,
        &UpdatePlatformInput {
            id: platform.id.clone(),
            name: "画加".into(),
            fee_rate: None,
        },
    )
    .unwrap_err();
    assert!(err.message.contains("已有同名平台"));
}

// ------------------------------------------------------------------ 费率

#[test]
fn fee_rates_keep_null_and_zero_apart_end_to_end() {
    let ctx = Ctx::new();
    create(&ctx, "未配置", None);
    create(&ctx, "免费", Some("0"));
    create(&ctx, "百分之一点二五", Some("1.25"));
    create(&ctx, "满额", Some("100"));

    let conn = ctx.conn();
    let rows = finance::list(&conn).unwrap();
    let rate = |name: &str| {
        rows.iter()
            .find(|p| p.name == name)
            .unwrap_or_else(|| panic!("缺少 {name}"))
            .fee_rate_bp
    };
    assert_eq!(rate("未配置"), None);
    assert_eq!(rate("免费"), Some(0));
    assert_eq!(rate("百分之一点二五"), Some(125));
    assert_eq!(rate("满额"), Some(10_000));

    // 库里的 NULL 也必须真的是 NULL。
    let stored: Option<i64> = conn
        .query_row(
            "SELECT fee_rate_bp FROM payment_platforms WHERE name = '未配置'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(stored, None);
}

#[test]
fn illegal_fee_rates_are_refused_by_the_domain_not_the_ui() {
    let ctx = Ctx::new();
    let conn = ctx.conn();
    for bad in ["-1", "100.01", "101", "1.234", "abc", "1e3", "5%"] {
        let err = finance::create(
            &conn,
            &CreatePlatformInput {
                name: "测试".into(),
                fee_rate: Some(bad.into()),
            },
        )
        .unwrap_err();
        assert_eq!(err.code, "INVALID", "{bad:?} 应被拒");
    }
    // 一次都没插进去
    assert!(finance::list(&conn).unwrap().is_empty());
}

// ------------------------------------------------------------- 归档与恢复

#[test]
fn archiving_hides_but_keeps_everything() {
    let ctx = Ctx::new();
    let platform = create(&ctx, "米画师", Some("5"));
    std::thread::sleep(std::time::Duration::from_millis(3));

    let conn = ctx.conn();
    let archived = finance::archive(&conn, &platform.id).unwrap();
    assert!(archived.archived);
    assert_eq!(archived.name, "米画师");
    assert_eq!(archived.fee_rate_bp, Some(500), "归档不动费率");
    assert_eq!(archived.created_at, platform.created_at, "归档不动创建时间");
    assert_ne!(archived.updated_at, platform.updated_at, "归档是用户动作，要留痕");
    assert_eq!(archived.sort_position, platform.sort_position);

    let restored = finance::restore(&conn, &platform.id).unwrap();
    assert!(!restored.archived);
    assert_eq!(restored.name, "米画师");
    assert_eq!(restored.fee_rate_bp, Some(500));
    assert_eq!(restored.created_at, platform.created_at);
}

#[test]
fn archived_platforms_still_occupy_the_name() {
    let ctx = Ctx::new();
    let platform = create(&ctx, "米画师", None);
    let conn = ctx.conn();
    finance::archive(&conn, &platform.id).unwrap();

    // 直接写库也不该绕过唯一索引。
    let err = conn
        .execute(
            "INSERT INTO payment_platforms (id, name, archived, created_at, updated_at)
             VALUES ('p-x', '米画师', 0, 'x', 'x')",
            [],
        )
        .unwrap_err();
    assert!(err.to_string().contains("UNIQUE"));
}

// ------------------------------------------------------------------ 排序

#[test]
fn reordering_persists_the_submitted_order() {
    let ctx = Ctx::new();
    let a = create(&ctx, "甲", None);
    let b = create(&ctx, "乙", None);
    let c = create(&ctx, "丙", None);

    let mut conn = ctx.conn();
    let ordered = finance::reorder(&mut conn, &[c.id.clone(), a.id.clone(), b.id.clone()]).unwrap();
    assert_eq!(
        ordered.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
        vec!["丙", "甲", "乙"]
    );
    // 再读一次，确认是落库而不是只改了返回值。
    let again = finance::list(&conn).unwrap();
    assert_eq!(
        again.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
        vec!["丙", "甲", "乙"]
    );
}

#[test]
fn reordering_rejects_partial_stale_or_duplicated_sets() {
    let ctx = Ctx::new();
    let a = create(&ctx, "甲", None);
    let b = create(&ctx, "乙", None);
    let archived = create(&ctx, "丙", None);
    let mut conn = ctx.conn();
    finance::archive(&conn, &archived.id).unwrap();

    let before = finance::list(&conn).unwrap();

    // 少给一个 → 拒绝
    let err = finance::reorder(&mut conn, &[a.id.clone()]).unwrap_err();
    assert_eq!(err.code, "CONFLICT");
    // 重复 → 拒绝
    let err = finance::reorder(&mut conn, &[a.id.clone(), a.id.clone(), b.id.clone()]).unwrap_err();
    assert_eq!(err.code, "INVALID");
    // 带归档项 → 集合不匹配 → 拒绝
    let err = finance::reorder(
        &mut conn,
        &[a.id.clone(), b.id.clone(), archived.id.clone()],
    )
    .unwrap_err();
    assert_eq!(err.code, "CONFLICT");
    // 不存在的 ID → 拒绝
    let err = finance::reorder(
        &mut conn,
        &[a.id.clone(), b.id.clone(), "no-such-platform".into()],
    )
    .unwrap_err();
    assert_eq!(err.code, "CONFLICT");

    // 四次拒绝之后，位置一个都没动。
    assert_eq!(finance::list(&conn).unwrap(), before);
}

#[test]
fn reordering_touches_only_the_active_group_and_leaves_archived_positions() {
    let ctx = Ctx::new();
    let a = create(&ctx, "甲", None);
    let b = create(&ctx, "乙", None);
    let archived = create(&ctx, "丙", None);
    let mut conn = ctx.conn();
    let archived_before = finance::archive(&conn, &archived.id).unwrap();

    finance::reorder(&mut conn, &[b.id.clone(), a.id.clone()]).unwrap();

    let after = finance::list(&conn)
        .unwrap()
        .into_iter()
        .find(|p| p.id == archived.id)
        .unwrap();
    assert_eq!(after.sort_position, archived_before.sort_position, "归档项位置不动");
    assert_eq!(after.updated_at, archived_before.updated_at, "归档项时间戳不动");
}

// -------------------------------------------------------------- 永久删除

#[test]
fn deleting_a_platform_without_payments_is_plain() {
    let ctx = Ctx::new();
    let platform = create(&ctx, "米画师", None);
    let conn = ctx.conn();
    let report = finance::delete(&conn, &platform.id).unwrap();
    assert_eq!(report.name, "米画师");
    assert_eq!(report.detached_payments, 0);
    assert!(finance::list(&conn).unwrap().is_empty());
}

#[test]
fn deleting_a_platform_in_use_keeps_the_payment_and_its_snapshots() {
    let ctx = Ctx::new();
    let platform = create(&ctx, "米画师", Some("5"));
    let (_order, record_id) = attach_payment(&ctx, &platform.id);

    let conn = ctx.conn();
    let report = finance::delete(&conn, &platform.id).unwrap();
    assert_eq!(report.detached_payments, 1, "要告诉用户有多少笔流水被解绑");

    let (platform_id, name, rate, fee): (Option<String>, Option<String>, Option<i64>, i64) = conn
        .query_row(
            "SELECT platform_id, platform_name, fee_rate_bp, fee_cents
             FROM payment_records WHERE id = ?1",
            [&record_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!(platform_id, None, "外键按 SET NULL 断开");
    assert_eq!(name.as_deref(), Some("米画师"), "名称快照必须留下");
    assert_eq!(rate, Some(500), "费率快照必须留下");
    assert_eq!(fee, 1500, "实际手续费必须留下");

    // 名称可以重新使用。
    let reused = create(&ctx, "米画师", None);
    assert_eq!(reused.name, "米画师");
    assert_ne!(reused.id, platform.id);
}
