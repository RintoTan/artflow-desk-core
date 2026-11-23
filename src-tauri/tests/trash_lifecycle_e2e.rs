//! Step 6 收尾回归：一条订单从建立、动手、删除、备份到恢复的完整链路。
//!
//! 前面各步的测试是按面切的（查询、守卫、导出、备份）。这一条按**时间线**切：
//! 同一个订单对象走完全部阶段，确认每一层的结论互相不矛盾。
//! 任何一处口径不一致（比如列表说没有、统计却算进去了）都会在这里断掉。

mod common;

use std::fs;
use std::path::Path;

use image::{DynamicImage, ImageFormat, RgbImage};
use minidesk::backup::{create, restore};
use minidesk::domain::attachments;
use minidesk::domain::clients::{self, CreateClientInput};
use minidesk::domain::dashboard;
use minidesk::domain::export;
use minidesk::domain::lifecycle;
use minidesk::domain::orders::{self, ClientChoice, CreateOrderInput, UpdateDetailsInput};
use minidesk::domain::queue;
use minidesk::domain::stats;
use minidesk::store::highwater::HighWater;
use minidesk::store::migrations;

fn write_png(dir: &Path, name: &str) -> std::path::PathBuf {
    let path = dir.join(name);
    let img = DynamicImage::ImageRgb8(RgbImage::from_fn(6, 6, |x, y| {
        image::Rgb([(x * 30) as u8, (y * 30) as u8, 200])
    }));
    img.save_with_format(&path, ImageFormat::Png).unwrap();
    path
}

fn edit(order_id: &str, revision: i64, title: &str) -> UpdateDetailsInput {
    UpdateDetailsInput {
        order_id: order_id.to_string(),
        expected_revision: revision,
        title: title.to_string(),
        client_id: None,
        commission_type: None,
        source: None,
        // 改单是整条覆盖，金额留空会被清掉——这里显式保留。
        amount_cents: Some(120_000),
        planned_start_date: None,
        planned_delivery_date: None,
        note: None,
        change_source: None,
        reason: None,
    }
}

#[test]
fn one_order_walks_the_whole_trash_lifecycle() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);
    let mut conn = env.open_db().unwrap();
    let hw = HighWater::open(&env.layout().highwater_db()).unwrap();

    // ---------------- 1. 正常业务：能建、能改、能推、能导入 ----------------
    let client = clients::create(
        &conn,
        CreateClientInput {
            display_name: "端到端客户".into(),
            contact: Some("wechat-xyz".into()),
            note: None,
        },
    )
    .unwrap();

    let view = orders::create_order(
        &mut conn,
        &hw,
        common::tz(),
        CreateOrderInput {
            title: "端到端订单".into(),
            client: ClientChoice::Existing {
                client_id: client.id.clone(),
            },
            amount_cents: Some(120_000),
            planned_delivery_date: Some("2026-12-31".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let order_id = view.id.clone();

    let view = orders::update_details(&mut conn, edit(&order_id, view.revision, "改过的标题")).unwrap();
    let view = lifecycle::start_work(&mut conn, common::lifecycle_input(&view)).unwrap();
    // 推进后不再需要 view：后续断言按 id 走。
    lifecycle::advance_stage(&mut conn, common::lifecycle_input(&view)).unwrap();

    let img = write_png(dir.path(), "e2e.png");
    let imported = attachments::import(
        &mut conn,
        env.layout(),
        env.active_generation(),
        &order_id,
        &[img],
        None,
    )
    .unwrap();
    assert!(imported[0].ok, "正常订单应能导入附件");

    assert_eq!(orders::list(&conn).unwrap().len(), 1);
    assert_eq!(clients::list(&conn).unwrap().len(), 1);
    assert_eq!(dashboard::metrics(&conn).unwrap().active_total, 1);
    assert_eq!(queue::list(&conn).unwrap().len(), 1);
    assert_eq!(
        stats::report(&conn, stats::StatsRange::ThisMonth)
            .unwrap()
            .totals
            .amount_cents,
        120_000
    );

    // ---------------- 2. 进回收站：业务面全部消失 ----------------
    let events_before = minidesk::domain::events::list(&conn, &order_id).unwrap().len();
    assert!(events_before >= 3);
    let attach_id: String = conn
        .query_row("SELECT id FROM attachments WHERE order_id = ?1", [&order_id], |r| {
            r.get(0)
        })
        .unwrap();

    conn.execute(
        "UPDATE orders SET deleted_at = '2026-11-20T12:00:00+08:00', deleted_batch = 'e2e-batch'
         WHERE id = ?1",
        [&order_id],
    )
    .unwrap();
    conn.execute(
        "UPDATE clients SET deleted_at = '2026-11-20T12:00:00+08:00', deleted_batch = 'e2e-batch'
         WHERE id = ?1",
        [&client.id],
    )
    .unwrap();

    assert!(orders::list(&conn).unwrap().is_empty(), "列表不得含回收站订单");
    assert!(clients::list(&conn).unwrap().is_empty(), "客户列表同上");
    assert!(queue::list(&conn).unwrap().is_empty(), "队列同上");
    assert_eq!(dashboard::metrics(&conn).unwrap().active_total, 0);
    assert_eq!(
        stats::report(&conn, stats::StatsRange::ThisMonth)
            .unwrap()
            .totals
            .amount_cents,
        0,
        "收入统计不得计入已删除订单"
    );
    assert!(export::collect_orders(&conn, &[], false).unwrap().is_empty());

    // ---------------- 3. 写入全部拒绝，历史全部保留 ----------------
    let err = orders::update_details(&mut conn, edit(&order_id, 99, "还想改")).unwrap_err();
    assert_eq!(err.code, "CONFLICT");
    let err = lifecycle::advance_stage(
        &mut conn,
        lifecycle::LifecycleInput {
            order_id: order_id.clone(),
            expected_revision: 99,
            request_id: None,
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "CONFLICT", "守卫要早于版本校验");
    let err = clients::update(
        &mut conn,
        clients::UpdateClientInput {
            client_id: client.id.clone(),
            expected_revision: 99,
            display_name: "还想改".into(),
            contact: None,
            note: None,
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "CONFLICT");

    let events_after = minidesk::domain::events::list(&conn, &order_id).unwrap();
    assert_eq!(events_after.len(), events_before, "历史事件条数不得变化");
    assert!(events_after.iter().any(|e| e.kind == "stage_advanced"));
    assert!(!orders::stages(&conn, &order_id).unwrap().is_empty());

    // ---------------- 4. 导出与备份：一个不含，一个必须含 ----------------
    let full = export::collect_orders(&conn, &[], true).unwrap();
    assert_eq!(full.len(), 1);
    assert!(full[0].deleted);

    let summary = minidesk::backup::manifest::summarize(&conn).unwrap();
    assert_eq!((summary.orders, summary.trashed_orders), (1, 1));
    assert_eq!((summary.clients, summary.trashed_clients), (1, 1));
    assert_eq!(summary.attachments, 1);

    let zip = dir.path().join("e2e.zip");
    let created = create::create(&env, &hw, &zip).unwrap();
    assert_eq!(created.summary.trashed_orders, 1);
    let preview = restore::preview(&env, &zip).unwrap();
    assert!(preview.can_restore);
    assert_eq!(preview.summary.trashed_clients, 1);

    // ---------------- 5. 恢复后仍是 v8，且口径仍然一致 ----------------
    restore::restore(&env, &hw, &zip, &migrations::production()).unwrap();
    drop(conn);
    drop(env);

    let env = common::open(&root);
    let conn = env.open_db().unwrap();

    assert_eq!(
        migrations::schema_version(&conn).unwrap(),
        migrations::APP_SCHEMA_VERSION,
        "恢复后仍应停在最新 schema"
    );
    assert!(migrations::APP_SCHEMA_VERSION >= 8, "03D 之后 schema 只增不减");

    // 基表里有，业务面看不见。
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
        .unwrap();
    assert_eq!(total, 1);
    assert!(orders::list(&conn).unwrap().is_empty(), "恢复后仍不得回到列表");

    let deleted: (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT deleted_at, deleted_batch FROM orders WHERE id = ?1",
            [&order_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(deleted.0.is_some());
    assert_eq!(deleted.1.as_deref(), Some("e2e-batch"));

    // 历史与附件关系完整。
    let events_restored = minidesk::domain::events::list(&conn, &order_id).unwrap();
    assert_eq!(events_restored.len(), events_before);

    let rel: String = conn
        .query_row(
            "SELECT rel_path FROM attachments WHERE id = ?1",
            [&attach_id],
            |r| r.get(0),
        )
        .unwrap();
    let generation = env.active_generation().to_string();
    let original = env
        .layout()
        .attachments_dir(&generation)
        .join(rel.trim_start_matches("attachments/"));
    assert!(
        fs::metadata(&original).map(|m| m.len() > 0).unwrap_or(false),
        "原图应随包恢复到新代际：{}",
        original.display()
    );
}
