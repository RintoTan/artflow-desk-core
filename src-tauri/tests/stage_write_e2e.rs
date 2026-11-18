//! DEV-06D-1-CLOSE-01 / 任务 C：阶段变更的真实写入闭环。
//!
//! 每个用例都在 tempfile 里新建一个**独立的空数据环境**，不读也不写用户的
//! QA 目录或正式 v3 台账。断言不看内存里的返回值就收工，而是回到 SQLite
//! 直接核对 `orders.current_stage_id` / `revision` / `order_events` / `order_stages`，
//! 再用一个新连接重读一次，证明落盘结果与返回的视图一致。

mod common;

use common::{lifecycle_input, Ctx};
use minidesk::domain::events;
use minidesk::domain::lifecycle::{self, LifecycleInput, ReworkInput};
use minidesk::domain::orders::{create_order, CreateOrderInput, OrderView};
use minidesk::domain::templates::{self, CreateTemplateInput, StepInput};

/// 直接读数据库里的那一行，绕开视图层。
fn db_state(ctx: &Ctx, id: &str) -> (Option<String>, i64, String) {
    let conn = ctx.conn();
    conn.query_row(
        "SELECT current_stage_id, revision, status FROM orders WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .expect("订单行必须存在")
}

fn stage_row_count(ctx: &Ctx, id: &str) -> i64 {
    let conn = ctx.conn();
    conn.query_row(
        "SELECT count(*) FROM order_stages WHERE order_id = ?1",
        [id],
        |r| r.get(0),
    )
    .expect("统计阶段失败")
}

fn event_count(ctx: &Ctx, id: &str) -> i64 {
    let conn = ctx.conn();
    conn.query_row(
        "SELECT count(*) FROM order_events WHERE order_id = ?1",
        [id],
        |r| r.get(0),
    )
    .expect("统计事件失败")
}

fn kinds(ctx: &Ctx, id: &str) -> Vec<String> {
    ctx.events(id).into_iter().map(|e| e.kind).collect()
}

fn start(ctx: &Ctx, id: &str) -> OrderView {
    let view = ctx.load(id);
    let mut conn = ctx.conn();
    lifecycle::start_work(&mut conn, lifecycle_input(&view)).expect("开工失败")
}

fn advance(ctx: &Ctx, id: &str) -> Result<OrderView, minidesk::error::AppError> {
    let view = ctx.load(id);
    let mut conn = ctx.conn();
    lifecycle::advance_stage(&mut conn, lifecycle_input(&view))
}

fn rework(
    ctx: &Ctx,
    id: &str,
    target: Option<&str>,
) -> Result<OrderView, minidesk::error::AppError> {
    let view = ctx.load(id);
    let mut conn = ctx.conn();
    lifecycle::rework_stage(
        &mut conn,
        ReworkInput {
            order_id: id.into(),
            expected_revision: view.revision,
            target_stage_id: target.map(|s| s.to_string()),
            request_id: None,
        },
    )
}

/// 一张订单 + 一份快照，方便比较"操作前后到底改了什么"。
struct Snapshot {
    stage_id: Option<String>,
    revision: i64,
    events: i64,
    stages: i64,
    kinds: Vec<String>,
}

fn snapshot(ctx: &Ctx, id: &str) -> Snapshot {
    let (stage_id, revision, _) = db_state(ctx, id);
    Snapshot {
        stage_id,
        revision,
        events: event_count(ctx, id),
        stages: stage_row_count(ctx, id),
        kinds: kinds(ctx, id),
    }
}

#[test]
fn advance_writes_one_stage_one_event_and_one_revision() {
    let ctx = Ctx::new();
    let id = ctx.create_order("推进闭环");
    start(&ctx, &id);

    let before = snapshot(&ctx, &id);
    let before_view = ctx.load(&id);
    assert_eq!(
        before_view.current_stage_index,
        Some(0),
        "新单应在第一个阶段"
    );

    let after = advance(&ctx, &id).expect("合法推进必须成功");

    // 1) 返回的视图
    assert_eq!(after.current_stage_index, Some(1), "阶段没有前进一步");
    assert_eq!(after.revision, before.revision + 1, "revision 必须 +1");
    assert_eq!(
        after.current_stage_id.as_deref(), Some(after.stages[1].id.as_str()),
        "视图里的当前阶段与阶段表不一致"
    );

    // 2) 落库的行
    let (stage_id, revision, status) = db_state(&ctx, &id);
    assert_eq!(stage_id, after.current_stage_id, "数据库里的阶段没有更新");
    assert_eq!(revision, after.revision, "数据库里的 revision 没有更新");
    assert_eq!(status, "active");

    // 3) 历史事件：正好多一条 stage_advanced，且带方向与前后阶段
    assert_eq!(event_count(&ctx, &id), before.events + 1, "必须只写一条事件");
    let events = ctx.events(&id);
    let last = events.last().expect("必须有事件");
    assert_eq!(last.kind, events::STAGE_ADVANCED);
    assert_eq!(last.movement.as_deref(), Some("forward"));
    assert_eq!(last.from_stage_id.as_deref(), before.stage_id.as_deref());
    assert_eq!(last.to_stage_id.as_deref(), after.current_stage_id.as_deref());
    assert_eq!(
        events
            .iter()
            .filter(|e| e.kind == events::STAGE_ADVANCED)
            .count(),
        1,
        "不能出现多余的推进事件"
    );

    // 4) 阶段表本身不能被改写
    assert_eq!(stage_row_count(&ctx, &id), before.stages, "阶段表不应变化");

    // 5) 用一条新的数据库连接重读：结果必须来自磁盘，而不是缓存的视图
    let fresh = ctx.conn();
    let again = minidesk::domain::orders::load(&fresh, &id).expect("重读失败");
    assert_eq!(again.current_stage_id, after.current_stage_id);
    assert_eq!(again.revision, after.revision);
    let fresh_events = minidesk::domain::events::list(&fresh, &id).expect("重读事件失败");
    assert_eq!(
        fresh_events.len() as i64,
        before.events + 1,
        "磁盘上的事件条数与返回结果不一致"
    );
}

#[test]
fn rework_to_earlier_stage_keeps_history_and_is_persisted() {
    let ctx = Ctx::new();
    let id = ctx.create_order("返工闭环");
    start(&ctx, &id);
    advance(&ctx, &id).expect("第一次推进");
    advance(&ctx, &id).expect("第二次推进");

    let before = snapshot(&ctx, &id);
    let view = ctx.load(&id);
    let target = view.stages[0].id.clone();
    assert_eq!(view.current_stage_index, Some(2));

    let after = rework(&ctx, &id, Some(&target)).expect("合法返工必须成功");

    assert_eq!(after.current_stage_index, Some(0), "没有回到目标阶段");
    assert_eq!(after.current_stage_id.as_deref(), Some(target.as_str()));
    assert_eq!(after.revision, before.revision + 1, "revision 必须 +1");

    let (stage_id, revision, _) = db_state(&ctx, &id);
    assert_eq!(stage_id.as_deref(), Some(target.as_str()));
    assert_eq!(revision, after.revision);

    // 历史必须保留，不能因为返工把之前的推进抹掉。
    let after_kinds = kinds(&ctx, &id);
    assert_eq!(
        &after_kinds[..before.kinds.len()],
        before.kinds.as_slice(),
        "返工改写了已有事件序列"
    );
    assert_eq!(event_count(&ctx, &id), before.events + 1);

    let last = ctx.events(&id).pop().expect("必须有事件");
    assert_eq!(last.kind, events::STAGE_REWORKED);
    assert_eq!(last.movement.as_deref(), Some("backward"));
    assert_eq!(last.to_stage_id.as_deref(), Some(target.as_str()));
    assert_eq!(last.note.as_deref(), Some("多阶段返工"), "跨两级返工要留注记");
    assert_eq!(stage_row_count(&ctx, &id), before.stages);

    let fresh = ctx.conn();
    let again = minidesk::domain::orders::load(&fresh, &id).expect("重读失败");
    assert_eq!(again.current_stage_id.as_deref(), Some(target.as_str()));
    assert_eq!(again.revision, after.revision);
}

#[test]
fn rejected_moves_leave_no_partial_write() {
    let ctx = Ctx::new();
    let id = ctx.create_order("非法操作");
    let not_started = snapshot(&ctx, &id);

    // 未开工：推进与返工都必须拒绝，且一个字都不写。
    let err = advance(&ctx, &id).expect_err("未开工不能推进");
    assert_eq!(err.code, "INVALID");
    assert!(err.message.contains("尚未开始制作"), "{}", err.message);
    let err = rework(&ctx, &id, None).expect_err("未开工不能返工");
    assert_eq!(err.code, "INVALID");
    assert_eq!(snapshot(&ctx, &id).revision, not_started.revision);
    assert_eq!(snapshot(&ctx, &id).events, not_started.events);
    assert_eq!(snapshot(&ctx, &id).stage_id, not_started.stage_id);

    start(&ctx, &id);
    advance(&ctx, &id).expect("进入第二阶段");

    // 直接跳到最后一个阶段：没有对应命令，返工命令也必须拒绝。
    let view = ctx.load(&id);
    let last = view.stages.last().expect("至少一个阶段").id.clone();
    let before_skip = snapshot(&ctx, &id);
    let err = rework(&ctx, &id, Some(&last)).expect_err("返工不能当作越级推进");
    assert_eq!(err.code, "INVALID");
    assert!(err.message.contains("更早的阶段"), "{}", err.message);
    assert_eq!(snapshot(&ctx, &id).stage_id, before_skip.stage_id);
    assert_eq!(snapshot(&ctx, &id).revision, before_skip.revision);

    // 跨模板：另一套流程的阶段 ID 不属于本单，必须拒绝。
    let other = {
        let mut conn = ctx.conn();
        templates::create(
            &mut conn,
            CreateTemplateInput {
                name: "另一套流程".into(),
                steps: vec![
            StepInput { step_id: None, title: "起稿".into() },
            StepInput { step_id: None, title: "上色".into() },
                ],
                make_default: false,
            },
        )
        .expect("建模板失败")
    };
    let foreign = other.steps[0].step_id.clone();
    let err = rework(&ctx, &id, Some(&foreign)).expect_err("跨模板目标必须拒绝");
    assert_eq!(err.code, "INVALID");
    assert!(err.message.contains("不属于该订单的流程"), "{}", err.message);

    // revision 冲突：基于旧版本提交，必须拒绝且不写入。
    let stale = {
        let view = ctx.load(&id);
        LifecycleInput {
            order_id: id.clone(),
            expected_revision: view.revision - 1,
            request_id: None,
        }
    };
    let before_conflict = snapshot(&ctx, &id);
    let mut conn = ctx.conn();
    let err = lifecycle::advance_stage(&mut conn, stale).expect_err("旧版本必须冲突");
    assert_eq!(err.code, "CONFLICT");
    assert_eq!(snapshot(&ctx, &id).revision, before_conflict.revision);
    assert_eq!(snapshot(&ctx, &id).stage_id, before_conflict.stage_id);
    assert_eq!(event_count(&ctx, &id), before_conflict.events);

    // 走到最后一个阶段后不能再推进；完成后连返工也锁死。
    while ctx.load(&id).capabilities.can_advance {
        advance(&ctx, &id).expect("逐级推进必须成功");
    }
    let at_last = snapshot(&ctx, &id);
    let err = advance(&ctx, &id).expect_err("最后一阶段不能推进");
    assert_eq!(err.code, "INVALID");
    assert!(err.message.contains("最后一个阶段"), "{}", err.message);

    let view = ctx.load(&id);
    let mut conn = ctx.conn();
    lifecycle::complete_order(&mut conn, lifecycle_input(&view)).expect("完成订单");
    let completed = snapshot(&ctx, &id);
    let err = advance(&ctx, &id).expect_err("终态不能推进");
    assert_eq!(err.code, "INVALID");
    assert!(err.message.contains("已完成或已取消"), "{}", err.message);
    let err = rework(&ctx, &id, None).expect_err("终态不能返工");
    assert_eq!(err.code, "INVALID");
    assert_eq!(snapshot(&ctx, &id).revision, completed.revision);
    assert_eq!(snapshot(&ctx, &id).stage_id, at_last.stage_id);
    assert_eq!(event_count(&ctx, &id), completed.events);
}

/// 指定模板建单：证明推进只在该订单自己的阶段表里走，不受默认模板影响。
#[test]
fn advance_follows_the_orders_own_template() {
    let ctx = Ctx::new();
    let tpl = {
        let mut conn = ctx.conn();
        templates::create(
            &mut conn,
            CreateTemplateInput {
                name: "三步流程".into(),
                steps: vec![
                    StepInput { step_id: None, title: "构图".into() },
                    StepInput { step_id: None, title: "线稿".into() },
                    StepInput { step_id: None, title: "成稿".into() },
                ],
                make_default: false,
            },
        )
        .expect("建模板失败")
    };
    let id = {
        let mut conn = ctx.conn();
        create_order(
            &mut conn,
            &ctx.hw,
            common::tz(),
            CreateOrderInput {
                title: "自定义流程".into(),
                template_id: Some(tpl.id.clone()),
                ..Default::default()
            },
        )
        .expect("建单失败")
        .id
    };

    let view = ctx.load(&id);
    assert_eq!(view.stages.len(), 3, "订单必须使用自己模板的三个阶段");
    start(&ctx, &id);
    let before = ctx.load(&id).revision;
    let after = advance(&ctx, &id).expect("推进失败");
    assert_eq!(after.current_stage_title.as_deref(), Some("线稿"));
    assert_eq!(after.revision, before + 1, "推进只加一个版本");
    assert_eq!(kinds(&ctx, &id), vec!["created", "work_started", "stage_advanced"]);
}
