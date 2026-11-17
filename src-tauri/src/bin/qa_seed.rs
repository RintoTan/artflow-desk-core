//! QA 沙箱数据预置工具（开发/QA 专用，不随安装包分发）。
//!
//! 用法：
//! ```text
//! qa_seed --root /tmp/artflow-minidesk-qa          # 首次初始化
//! qa_seed --root /tmp/artflow-minidesk-qa --reset  # 显式清空后重建
//! ```
//!
//! 规则：
//! - 目标目录必须是绝对路径，且不能与正式数据目录互相包含。
//! - 目录里没有 `.qa-root` 标记时，`--reset` 一律拒绝（防止误删正式数据）。
//! - 没有 `--reset` 时，已有数据一律拒绝覆盖。
//! - 所有数据都经过正式领域函数写入（建单、开工、推进、完成、重开、取消、附件导入），
//!   不直接拼 SQL，因此不会造出违反约束的状态。

use std::path::{Path, PathBuf};

use chrono::Duration;

use minidesk::domain::attachments;
use minidesk::domain::clients;
use minidesk::domain::lifecycle::{self, LifecycleInput};
use minidesk::domain::orders::{self, ClientChoice, CreateOrderInput};
use minidesk::domain::templates::{self, CreateTemplateInput, StepInput};
use minidesk::error::{AppError, AppResult};
use minidesk::infra::state::AppState;
use minidesk::store::qa;
use minidesk::store::settings;
use minidesk::store::timezone;

fn main() {
    if let Err(e) = run() {
        eprintln!("[qa_seed] 失败 [{}] {}", e.code, e.message);
        std::process::exit(1);
    }
}

fn run() -> AppResult<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "用法：qa_seed --root <绝对路径> [--reset]\n\
             \n\
             --root    QA 数据根目录（必须绝对路径，不能与正式数据目录重叠）\n\
             --reset   清空并重建。仅在目录带 .qa-root 标记时允许。"
        );
        return Ok(());
    }

    let mut root: Option<PathBuf> = None;
    let mut reset = false;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--root" => {
                let value = iter
                    .next()
                    .ok_or_else(|| AppError::invalid("--root 需要一个路径"))?;
                root = Some(PathBuf::from(value));
            }
            "--reset" => reset = true,
            other => return Err(AppError::invalid(format!("未知参数：{other}"))),
        }
    }

    let root = root.ok_or_else(|| AppError::invalid("必须提供 --root <绝对路径>"))?;
    if !root.is_absolute() {
        return Err(AppError::invalid(format!(
            "--root 必须是绝对路径，收到 {}",
            root.display()
        )));
    }

    let production = production_root()?;
    guard_against_production(&root, &production)?;

    prepare_dir(&root, reset)?;

    // 与正式启动同一条引导路径：迁移、默认模板、高水位、代际指针都在这里建立。
    let state = AppState::open_mode(&root, true)?;
    let generation = state.env.active_generation().to_string();
    let layout = state.env.layout().clone();
    let mut conn = state.env.open_db()?;
    let tz = settings::working_timezone(&conn).unwrap_or_else(|_| timezone::system_timezone());

    println!("[qa_seed] root={}", root.display());
    println!("[qa_seed] generation={generation} tz={}", tz.name());

    let summary = seed(&mut conn, &state.highwater, tz, &layout, &generation)?;

    println!("[qa_seed] 完成。预置数据：");
    for line in &summary {
        println!("  {line}");
    }
    println!(
        "\n启动 QA 环境：\n  AF_MINIDESK_QA=1 AF_MINIDESK_QA_ROOT={} ./target/debug/artflow-minidesk",
        root.display()
    );
    Ok(())
}

/// 正式应用在 macOS 上的数据目录；用于阻止 QA 根与正式目录重叠。
fn production_root() -> AppResult<PathBuf> {
    let home = std::env::var_os("HOME")
        .ok_or_else(|| AppError::env("无法读取 HOME，不能判断正式数据目录"))?;
    Ok(PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("dev.artflow.minidesk"))
}

fn guard_against_production(root: &Path, production: &Path) -> AppResult<()> {
    let qa_path = qa::normalize(root);
    let prod = qa::normalize(production);
    if qa_path == prod || qa_path.starts_with(&prod) || prod.starts_with(&qa_path) {
        return Err(AppError::denied(format!(
            "QA 根目录不能与正式数据目录互相包含：qa={} production={}",
            qa_path.display(),
            prod.display()
        )));
    }
    Ok(())
}

fn prepare_dir(root: &Path, reset: bool) -> AppResult<()> {
    let has_marker = qa::has_marker(root);
    let has_data = root.join("environment.json").exists()
        || root.join("generations").exists()
        || root.join("state").exists();

    if has_data && !reset {
        return Err(AppError::conflict(format!(
            "{} 已经有 QA 数据。不会自动覆盖：需要重建请显式加 --reset。",
            root.display()
        )));
    }

    if reset {
        // 只有带 QA 标记的目录才允许清空；否则宁可失败也不删。
        qa::verify_marker(root)?;
        for name in [
            "generations",
            "state",
            "backups",
            "recovery",
            "environment.json",
        ] {
            let path = root.join(name);
            if path.is_dir() {
                std::fs::remove_dir_all(&path).map_err(|e| {
                    AppError::io(format!("清空 {} 失败：{e}", path.display()))
                })?;
            } else if path.exists() {
                std::fs::remove_file(&path).map_err(|e| {
                    AppError::io(format!("删除 {} 失败：{e}", path.display()))
                })?;
            }
        }
        println!("[qa_seed] 已按下 --reset 清空旧 QA 数据（标记保留）");
    } else if !has_marker {
        qa::write_marker(root)?;
        println!("[qa_seed] 已写入 QA 标记 {}", root.join(qa::QA_MARKER_FILE).display());
    }

    Ok(())
}

fn seed(
    conn: &mut rusqlite::Connection,
    hw: &minidesk::store::highwater::HighWater,
    tz: chrono_tz::Tz,
    layout: &minidesk::store::paths::Layout,
    generation: &str,
) -> AppResult<Vec<String>> {
    let today = timezone::local_today(tz);
    let date = |offset: i64| (today + Duration::days(offset)).format("%Y-%m-%d").to_string();

    // 两个同名客户：验证"同名不合并"（D-00-17）。
    let a = clients::create(
        conn,
        clients::CreateClientInput {
            display_name: "林小满".into(),
            contact: Some("lins@example.test".into()),
            note: Some("QA 客户 A".into()),
        },
    )?;
    let b = clients::create(
        conn,
        clients::CreateClientInput {
            display_name: "林小满".into(),
            contact: Some("other@example.test".into()),
            note: Some("QA 客户 B（与 A 同名，不同人）".into()),
        },
    )?;

    // 非默认模板：留作后续"按单选模板"对照用。
    let light = templates::create(
        conn,
        CreateTemplateInput {
            name: "轻量三阶段".into(),
            steps: vec![
                StepInput { step_id: None, title: "草稿".into() },
                StepInput { step_id: None, title: "线稿".into() },
                StepInput { step_id: None, title: "完稿".into() },
            ],
            make_default: false,
        },
    )?;

    let mut lines: Vec<String> = Vec::new();

    // 1. 双完成演示稿：完成 → 重开 → 再完成，共两条 completed 事件。
    let mut dual = create(
        conn,
        hw,
        tz,
        CreateOrderInput {
            title: "双完成演示稿".into(),
            client: ClientChoice::Existing { client_id: a.id.clone() },
            commission_type: Some("半身立绘".into()),
            amount_cents: Some(88_000),
            planned_start_date: Some(date(-10)),
            planned_delivery_date: Some(date(-2)),
            note: Some("QA：本单有两条完成事件，用于验证统计下钻".into()),
            ..Default::default()
        },
    )?;
    dual = lifecycle::start_work(conn, LifecycleInput {
        order_id: dual.id.clone(),
        expected_revision: dual.revision,
        request_id: None,
    })?;
    for _ in 0..4 {
        dual = lifecycle::advance_stage(conn, LifecycleInput {
            order_id: dual.id.clone(),
            expected_revision: dual.revision,
            request_id: None,
        })?;
    }
    dual = lifecycle::complete_order(conn, LifecycleInput {
        order_id: dual.id.clone(),
        expected_revision: dual.revision,
        request_id: None,
    })?;
    dual = lifecycle::reopen_order(conn, LifecycleInput {
        order_id: dual.id.clone(),
        expected_revision: dual.revision,
        request_id: None,
    })?;
    dual = lifecycle::complete_order(conn, LifecycleInput {
        order_id: dual.id.clone(),
        expected_revision: dual.revision,
        request_id: None,
    })?;
    lines.push(format!(
        "{}「{}」完工两次（2 条 completed 事件）",
        dual.code, dual.title
    ));

    // 2. 制作中：今天交付。
    let mut in_progress = create(
        conn,
        hw,
        tz,
        CreateOrderInput {
            title: "制作中的加急稿".into(),
            client: ClientChoice::Existing { client_id: b.id.clone() },
            commission_type: Some("头像".into()),
            amount_cents: Some(150_000),
            planned_start_date: Some(date(-5)),
            planned_delivery_date: Some(date(0)),
            ..Default::default()
        },
    )?;
    in_progress = lifecycle::start_work(conn, LifecycleInput {
        order_id: in_progress.id.clone(),
        expected_revision: in_progress.revision,
        request_id: None,
    })?;
    for _ in 0..2 {
        in_progress = lifecycle::advance_stage(conn, LifecycleInput {
            order_id: in_progress.id.clone(),
            expected_revision: in_progress.revision,
            request_id: None,
        })?;
    }
    lines.push(format!(
        "{}「{}」制作中，今天交付（{}）",
        in_progress.code,
        in_progress.title,
        in_progress.current_stage_title.clone().unwrap_or_default()
    ));

    // 3. 已逾期，仍排队。
    let overdue = create(
        conn,
        hw,
        tz,
        CreateOrderInput {
            title: "已逾期的线稿".into(),
            client: ClientChoice::None,
            commission_type: Some("场景".into()),
            amount_cents: Some(30_000),
            planned_start_date: Some(date(-12)),
            planned_delivery_date: Some(date(-3)),
            ..Default::default()
        },
    )?;
    lines.push(format!(
        "{}「{}」已逾期 3 天，仍排队",
        overdue.code, overdue.title
    ));

    // 4. 未排期 + 金额未知。
    let unscheduled = create(
        conn,
        hw,
        tz,
        CreateOrderInput {
            title: "未排期的草稿".into(),
            client: ClientChoice::None,
            amount_cents: None,
            ..Default::default()
        },
    )?;
    lines.push(format!(
        "{}「{}」无交付日、金额未知（NULL）",
        unscheduled.code, unscheduled.title
    ));

    // 5. 0 元订单，且已完成。
    let mut zero = create(
        conn,
        hw,
        tz,
        CreateOrderInput {
            title: "零元友情稿".into(),
            client: ClientChoice::None,
            amount_cents: Some(0),
            planned_delivery_date: Some(date(-1)),
            ..Default::default()
        },
    )?;
    zero = lifecycle::start_work(conn, LifecycleInput {
        order_id: zero.id.clone(),
        expected_revision: zero.revision,
        request_id: None,
    })?;
    for _ in 0..4 {
        zero = lifecycle::advance_stage(conn, LifecycleInput {
            order_id: zero.id.clone(),
            expected_revision: zero.revision,
            request_id: None,
        })?;
    }
    zero = lifecycle::complete_order(conn, LifecycleInput {
        order_id: zero.id.clone(),
        expected_revision: zero.revision,
        request_id: None,
    })?;
    lines.push(format!(
        "{}「{}」已完成，金额 0 元（已知金额，不是未知）",
        zero.code, zero.title
    ));

    // 6. 已取消。
    let cancelled = create(
        conn,
        hw,
        tz,
        CreateOrderInput {
            title: "已取消的企划".into(),
            client: ClientChoice::None,
            amount_cents: Some(5_000),
            ..Default::default()
        },
    )?;
    let cancelled = lifecycle::cancel_order(conn, LifecycleInput {
        order_id: cancelled.id.clone(),
        expected_revision: cancelled.revision,
        request_id: None,
    })?;
    lines.push(format!("{}「{}」已取消", cancelled.code, cancelled.title));

    // 7. CSV 注入标题 + 三张附件（PNG / JPEG / WebP）。
    let inject = create(
        conn,
        hw,
        tz,
        CreateOrderInput {
            title: "=1+1 公式注入标题".into(),
            client: ClientChoice::None,
            amount_cents: Some(12_345),
            ..Default::default()
        },
    )?;
    let images = write_fixture_images(conn, layout, generation, &inject.id)?;
    lines.push(format!(
        "{}「{}」用于 CSV 防注入；附件 {} 张",
        inject.code, inject.title, images
    ));

    lines.push(format!(
        "模板：默认「通用制作流程」5 阶段 + 「{}」3 阶段",
        light.name
    ));
    Ok(lines)
}

fn create(
    conn: &mut rusqlite::Connection,
    hw: &minidesk::store::highwater::HighWater,
    tz: chrono_tz::Tz,
    input: CreateOrderInput,
) -> AppResult<orders::OrderView> {
    orders::create_order(conn, hw, tz, input)
}

/// 用 image 库现场生成三张测试图，再走正式导入通道写进代际附件目录。
/// 图片是纯色块 + 渐变，不含任何真实作品内容。
fn write_fixture_images(
    conn: &mut rusqlite::Connection,
    layout: &minidesk::store::paths::Layout,
    generation: &str,
    order_id: &str,
) -> AppResult<usize> {
    let dir = std::env::temp_dir().join(format!("qa-seed-{}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    let mut sources: Vec<PathBuf> = Vec::new();

    let png = dir.join("qa-blue.png");
    let img = image::RgbImage::from_fn(320, 240, |x, y| {
        image::Rgb([(x % 256) as u8, (y % 256) as u8, 200])
    });
    img.save(&png)
        .map_err(|e| AppError::io(format!("生成 PNG 失败：{e}")))?;
    sources.push(png);

    let jpg = dir.join("qa-warm.jpg");
    let img = image::RgbImage::from_fn(300, 200, |x, _y| {
        image::Rgb([240, (x % 200) as u8, 120])
    });
    img.save(&jpg)
        .map_err(|e| AppError::io(format!("生成 JPEG 失败：{e}")))?;
    sources.push(jpg);

    let webp = dir.join("qa-green.webp");
    let img = image::RgbImage::from_fn(280, 280, |x, y| {
        image::Rgb([80, (x % 200) as u8, (y % 200) as u8])
    });
    // WebP 编码依赖 image 的 webp 特性；失败时只跳过这一张，不影响其它附件。
    if img.save(&webp).is_ok() {
        sources.push(webp);
    }

    let outcomes = attachments::import(conn, layout, generation, order_id, &sources, Some("QA"))?;
    let ok = outcomes.iter().filter(|o| o.ok).count();
    for o in &outcomes {
        if !o.ok {
            eprintln!(
                "[qa_seed] 附件 {} 导入失败：{}",
                o.source_name,
                o.error.clone().unwrap_or_default()
            );
        }
    }
    for s in &sources {
        let _ = std::fs::remove_file(s);
    }
    let _ = std::fs::remove_dir_all(&dir);
    Ok(ok)
}
