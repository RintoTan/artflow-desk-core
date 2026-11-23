//! ORDER-01：订单复制。
//!
//! 复制的是「资料」不是「历史」：流程取来源订单保存的阶段快照，
//! 阶段与事件计数重置，附件做真正的文件副本（新 ID / 新路径 / 字节不变）。

mod common;

use std::path::{Path, PathBuf};

use common::Ctx;
use image::{DynamicImage, ImageFormat, RgbImage};
use minidesk::domain::attachments;
use minidesk::domain::lifecycle::{self, WorkState};
use minidesk::domain::orders::{
    self, create_order, ClientChoice, CreateOrderInput, DuplicateOrderInput, OrderView,
};
use minidesk::domain::templates::{self, StepInput, UpdateTemplateInput};
use minidesk::domain::trash;

fn input(title: &str) -> CreateOrderInput {
    CreateOrderInput {
        title: title.into(),
        ..Default::default()
    }
}

fn dup_input(view: &OrderView, copy: bool) -> DuplicateOrderInput {
    DuplicateOrderInput {
        source_order_id: view.id.clone(),
        title: view.title.clone(),
        client_id: view.client_id.clone(),
        commission_type: view.commission_type.clone(),
        source: view.source.clone(),
        amount_cents: view.amount_cents,
        note: view.note.clone(),
        copy_attachments: copy,
        request_id: None,
    }
}

fn duplicate(ctx: &Ctx, input: DuplicateOrderInput) -> minidesk::error::AppResult<OrderView> {
    let mut conn = ctx.conn();
    orders::duplicate_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        ctx.env.layout(),
        ctx.env.active_generation(),
        input,
    )
}

fn write_image(dir: &Path, name: &str, width: u32, height: u32) -> PathBuf {
    let path = dir.join(name);
    let img = DynamicImage::ImageRgb8(RgbImage::from_fn(width, height, |x, y| {
        image::Rgb([(x % 256) as u8, (y % 256) as u8, 90])
    }));
    img.save_with_format(&path, ImageFormat::Png)
        .expect("写入测试图片失败");
    path
}

fn import_one(ctx: &Ctx, order_id: &str, path: &Path) -> attachments::AttachmentView {
    let mut conn = ctx.conn();
    let outcomes = attachments::import(
        &mut conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        order_id,
        &[path.to_path_buf()],
        Some("reference"),
    )
    .unwrap();
    assert!(outcomes[0].ok, "导入失败：{:?}", outcomes[0].error);
    outcomes[0].attachment.clone().unwrap()
}

fn start(ctx: &Ctx, id: &str) -> OrderView {
    let view = ctx.load(id);
    let mut conn = ctx.conn();
    lifecycle::start_work(&mut conn, common::lifecycle_input(&view)).unwrap()
}

fn advance(ctx: &Ctx, id: &str) -> OrderView {
    let view = ctx.load(id);
    let mut conn = ctx.conn();
    lifecycle::advance_stage(&mut conn, common::lifecycle_input(&view)).unwrap()
}

/// 推到最后一个阶段（仍处于制作中）。
fn advance_to_end(ctx: &Ctx, id: &str) -> OrderView {
    start(ctx, id);
    loop {
        let view = ctx.load(id);
        if view.capabilities.can_complete {
            return view;
        }
        advance(ctx, id);
    }
}

fn complete(ctx: &Ctx, id: &str) -> OrderView {
    let view = advance_to_end(ctx, id);
    let mut conn = ctx.conn();
    lifecycle::complete_order(&mut conn, common::lifecycle_input(&view)).unwrap()
}

#[test]
fn t01_active_order_copies_details_and_resets_progress() {
    let ctx = Ctx::new();
    let mut conn = ctx.conn();
    let source = create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        CreateOrderInput {
            title: "半身立绘".into(),
            client: ClientChoice::New {
                display_name: "林小满".into(),
                contact: Some("wx: lin".into()),
                note: None,
            },
            commission_type: Some("半身立绘".into()),
            source: Some("画加".into()),
            amount_cents: Some(120_000),
            planned_start_date: Some("2026-11-10".into()),
            planned_delivery_date: Some("2026-11-20".into()),
            note: Some("背景要夜空".into()),
            ..Default::default()
        },
    )
    .unwrap();

    // 来源已开工并推进到第三阶段，用来证明副本不继承进度。
    start(&ctx, &source.id);
    advance(&ctx, &source.id);
    advance(&ctx, &source.id);
    let source = ctx.load(&source.id);
    assert_eq!(source.current_stage_title.as_deref(), Some("固有色"));

    let copy = duplicate(&ctx, dup_input(&source, false)).unwrap();

    assert_ne!(copy.id, source.id);
    assert_ne!(copy.code, source.code);
    assert_eq!(copy.title, source.title);
    assert_eq!(copy.client_id, source.client_id);
    assert_eq!(copy.client_name.as_deref(), Some("林小满"));
    assert_eq!(copy.commission_type, source.commission_type);
    assert_eq!(copy.source, source.source);
    assert_eq!(copy.amount_cents, source.amount_cents);
    assert_eq!(copy.note, source.note);
    assert_eq!(copy.stage_template_id, source.stage_template_id);

    // 进度重置：第一阶段、未开工、无计划日期。
    assert_eq!(copy.status, "active");
    assert_eq!(copy.work_state, WorkState::Queued);
    assert_eq!(copy.current_stage_title.as_deref(), Some("草稿"));
    assert_eq!(copy.current_stage_index, Some(0));
    assert_eq!(copy.stage_count, source.stage_count);
    assert!(copy.started_at.is_none());
    assert!(copy.completed_at.is_none());
    assert!(copy.cancelled_at.is_none());
    assert!(copy.planned_start_date.is_none());
    assert!(copy.planned_delivery_date.is_none());
    assert_eq!(copy.revision, 0);

    // 历史不继承：副本只有自己的 created 事件。
    assert_eq!(ctx.kinds(&copy.id), vec!["created"]);
    assert!(ctx.kinds(&source.id).len() > 3);
}

#[test]
fn t02_completed_order_can_be_copied() {
    let ctx = Ctx::new();
    let id = ctx.create_order("已完成委托");
    let source = complete(&ctx, &id);
    assert_eq!(source.status, "complete");

    let copy = duplicate(&ctx, dup_input(&source, false)).unwrap();
    assert_eq!(copy.status, "active");
    assert_eq!(copy.work_state, WorkState::Queued);
    assert!(copy.completed_at.is_none());
    assert_eq!(ctx.kinds(&copy.id), vec!["created"]);
}

#[test]
fn t03_cancelled_order_can_be_copied() {
    let ctx = Ctx::new();
    let id = ctx.create_order("已取消委托");
    let view = ctx.load(&id);
    let mut conn = ctx.conn();
    let source = lifecycle::cancel_order(&mut conn, common::lifecycle_input(&view)).unwrap();
    assert_eq!(source.status, "cancelled");

    let copy = duplicate(&ctx, dup_input(&source, false)).unwrap();
    assert_eq!(copy.status, "active");
    assert!(copy.cancelled_at.is_none());
}

#[test]
fn t04_archived_order_can_be_copied() {
    let ctx = Ctx::new();
    let id = ctx.create_order("已归档委托");
    let source = complete(&ctx, &id);

    let mut conn = ctx.conn();
    let archived = orders::set_archived(&mut conn, &source.id, true).unwrap();
    assert!(archived.archived_at.is_some());

    let copy = duplicate(&ctx, dup_input(&archived, false)).unwrap();
    assert_eq!(copy.status, "active");
    // 归档是来源的收纳状态，不随复制带走。
    assert!(copy.archived_at.is_none());
}

#[test]
fn t05_trashed_order_is_refused_without_creating_anything() {
    let ctx = Ctx::new();
    let id = ctx.create_order("已删除委托");
    let before = ctx.load(&id);
    let mut conn = ctx.conn();
    trash::delete_order(&mut conn, &id).unwrap();

    let total_before: i64 = ctx
        .conn()
        .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
        .unwrap();

    let err = duplicate(&ctx, dup_input(&before, false)).unwrap_err();
    assert_eq!(err.code, "CONFLICT");
    assert!(err.message.contains("恢复"), "{}", err.message);

    let total_after: i64 = ctx
        .conn()
        .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
        .unwrap();
    assert_eq!(total_before, total_after);
}

#[test]
fn t06_stage_snapshot_comes_from_the_order_not_the_template() {
    let ctx = Ctx::new();
    let id = ctx.create_order("快照来源");
    let source = ctx.load(&id);
    assert_eq!(source.stage_count, 5);

    // 建单之后修改模板：新增一个阶段并改名。
    let mut conn = ctx.conn();
    let template = templates::list(&conn)
        .unwrap()
        .into_iter()
        .find(|t| t.id == source.stage_template_id)
        .unwrap();
    let mut steps: Vec<StepInput> = template
        .steps
        .iter()
        .map(|s| StepInput {
            step_id: Some(s.step_id.clone()),
            title: s.title.clone(),
        })
        .collect();
    steps.push(StepInput {
        step_id: None,
        title: "后期".into(),
    });
    templates::update(
        &mut conn,
        UpdateTemplateInput {
            template_id: template.id.clone(),
            expected_revision: template.revision,
            name: template.name.clone(),
            steps,
        },
    )
    .unwrap();

    let copy = duplicate(&ctx, dup_input(&source, false)).unwrap();
    // 副本沿用来源订单当时的 5 个阶段，不受模板新增影响。
    assert_eq!(copy.stage_count, 5);
    let copy_titles: Vec<&str> = copy.stages.iter().map(|s| s.title.as_str()).collect();
    let source_titles: Vec<&str> = source.stages.iter().map(|s| s.title.as_str()).collect();
    assert_eq!(copy_titles, source_titles);

    // 再建一张新订单则拿到改后的 6 个阶段，证明模板确实变了。
    let mut conn = ctx.conn();
    let fresh = create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        CreateOrderInput {
            title: "模板已改".into(),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(fresh.stage_count, 6);
}

#[test]
fn t07_code_is_fresh_and_high_water_moves_forward() {
    let ctx = Ctx::new();
    let first = ctx.create_order("第一张");
    let source = ctx.load(&first);

    let copy = duplicate(&ctx, dup_input(&source, false)).unwrap();
    assert_eq!(copy.code, "AF-2026-0002");
    assert_ne!(copy.code, source.code);

    let third = ctx.create_order("第三张");
    let third = ctx.load(&third);
    assert_eq!(third.code, "AF-2026-0003");
    // 编号不复用：删掉中间那张再建也不回退。
    let mut conn = ctx.conn();
    trash::delete_order(&mut conn, &copy.id).unwrap();
    let fourth = ctx.create_order("第四张");
    assert_eq!(ctx.load(&fourth).code, "AF-2026-0004");
}

#[test]
fn t08_copy_lands_at_the_tail_of_the_active_queue() {
    let ctx = Ctx::new();
    let a = ctx.create_order("甲");
    let b = ctx.create_order("乙");
    let source = ctx.load(&a);

    let copy = duplicate(&ctx, dup_input(&source, false)).unwrap();
    assert_eq!(copy.queue_position, 2);

    let list = orders::list(&ctx.conn()).unwrap();
    let order: Vec<String> = list.iter().map(|o| o.id.clone()).collect();
    assert_eq!(order.last(), Some(&copy.id));
    let positions: Vec<i64> = list
        .iter()
        .filter(|o| o.status == "active")
        .map(|o| o.queue_position)
        .collect();
    assert_eq!(positions, vec![0, 1, 2]);
    assert!(list.iter().any(|o| o.id == b));
}

#[test]
fn t09_attachments_are_real_copies() {
    let ctx = Ctx::new();
    let id = ctx.create_order("带附件");
    let dir = tempfile::tempdir().unwrap();
    let image = write_image(dir.path(), "参考.png", 40, 30);
    let source_attachment = import_one(&ctx, &id, &image);
    let source = ctx.load(&id);

    let copy = duplicate(&ctx, dup_input(&source, true)).unwrap();

    let conn = ctx.conn();
    let copied = attachments::list(
        &conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        &copy.id,
    )
    .unwrap();
    assert_eq!(copied.len(), 1);
    let one = &copied[0];

    assert_ne!(one.id, source_attachment.id);
    assert_eq!(one.sha256, source_attachment.sha256);
    assert_eq!(one.byte_size, source_attachment.byte_size);
    assert_eq!(one.original_name, source_attachment.original_name);
    assert_eq!(one.tag, source_attachment.tag);
    assert_eq!(one.role, source_attachment.role);
    // 独立路径：不共享可删除的同一份文件。
    assert_ne!(one.original_path, source_attachment.original_path);
    assert!(std::path::Path::new(&one.original_path).exists());
    assert!(std::path::Path::new(&source_attachment.original_path).exists());

    // 原图字节逐字节一致。
    let a = std::fs::read(&source_attachment.original_path).unwrap();
    let b = std::fs::read(&one.original_path).unwrap();
    assert_eq!(a, b);
}

#[test]
fn t10_unchecked_copy_leaves_no_attachments() {
    let ctx = Ctx::new();
    let id = ctx.create_order("带附件但不复制");
    let dir = tempfile::tempdir().unwrap();
    let image = write_image(dir.path(), "参考.png", 20, 20);
    import_one(&ctx, &id, &image);
    let source = ctx.load(&id);

    let copy = duplicate(&ctx, dup_input(&source, false)).unwrap();
    let conn = ctx.conn();
    let copied = attachments::list(
        &conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        &copy.id,
    )
    .unwrap();
    assert!(copied.is_empty());
    // 来源附件仍在。
    let kept = attachments::list(
        &conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        &source.id,
    )
    .unwrap();
    assert_eq!(kept.len(), 1);
}

#[test]
fn t11_removing_the_copy_does_not_touch_the_source() {
    let ctx = Ctx::new();
    let id = ctx.create_order("删除副本");
    let dir = tempfile::tempdir().unwrap();
    let image = write_image(dir.path(), "参考.png", 24, 24);
    let source_attachment = import_one(&ctx, &id, &image);
    let source = ctx.load(&id);

    let copy = duplicate(&ctx, dup_input(&source, true)).unwrap();
    let mut conn = ctx.conn();
    let copied = attachments::list(
        &conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        &copy.id,
    )
    .unwrap();
    attachments::remove(
        &mut conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        &copied[0].id,
    )
    .unwrap();

    let kept = attachments::list(
        &conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        &source.id,
    )
    .unwrap();
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].sha256, source_attachment.sha256);

    assert!(std::path::Path::new(&source_attachment.original_path).exists());
}

#[test]
fn t12_missing_source_file_fails_without_a_partial_copy() {
    let ctx = Ctx::new();
    let id = ctx.create_order("原图丢失");
    let dir = tempfile::tempdir().unwrap();
    let first = write_image(dir.path(), "第一张.png", 16, 16);
    let second = write_image(dir.path(), "第二张.png", 18, 18);
    import_one(&ctx, &id, &first);
    let gone = import_one(&ctx, &id, &second);
    let source = ctx.load(&id);

    // 让第二张在复制途中失败：第一张已经落盘，必须被清理掉。
    std::fs::remove_file(&gone.original_path).unwrap();
    let originals = ctx
        .env
        .layout()
        .attachments_dir(ctx.env.active_generation())
        .join("originals");

    let orders_before: i64 = ctx
        .conn()
        .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
        .unwrap();
    let files_before = std::fs::read_dir(&originals).unwrap().count();

    let err = duplicate(&ctx, dup_input(&source, true)).unwrap_err();
    assert!(err.message.contains("原图文件缺失"), "{}", err.message);

    let orders_after: i64 = ctx
        .conn()
        .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
        .unwrap();
    assert_eq!(orders_before, orders_after);
    // 已落盘的第一张副本被删掉，目录里没有多出任何文件。
    assert_eq!(std::fs::read_dir(&originals).unwrap().count(), files_before);

    let attachments_total: i64 = ctx
        .conn()
        .query_row("SELECT COUNT(*) FROM attachments", [], |r| r.get(0))
        .unwrap();
    assert_eq!(attachments_total, 2);

    // 失败后不留 pending 的复制作业。
    let pending: i64 = ctx
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM attachment_jobs WHERE state = 'pending'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(pending, 0);
}

#[test]
fn t13_same_request_id_does_not_create_a_second_copy() {
    let ctx = Ctx::new();
    let id = ctx.create_order("连点保存");
    let source = ctx.load(&id);

    let mut once = dup_input(&source, false);
    once.request_id = Some("dup-req-1".into());
    let first = duplicate(&ctx, once.clone()).unwrap();
    let second = duplicate(&ctx, once).unwrap();

    assert_eq!(first.id, second.id);
    let total: i64 = ctx
        .conn()
        .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
        .unwrap();
    assert_eq!(total, 2);
}

#[test]
fn t14_source_order_is_untouched() {
    let ctx = Ctx::new();
    let id = ctx.create_order("来源不动");
    let dir = tempfile::tempdir().unwrap();
    let image = write_image(dir.path(), "参考.png", 22, 18);
    import_one(&ctx, &id, &image);
    start(&ctx, &id);
    let source = ctx.load(&id);

    let before_events = ctx.kinds(&source.id);
    let originals = ctx
        .env
        .layout()
        .attachments_dir(ctx.env.active_generation())
        .join("originals");
    let before_files = std::fs::read_dir(&originals).unwrap().count();

    duplicate(&ctx, dup_input(&source, true)).unwrap();

    let after = ctx.load(&source.id);
    assert_eq!(after.title, source.title);
    assert_eq!(after.status, source.status);
    assert_eq!(after.revision, source.revision);
    assert_eq!(after.current_stage_id, source.current_stage_id);
    assert_eq!(after.queue_position, source.queue_position);
    assert_eq!(after.started_at, source.started_at);
    assert_eq!(after.updated_at, source.updated_at);
    assert_eq!(ctx.kinds(&source.id), before_events);

    // 来源多了一个文件？不：副本写到新路径，来源目录只多出副本那一份。
    let after_files = std::fs::read_dir(&originals).unwrap().count();
    assert_eq!(after_files, before_files + 1);
}
