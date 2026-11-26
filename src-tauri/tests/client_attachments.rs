//! 客户参考图：归属、文件落地、删除与清理、备份覆盖。

mod common;

use std::path::Path;

use common::Ctx;
use image::{ImageFormat, Rgb, RgbImage};
use minidesk::domain::client_attachments;

fn write_image(dir: &Path, name: &str, w: u32, h: u32, format: ImageFormat) -> std::path::PathBuf {
    let path = dir.join(name);
    let mut img = RgbImage::new(w, h);
    for (x, y, px) in img.enumerate_pixels_mut() {
        *px = Rgb([(x % 256) as u8, (y % 256) as u8, 128]);
    }
    img.save_with_format(&path, format).expect("写测试图片");
    path
}

/// Windows 的路径分隔符是反斜杠，断言语义前先归一化，否则跨平台测试会假红。
fn norm(path: &str) -> String {
    path.replace('\\', "/")
}

fn seed_client(ctx: &Ctx, id: &str, name: &str) {
    let conn = ctx.conn();
    let now = minidesk::store::timezone::now_timestamp();
    conn.execute(
        "INSERT INTO clients (id, display_name, contact, note, revision, created_at, updated_at)
         VALUES (?1, ?2, NULL, NULL, 0, ?3, ?3)",
        rusqlite::params![id, name, now],
    )
    .expect("插入客户失败");
}

#[test]
fn 参考图导入后原图与缩略图都落盘() {
    let ctx = Ctx::new();
    seed_client(&ctx, "client-a", "林三");
    let dir = tempfile::tempdir().unwrap();
    let mut conn = ctx.conn();

    let outcomes = client_attachments::import(
        &mut conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        "client-a",
        &[write_image(dir.path(), "ref.png", 12, 12, ImageFormat::Png)],
    )
    .expect("导入参考图");
    assert_eq!(outcomes.len(), 1);
    assert!(outcomes[0].ok, "{:?}", outcomes[0].error);
    let view = outcomes[0].attachment.as_ref().expect("应当返回视图");
    assert_eq!(view.state, "ok");
    assert!(view.file_exists);
    assert!(view.thumb_exists, "缩略图应当生成");
    assert!(norm(&view.original_path).contains("attachments/originals/clients/client-a/"));

    // 文件真的在磁盘上，不是只有数据库一行
    assert!(std::fs::metadata(&view.original_path).is_ok());
    assert!(std::fs::metadata(view.thumb_path.as_ref().unwrap()).is_ok());
}

#[test]
fn 列表按客户隔离() {
    let ctx = Ctx::new();
    seed_client(&ctx, "client-a", "林三");
    seed_client(&ctx, "client-b", "王五");
    let dir = tempfile::tempdir().unwrap();
    let mut conn = ctx.conn();

    client_attachments::import(
        &mut conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        "client-a",
        &[write_image(dir.path(), "a1.png", 8, 8, ImageFormat::Png)],
    )
    .unwrap();

    let a = client_attachments::list(&conn, ctx.env.layout(), ctx.env.active_generation(), "client-a").unwrap();
    let b = client_attachments::list(&conn, ctx.env.layout(), ctx.env.active_generation(), "client-b").unwrap();
    assert_eq!(a.len(), 1);
    assert!(b.is_empty(), "别的客户不该看到这张图");
}

#[test]
fn 删除会登记清理任务并移除文件() {
    let ctx = Ctx::new();
    seed_client(&ctx, "client-a", "林三");
    let dir = tempfile::tempdir().unwrap();
    let mut conn = ctx.conn();
    let view = client_attachments::import(
        &mut conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        "client-a",
        &[write_image(dir.path(), "a1.png", 8, 8, ImageFormat::Png)],
    )
    .unwrap()[0]
        .attachment
        .clone()
        .unwrap();

    let original = view.original_path.clone();
    client_attachments::remove(
        &mut conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        "client-a",
        &view.id,
    )
    .unwrap();

    assert!(client_attachments::list(&conn, ctx.env.layout(), ctx.env.active_generation(), "client-a")
        .unwrap()
        .is_empty());
    assert!(!std::path::Path::new(&original).exists(), "文件应当被删除");

    let queued: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cleanup_tasks WHERE reason = 'client_attachment_removed'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(queued >= 1, "删除必须先登记清理任务，才能兜住删文件失败");
}

#[test]
fn 不能跨客户删除() {
    let ctx = Ctx::new();
    seed_client(&ctx, "client-a", "林三");
    seed_client(&ctx, "client-b", "王五");
    let dir = tempfile::tempdir().unwrap();
    let mut conn = ctx.conn();
    let view = client_attachments::import(
        &mut conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        "client-a",
        &[write_image(dir.path(), "a1.png", 8, 8, ImageFormat::Png)],
    )
    .unwrap()[0]
        .attachment
        .clone()
        .unwrap();

    let err = client_attachments::remove(
        &mut conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        "client-b",
        &view.id,
    )
    .expect_err("跨客户删除必须失败");
    assert_eq!(err.code, "NOT_FOUND");

    // 原图还在，行也还在
    assert!(std::path::Path::new(&view.original_path).exists());
    assert_eq!(
        client_attachments::list(&conn, ctx.env.layout(), ctx.env.active_generation(), "client-a")
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn 客户被清除前把参考图文件登记进清理队列() {
    let ctx = Ctx::new();
    seed_client(&ctx, "client-a", "林三");
    let dir = tempfile::tempdir().unwrap();
    let mut conn = ctx.conn();
    client_attachments::import(
        &mut conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        "client-a",
        &[write_image(dir.path(), "a1.png", 8, 8, ImageFormat::Png)],
    )
    .unwrap();

    let queued = client_attachments::enqueue_all_for_client(
        &conn,
        ctx.env.active_generation(),
        "client-a",
    )
    .unwrap();
    assert!(queued >= 2, "原图与缩略图都要登记，实际 {queued}");

    // 行被 CASCADE 带走后，任务还在，文件不会永远没人认领
    conn.execute("DELETE FROM clients WHERE id = 'client-a'", []).unwrap();
    let left: i64 = conn
        .query_row("SELECT COUNT(*) FROM cleanup_tasks WHERE reason = 'client_removed'", [], |r| r.get(0))
        .unwrap();
    assert!(left >= 2);
}

#[test]
fn 参考图文件进备份清单() {
    let ctx = Ctx::new();
    seed_client(&ctx, "client-a", "林三");
    let dir = tempfile::tempdir().unwrap();
    let mut conn = ctx.conn();
    let view = client_attachments::import(
        &mut conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        "client-a",
        &[write_image(dir.path(), "a1.png", 8, 8, ImageFormat::Png)],
    )
    .unwrap()[0]
        .attachment
        .clone()
        .unwrap();

    let files = minidesk::backup::create::attachment_files(ctx.env.layout(), ctx.env.active_generation())
        .expect("收集附件文件");
    let rels: Vec<String> = files.iter().map(|(rel, _)| rel.clone()).collect();
    assert!(
        rels.iter().any(|rel| rel.contains("clients/client-a/")),
        "备份清单必须带上客户参考图：{rels:?}"
    );
    assert!(std::path::Path::new(&view.original_path).exists());
}

#[test]
fn v13_库升到_v14_后新表就位且旧数据不丢() {
    use minidesk::store::migrations;

    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("legacy.sqlite");
    let mut conn = rusqlite::Connection::open(&db).unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();

    // 按正式迁移链先停在 v13，模拟 0.1.1 时代的库
    let list = migrations::production();
    migrations::migrate_to(&mut conn, &list, 13).unwrap();
    assert_eq!(migrations::schema_version(&conn).unwrap(), 13);

    let now = minidesk::store::timezone::now_timestamp();
    conn.execute(
        "INSERT INTO clients (id, display_name, contact, note, revision, created_at, updated_at)
         VALUES ('legacy-client', '老客户', NULL, NULL, 0, ?1, ?1)",
        [&now],
    )
    .unwrap();

    // 升到当前版本
    migrations::migrate_to(&mut conn, &list, migrations::APP_SCHEMA_VERSION).unwrap();
    assert_eq!(
        migrations::schema_version(&conn).unwrap(),
        migrations::APP_SCHEMA_VERSION
    );

    let has_table: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'client_attachments'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(has_table, 1, "v14 必须建出 client_attachments");

    // 老数据还在，而且新表能正常写入
    let name: String = conn
        .query_row("SELECT display_name FROM clients WHERE id = 'legacy-client'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(name, "老客户");
    conn.execute(
        "INSERT INTO client_attachments
           (id, client_id, original_name, rel_path, thumb_rel_path, mime_type, byte_size,
            sha256, width, height, state, created_at)
         VALUES ('ref-1', 'legacy-client', 'a.png',
                 'attachments/originals/clients/legacy-client/ref-1.png', NULL, 'image/png',
                 10, 'x', 1, 1, 'ok', ?1)",
        [&now],
    )
    .expect("升级后的库必须能写参考图");
}

#[test]
fn 客户封面按客户返回且互不串图() {
    let ctx = Ctx::new();
    seed_client(&ctx, "client-a", "林三");
    seed_client(&ctx, "client-b", "王五");
    let dir = tempfile::tempdir().unwrap();
    let mut conn = ctx.conn();

    for (client, name) in [("client-a", "a1.png"), ("client-a", "a2.png"), ("client-b", "b1.png")] {
        client_attachments::import(
            &mut conn,
            ctx.env.layout(),
            ctx.env.active_generation(),
            client,
            &[write_image(dir.path(), name, 8, 8, ImageFormat::Png)],
        )
        .unwrap();
    }

    let covers = client_attachments::covers(
        &conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        &["client-a".to_string(), "client-b".to_string()],
    )
    .unwrap();

    assert_eq!(covers.len(), 2, "每个客户一张，不多不少");
    let a = covers.iter().find(|c| c.client_id == "client-a").expect("client-a 封面");
    let b = covers.iter().find(|c| c.client_id == "client-b").expect("client-b 封面");
    assert!(norm(&a.original_path).contains("/clients/client-a/"), "{}", a.original_path);
    assert!(norm(&b.original_path).contains("/clients/client-b/"), "{}", b.original_path);
    assert_ne!(a.attachment_id, b.attachment_id);
    assert!(a.thumb_path.is_some());
}

#[test]
fn 客户封面跳过丢了文件的图() {
    let ctx = Ctx::new();
    seed_client(&ctx, "client-a", "林三");
    let dir = tempfile::tempdir().unwrap();
    let mut conn = ctx.conn();
    let view = client_attachments::import(
        &mut conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        "client-a",
        &[write_image(dir.path(), "gone.png", 8, 8, ImageFormat::Png)],
    )
    .unwrap()[0]
        .attachment
        .clone()
        .unwrap();

    std::fs::remove_file(&view.original_path).unwrap();
    let covers = client_attachments::covers(
        &conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        &["client-a".to_string()],
    )
    .unwrap();
    assert!(covers.is_empty(), "文件不在时不能把坏路径交给界面");
}

#[test]
fn 客户参考图能完整备份并恢复() {
    let ctx = Ctx::new();
    seed_client(&ctx, "client-a", "林三");
    let dir = tempfile::tempdir().unwrap();
    let mut conn = ctx.conn();

    let made = client_attachments::import(
        &mut conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        "client-a",
        &[
            write_image(dir.path(), "ref1.png", 10, 10, ImageFormat::Png),
            write_image(dir.path(), "ref2.jpg", 12, 12, ImageFormat::Jpeg),
        ],
    )
    .unwrap();
    assert!(made.iter().all(|o| o.ok), "两张图都要导入成功");
    let before = client_attachments::list(&conn, ctx.env.layout(), ctx.env.active_generation(), "client-a").unwrap();
    assert_eq!(before.len(), 2);

    let zip = dir.path().join("with-client-refs.zip");
    let hw = common::highwater(&ctx.env);
    minidesk::backup::create::create(&ctx.env, &hw, &zip).expect("备份失败");

    let dst_root = dir.path().join("dst");
    let dst = common::open(&dst_root);
    let dst_hw = common::highwater(&dst);
    minidesk::backup::restore::restore(&dst, &dst_hw, &zip, &minidesk::store::migrations::production())
        .expect("恢复失败");
    drop(dst);

    let env2 = common::open(&dst_root);
    let gen2 = env2.active_generation();
    let conn2 = env2.open_db().unwrap();
    let after = client_attachments::list(&conn2, env2.layout(), &gen2, "client-a").unwrap();
    assert_eq!(after.len(), 2, "恢复后参考图数量不对");

    for row in &after {
        assert!(row.file_exists, "恢复后原图缺失: {}", row.original_path);
        let bytes = std::fs::read(&row.original_path).expect("读原图");
        assert_eq!(bytes.len() as i64, row.byte_size, "恢复后原图字节数变了");
        assert!(row.thumb_exists, "恢复后缩略图缺失: {}", row.original_name);
    }
}
