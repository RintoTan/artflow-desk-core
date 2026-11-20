//! Step 4 回归：按 id 的业务入口对回收站数据一律拒绝，但历史仍可读。
//!
//! 对照结构：同一个订单，同一条操作序列，在「进回收站前」全部成功，
//! 进回收站后全部 `CONFLICT`。这样「守卫是否接上」不依赖读代码确认。

mod common;

use std::path::{Path, PathBuf};

use common::Ctx;
use image::{DynamicImage, ImageFormat, RgbImage};
use minidesk::domain::attachments;
use minidesk::domain::clients::{self, CreateClientInput, UpdateClientInput};
use minidesk::domain::lifecycle;
use minidesk::domain::orders::{self, UpdateDetailsInput};
use minidesk::domain::queue;
use minidesk::error::AppError;

fn write_image(dir: &Path, name: &str) -> PathBuf {
    let path = dir.join(name);
    let img = DynamicImage::ImageRgb8(RgbImage::from_fn(8, 8, |x, y| {
        image::Rgb([(x * 20) as u8, (y * 20) as u8, 90])
    }));
    img.save_with_format(&path, ImageFormat::Png).expect("写图失败");
    path
}

fn trash_order(conn: &rusqlite::Connection, id: &str) {
    conn.execute(
        "UPDATE orders SET deleted_at = '2026-11-20T12:00:00+08:00', deleted_batch = 'b-1'
         WHERE id = ?1",
        [id],
    )
    .unwrap();
}

fn trash_client(conn: &rusqlite::Connection, id: &str) {
    conn.execute(
        "UPDATE clients SET deleted_at = '2026-11-20T12:00:00+08:00', deleted_batch = 'b-1'
         WHERE id = ?1",
        [id],
    )
    .unwrap();
}

fn assert_conflict(err: AppError, what: &str) {
    assert_eq!(err.code, "CONFLICT", "{what} 应被拒绝为 CONFLICT，实际 {}：{}", err.code, err.message);
    assert!(
        err.message.contains("回收站"),
        "{what} 的提示要说明在回收站：{}",
        err.message
    );
}

fn edit_input(order_id: &str, revision: i64) -> UpdateDetailsInput {
    UpdateDetailsInput {
        order_id: order_id.to_string(),
        expected_revision: revision,
        title: "改过的标题".into(),
        client_id: None,
        commission_type: None,
        source: None,
        amount_cents: None,
        planned_start_date: None,
        planned_delivery_date: None,
        note: None,
        change_source: None,
        reason: None,
    }
}

#[test]
fn live_order_accepts_edit_stage_and_attachment() {
    let ctx = Ctx::new();
    let id = ctx.create_order("守卫-正常");
    let mut conn = ctx.conn();

    // 编辑订单
    let view = orders::load(&conn, &id).unwrap();
    let view = orders::update_details(&mut conn, edit_input(&id, view.revision)).unwrap();
    assert_eq!(view.title, "改过的标题");

    // 开始制作 + 推进阶段
    let view = lifecycle::start_work(&mut conn, common::lifecycle_input(&view)).unwrap();
    let view = lifecycle::advance_stage(&mut conn, common::lifecycle_input(&view)).unwrap();
    assert!(view.revision > 0);

    // 导入附件
    let dir = tempfile::tempdir().unwrap();
    let img = write_image(dir.path(), "shot.png");
    let outcomes = attachments::import(
        &mut conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        &id,
        &[img],
        None,
    )
    .unwrap();
    assert_eq!(outcomes.len(), 1);
    assert!(outcomes[0].ok, "正常订单应能导入附件：{:?}", outcomes[0].error);

    // 队列操作
    let snap = queue::snapshot(&conn).unwrap();
    queue::move_order(
        &mut conn,
        queue::MoveInput {
            order_id: id.clone(),
            expected_queue_revision: snap.revision,
            to_index: 0,
        },
    )
    .unwrap();
}

#[test]
fn trashed_order_rejects_all_business_operations() {
    let ctx = Ctx::new();
    let id = ctx.create_order("守卫-已删");
    let mut conn = ctx.conn();
    let view = orders::load(&conn, &id).unwrap();
    let view = lifecycle::start_work(&mut conn, common::lifecycle_input(&view)).unwrap();

    trash_order(&conn, &id);

    // 修改订单
    let err = orders::update_details(&mut conn, edit_input(&id, view.revision)).unwrap_err();
    assert_conflict(err, "修改已删除订单");

    // 推进阶段（用进回收站前的 revision，确认拒绝来自守卫而非版本不符）
    let err = lifecycle::advance_stage(&mut conn, common::lifecycle_input(&view)).unwrap_err();
    assert_conflict(err, "推进已删除订单的阶段");

    // 返工
    let err = lifecycle::rework_stage(
        &mut conn,
        lifecycle::ReworkInput {
            order_id: id.clone(),
            expected_revision: view.revision,
            target_stage_id: None,
            request_id: None,
        },
    )
    .unwrap_err();
    assert_conflict(err, "返工已删除订单");

    // 完成 / 取消
    let err = lifecycle::complete_order(&mut conn, common::lifecycle_input(&view)).unwrap_err();
    assert_conflict(err, "完成已删除订单");
    let err = lifecycle::cancel_order(&mut conn, common::lifecycle_input(&view)).unwrap_err();
    assert_conflict(err, "取消已删除订单");

    // 附件导入
    let dir = tempfile::tempdir().unwrap();
    let img = write_image(dir.path(), "shot.png");
    let err = attachments::import(
        &mut conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        &id,
        &[img],
        None,
    )
    .unwrap_err();
    assert_conflict(err, "给已删除订单导附件");

    // 队列操作（含 shift 走 move_order 的路径）
    let snap = queue::snapshot(&conn).unwrap();
    let err = queue::move_order(
        &mut conn,
        queue::MoveInput {
            order_id: id.clone(),
            expected_queue_revision: snap.revision,
            to_index: 0,
        },
    )
    .unwrap_err();
    assert_conflict(err, "移动已删除订单的队列位置");

    // 读取详情不再当作正常业务订单返回
    let err = orders::load(&conn, &id).unwrap_err();
    assert_eq!(err.code, "NOT_FOUND", "详情读的是视图，取不到行");
}

#[test]
fn trashed_order_keeps_history_readable() {
    let ctx = Ctx::new();
    let id = ctx.create_order("守卫-历史");
    let mut conn = ctx.conn();
    let view = orders::load(&conn, &id).unwrap();
    let view = lifecycle::start_work(&mut conn, common::lifecycle_input(&view)).unwrap();
    let _ = lifecycle::advance_stage(&mut conn, common::lifecycle_input(&view)).unwrap();

    let before = minidesk::domain::events::list(&conn, &id).unwrap();
    assert!(before.len() >= 2, "应有建单 + 开始 + 推进事件");

    trash_order(&conn, &id);

    let after = minidesk::domain::events::list(&conn, &id).unwrap();
    assert_eq!(after.len(), before.len(), "回收站订单的历史事件必须仍然可读");
    assert!(
        after.iter().any(|e| e.kind == "stage_advanced"),
        "推进历史也要保留：{:?}",
        after.iter().map(|e| e.kind.clone()).collect::<Vec<_>>()
    );

    let stages = orders::stages(&conn, &id).unwrap();
    assert!(!stages.is_empty(), "回收站订单的阶段表仍要能读出来");
}

#[test]
fn client_edit_blocked_after_trash() {
    let ctx = Ctx::new();
    let conn = ctx.conn();
    let c = clients::create(
        &conn,
        CreateClientInput {
            display_name: "客户甲".into(),
            contact: None,
            note: None,
        },
    )
    .unwrap();

    let mut conn = ctx.conn();
    let updated = clients::update(
        &mut conn,
        UpdateClientInput {
            client_id: c.id.clone(),
            expected_revision: c.revision,
            display_name: "客户甲改".into(),
            contact: None,
            note: None,
        },
    )
    .unwrap();
    assert_eq!(updated.display_name, "客户甲改");

    trash_client(&conn, &c.id);

    let err = clients::update(
        &mut conn,
        UpdateClientInput {
            client_id: c.id.clone(),
            expected_revision: updated.revision,
            display_name: "客户甲再改".into(),
            contact: None,
            note: None,
        },
    )
    .unwrap_err();
    assert_conflict(err, "编辑已删除客户");

    let err = clients::link_tag(&conn, &c.id, "any-tag").unwrap_err();
    assert_conflict(err, "给已删除客户打标签");
}

#[test]
fn trashed_client_cannot_be_relinked() {
    let ctx = Ctx::new();
    let conn = ctx.conn();
    let c = clients::create(
        &conn,
        CreateClientInput {
            display_name: "客户乙".into(),
            contact: None,
            note: None,
        },
    )
    .unwrap();
    trash_client(&conn, &c.id);

    // 新订单不能再挂到回收站客户上
    let mut conn = ctx.conn();
    let err = orders::create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        orders::CreateOrderInput {
            title: "新单".into(),
            client: orders::ClientChoice::Existing {
                client_id: c.id.clone(),
            },
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_conflict(err, "新订单关联已删除客户");

    // 已有订单也不能改成挂到回收站客户
    let order_id = ctx.create_order("已有订单");
    let view = orders::load(&conn, &order_id).unwrap();
    let mut input = edit_input(&order_id, view.revision);
    input.client_id = Some(c.id.clone());
    let err = orders::update_details(&mut conn, input).unwrap_err();
    assert_conflict(err, "把已有订单改挂已删除客户");
}

#[test]
fn missing_id_still_not_found() {
    let ctx = Ctx::new();
    let mut conn = ctx.conn();

    let err = orders::update_details(&mut conn, edit_input("no-such-order", 0)).unwrap_err();
    assert_eq!(err.code, "NOT_FOUND", "不存在与回收站必须区分");

    let err = clients::update(
        &mut conn,
        UpdateClientInput {
            client_id: "no-such-client".into(),
            expected_revision: 0,
            display_name: "谁".into(),
            contact: None,
            note: None,
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "NOT_FOUND");

    let err = lifecycle::start_work(
        &mut conn,
        lifecycle::LifecycleInput {
            order_id: "no-such-order".into(),
            expected_revision: 0,
            request_id: None,
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "NOT_FOUND");
}
