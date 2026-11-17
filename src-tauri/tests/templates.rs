//! 全局流程模板：约束、默认模板唯一、删除/复制，以及"改模板不影响已有订单"。

mod common;

use common::Ctx;
use minidesk::domain::orders::{create_order, CreateOrderInput};
use minidesk::domain::templates::{
    self, CreateTemplateInput, DeleteTemplateInput, DuplicateTemplateInput, SetDefaultInput,
    StepInput, UpdateTemplateInput,
};

fn steps(titles: &[&str]) -> Vec<StepInput> {
    titles
        .iter()
        .map(|t| StepInput {
            step_id: None,
            title: (*t).to_string(),
        })
        .collect()
}

fn make(ctx: &Ctx, name: &str, titles: &[&str]) -> templates::TemplateView {
    let mut conn = ctx.conn();
    templates::create(
        &mut conn,
        CreateTemplateInput {
            name: name.into(),
            steps: steps(titles),
            make_default: false,
        },
    )
    .unwrap()
}

#[test]
fn builtin_default_template_is_listed_first() {
    let ctx = Ctx::new();
    let conn = ctx.conn();
    let list = templates::list(&conn).unwrap();
    assert_eq!(list.len(), 1);
    assert!(list[0].is_default);
    assert_eq!(list[0].step_count, 5);
    assert_eq!(
        list[0].steps.iter().map(|s| s.title.as_str()).collect::<Vec<_>>(),
        vec!["草稿", "线稿", "固有色", "细化", "最终调整"]
    );
}

#[test]
fn create_template_with_steps_and_stable_ids() {
    let ctx = Ctx::new();
    let created = make(&ctx, "简版流程", &["草图", "上色", "完成"]);
    assert_eq!(created.step_count, 3);
    assert!(!created.is_default);
    assert!(created.steps.iter().all(|s| s.step_id.starts_with("step-")));

    let ids: Vec<&str> = created.steps.iter().map(|s| s.step_id.as_str()).collect();
    assert_ne!(ids[0], ids[1], "阶段 ID 必须独立");
}

#[test]
fn step_count_must_stay_between_one_and_twenty() {
    let ctx = Ctx::new();
    let mut conn = ctx.conn();

    let empty = templates::create(
        &mut conn,
        CreateTemplateInput {
            name: "空模板".into(),
            steps: vec![],
            make_default: false,
        },
    )
    .unwrap_err();
    assert_eq!(empty.code, "INVALID");

    let too_many: Vec<StepInput> = (0..21)
        .map(|i| StepInput {
            step_id: None,
            title: format!("阶段{i}"),
        })
        .collect();
    let err = templates::create(
        &mut conn,
        CreateTemplateInput {
            name: "太长".into(),
            steps: too_many,
            make_default: false,
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "INVALID");
    assert!(err.message.contains("20"), "{}", err.message);
}

#[test]
fn duplicate_step_names_are_rejected() {
    let ctx = Ctx::new();
    let mut conn = ctx.conn();
    let err = templates::create(
        &mut conn,
        CreateTemplateInput {
            name: "重名".into(),
            steps: steps(&["草稿", "草稿"]),
            make_default: false,
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "INVALID");
    assert!(err.message.contains("重复"), "{}", err.message);
}

#[test]
fn update_keeps_existing_step_ids_and_applies_new_order() {
    let ctx = Ctx::new();
    let created = make(&ctx, "可编辑", &["A", "B", "C"]);
    let ids: Vec<String> = created.steps.iter().map(|s| s.step_id.clone()).collect();

    let mut conn = ctx.conn();
    let updated = templates::update(
        &mut conn,
        UpdateTemplateInput {
            template_id: created.id.clone(),
            expected_revision: 0,
            name: "可编辑（改）".into(),
            steps: vec![
                StepInput {
                    step_id: Some(ids[1].clone()),
                    title: "B".into(),
                },
                StepInput {
                    step_id: Some(ids[0].clone()),
                    title: "A".into(),
                },
            ],
        },
    )
    .unwrap();

    assert_eq!(updated.name, "可编辑（改）");
    assert_eq!(updated.revision, 1);
    assert_eq!(
        updated.steps.iter().map(|s| s.title.as_str()).collect::<Vec<_>>(),
        vec!["B", "A"]
    );
    assert_eq!(updated.steps[0].step_id, ids[1], "阶段 ID 必须保持稳定");
}

#[test]
fn update_requires_the_current_revision() {
    let ctx = Ctx::new();
    let created = make(&ctx, "版本模板", &["A"]);
    let mut conn = ctx.conn();
    templates::update(
        &mut conn,
        UpdateTemplateInput {
            template_id: created.id.clone(),
            expected_revision: 0,
            name: "改动一".into(),
            steps: steps(&["A"]),
        },
    )
    .unwrap();

    let err = templates::update(
        &mut conn,
        UpdateTemplateInput {
            template_id: created.id.clone(),
            expected_revision: 0,
            name: "改动二".into(),
            steps: steps(&["A"]),
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "CONFLICT");
}

#[test]
fn duplicate_copies_steps_with_new_ids() {
    let ctx = Ctx::new();
    let source = make(&ctx, "原始", &["X", "Y"]);
    let mut conn = ctx.conn();
    let copy = templates::duplicate(
        &mut conn,
        DuplicateTemplateInput {
            source_id: source.id.clone(),
            name: "副本".into(),
        },
    )
    .unwrap();

    assert_eq!(copy.name, "副本");
    assert_ne!(copy.id, source.id);
    assert!(!copy.is_default);
    assert_eq!(
        copy.steps.iter().map(|s| s.title.as_str()).collect::<Vec<_>>(),
        vec!["X", "Y"]
    );
    for step in &copy.steps {
        assert!(
            !source.steps.iter().any(|s| s.step_id == step.step_id),
            "副本阶段必须是新的 ID"
        );
    }
}

#[test]
fn default_template_is_unique_and_can_be_switched() {
    let ctx = Ctx::new();
    let other = make(&ctx, "备选", &["A"]);
    let mut conn = ctx.conn();

    let list = templates::set_default(
        &mut conn,
        SetDefaultInput {
            template_id: other.id.clone(),
        },
    )
    .unwrap();
    let defaults: Vec<&templates::TemplateView> = list.iter().filter(|t| t.is_default).collect();
    assert_eq!(defaults.len(), 1, "系统始终只有一个默认模板");
    assert_eq!(defaults[0].id, other.id);
}

#[test]
fn deleting_the_default_template_requires_a_replacement() {
    let ctx = Ctx::new();
    let other = make(&ctx, "备选", &["A"]);
    let mut conn = ctx.conn();
    let default_id = templates::list(&conn)
        .unwrap()
        .into_iter()
        .find(|t| t.is_default)
        .unwrap()
        .id;

    let err = templates::remove(
        &mut conn,
        DeleteTemplateInput {
            template_id: default_id.clone(),
            expected_revision: 0,
            replacement_default_id: None,
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "INVALID");
    assert!(err.message.contains("默认"), "{}", err.message);

    let list = templates::remove(
        &mut conn,
        DeleteTemplateInput {
            template_id: default_id.clone(),
            expected_revision: 0,
            replacement_default_id: Some(other.id.clone()),
        },
    )
    .unwrap();
    assert!(!list.iter().any(|t| t.id == default_id));
    assert_eq!(
        list.iter().filter(|t| t.is_default).count(),
        1,
        "删除后仍有且仅有一个默认模板"
    );
    assert!(list.iter().find(|t| t.is_default).unwrap().id == other.id);
}

#[test]
fn the_last_template_cannot_be_deleted() {
    let ctx = Ctx::new();
    let mut conn = ctx.conn();
    let only = templates::list(&conn).unwrap();
    assert_eq!(only.len(), 1);

    let err = templates::remove(
        &mut conn,
        DeleteTemplateInput {
            template_id: only[0].id.clone(),
            expected_revision: only[0].revision,
            replacement_default_id: None,
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "INVALID");
    assert!(err.message.contains("至少"), "{}", err.message);
}

#[test]
fn deleting_a_non_default_template_needs_no_replacement() {
    let ctx = Ctx::new();
    let spare = make(&ctx, "可删", &["A", "B"]);
    let mut conn = ctx.conn();
    let list = templates::remove(
        &mut conn,
        DeleteTemplateInput {
            template_id: spare.id.clone(),
            expected_revision: 0,
            replacement_default_id: None,
        },
    )
    .unwrap();
    assert_eq!(list.len(), 1);
    assert!(list[0].is_default);
}

#[test]
fn deleting_a_template_does_not_touch_existing_orders() {
    let ctx = Ctx::new();
    let tpl = make(&ctx, "会被删掉的模板", &["一", "二"]);
    let mut conn = ctx.conn();
    let order = create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        CreateOrderInput {
            title: "用了这个模板".into(),
            template_id: Some(tpl.id.clone()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(order.stage_count, 2);

    templates::remove(
        &mut conn,
        DeleteTemplateInput {
            template_id: tpl.id.clone(),
            expected_revision: 0,
            replacement_default_id: None,
        },
    )
    .unwrap();

    let after = ctx.load(&order.id);
    assert_eq!(after.stage_count, 2, "订单流程是独立副本，删模板不影响它");
    assert_eq!(after.current_stage_title.as_deref(), Some("一"));
}

#[test]
fn editing_a_template_does_not_change_existing_orders() {
    let ctx = Ctx::new();
    let tpl = make(&ctx, "会改名的模板", &["甲", "乙"]);
    let mut conn = ctx.conn();
    let order = create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        CreateOrderInput {
            title: "已存在的订单".into(),
            template_id: Some(tpl.id.clone()),
            ..Default::default()
        },
    )
    .unwrap();

    templates::update(
        &mut conn,
        UpdateTemplateInput {
            template_id: tpl.id.clone(),
            expected_revision: 0,
            name: "改过的模板".into(),
            steps: steps(&["完全", "不同", "的阶段"]),
        },
    )
    .unwrap();

    let after = ctx.load(&order.id);
    assert_eq!(
        after.stages.iter().map(|s| s.title.as_str()).collect::<Vec<_>>(),
        vec!["甲", "乙"],
        "模板修改不追溯已有订单"
    );
}

#[test]
fn create_order_uses_the_default_template_when_none_is_given() {
    let ctx = Ctx::new();
    let mut conn = ctx.conn();
    let custom = make(&ctx, "新默认", &["唯一"]);
    templates::set_default(
        &mut conn,
        SetDefaultInput {
            template_id: custom.id.clone(),
        },
    )
    .unwrap();

    let order = create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        CreateOrderInput {
            title: "跟随默认模板".into(),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(order.stage_count, 1);
    assert_eq!(order.current_stage_title.as_deref(), Some("唯一"));
}

#[test]
fn usage_count_tracks_orders_created_from_a_template() {
    let ctx = Ctx::new();
    let tpl = make(&ctx, "计次模板", &["A"]);
    let mut conn = ctx.conn();
    for title in ["单1", "单2"] {
        create_order(
            &mut conn,
            &ctx.hw,
            common::tz(),
            CreateOrderInput {
                title: title.into(),
                template_id: Some(tpl.id.clone()),
                ..Default::default()
            },
        )
        .unwrap();
    }
    let reloaded = templates::get(&conn, &tpl.id).unwrap();
    assert_eq!(reloaded.usage_count, 2);
}
