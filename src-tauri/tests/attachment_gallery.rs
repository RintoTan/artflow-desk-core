//! 画廊元数据：只有"成品"才允许设为可展示；旧附件默认不可展示。

mod common;

use common::Ctx;
use minidesk::domain::attachments::{self, UpdateAttachmentMetaInput};

/// 直接插一条附件行（不经过导入，避免依赖真实图片解码）。
fn seed_attachment(ctx: &Ctx, order_id: &str) -> String {
    let conn = ctx.conn();
    let now = minidesk::store::timezone::now_timestamp();
    conn.execute(
        "INSERT INTO attachments (id, order_id, original_name, rel_path, mime_type,
                                  byte_size, sha256, state, created_at)
         VALUES ('a1', ?1, 'ref.png', 'attachments/ref.png', 'image/png', 10, 'x', 'ok', ?2)",
        rusqlite::params![order_id, now],
    )
    .unwrap();
    "a1".to_string()
}

fn meta(role: Option<Option<&str>>, visible: Option<bool>) -> UpdateAttachmentMetaInput {
    UpdateAttachmentMetaInput {
        attachment_id: "a1".into(),
        display_name: None,
        note: None,
        tag: None,
        role: role.map(|r| r.map(|s| s.to_string())),
        gallery_visible: visible,
    }
}

#[test]
fn new_attachment_defaults_to_unclassified_and_hidden() {
    let ctx = Ctx::new();
    let order = ctx.create_order("测试单");
    seed_attachment(&ctx, &order);
    let conn = ctx.conn();
    let list = attachments::list(
        &conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        &order,
    )
    .unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].role, None, "默认未分类");
    assert!(!list[0].gallery_visible, "默认不进画廊");
}

#[test]
fn cannot_publish_reference_or_unclassified_image() {
    let ctx = Ctx::new();
    let order = ctx.create_order("测试单");
    seed_attachment(&ctx, &order);
    let conn = ctx.conn();

    let err = attachments::update_meta(
        &conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        meta(None, Some(true)),
    )
    .unwrap_err();
    assert!(
        err.message.contains("成品"),
        "未分类不允许设为可展示，实际：{}",
        err.message
    );

    // 标记为参考素材后同样不允许。
    attachments::update_meta(
        &conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        meta(Some(Some("reference")), None),
    )
    .unwrap();
    assert!(
        attachments::update_meta(
            &conn,
            ctx.env.layout(),
            ctx.env.active_generation(),
            meta(None, Some(true)),
        )
        .is_err(),
        "参考素材不得进入画廊"
    );
}

#[test]
fn final_role_allows_visibility_and_back() {
    let ctx = Ctx::new();
    let order = ctx.create_order("测试单");
    seed_attachment(&ctx, &order);
    let conn = ctx.conn();

    let view = attachments::update_meta(
        &conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        meta(Some(Some("final")), Some(true)),
    )
    .unwrap();
    assert_eq!(view.role.as_deref(), Some("final"));
    assert!(view.gallery_visible);

    let hidden = attachments::update_meta(
        &conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        meta(None, Some(false)),
    )
    .unwrap();
    assert!(!hidden.gallery_visible, "隐藏只改展示状态");
    assert_eq!(hidden.role.as_deref(), Some("final"), "隐藏不改角色");

    // 退回未分类时必须先取消展示，否则会出现"可展示但不是成品"的脏状态。
    let reset = attachments::update_meta(
        &conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        meta(Some(None), None),
    )
    .unwrap();
    assert_eq!(reset.role, None);
    assert!(!reset.gallery_visible);
}

#[test]
fn unknown_role_is_rejected() {
    let ctx = Ctx::new();
    let order = ctx.create_order("测试单");
    seed_attachment(&ctx, &order);
    let conn = ctx.conn();
    let err = attachments::update_meta(
        &conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        meta(Some(Some("cover")), None),
    )
    .unwrap_err();
    assert!(err.message.contains("reference"), "只接受两个已知角色");
}
