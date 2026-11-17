//! QA 预置数据集（seeded 场景）。
//!
//! 三条原则：
//!
//! 1. **只走领域函数**：建单、开工、推进、完成、重开、取消、附件导入全部调用
//!    `domain::*`，不手写业务 INSERT。唯一例外是 `fixture` 模块里的时间戳，
//!    它只改 `occurred_at` / `created_at`，不改任何状态。
//! 2. **可检查**：种子完成后把数据集版本写进 `app_settings`，并用真实计数做校验；
//!    不是"文件存在就算成功"。
//! 3. **失败不装完整**：中途出错时清掉自己刚生成的代际与状态，只留 QA 标记，
//!    下次必须显式 `--rebuild` 才能重来。
//!
//! 时间口径：
//! - **相对当前**：到期类（今天 / 三日内 / 逾期）按工作时区的今天计算日历日期；
//! - **固定历史**：跨月订单的创建与完成时刻写死（2026-09 / 2026-10），
//!   用来验证"金额按创建月份归属"与"跨月事件归属"。

use std::path::Path;

use chrono::{Duration, NaiveDate};

use crate::domain::attachments;
use crate::domain::clients;
use crate::domain::fixture;
use crate::domain::lifecycle::{self, LifecycleInput};
use crate::domain::orders::{self, ClientChoice, CreateOrderInput};
use crate::domain::templates::{self, CreateTemplateInput, StepInput};
use crate::error::{AppError, AppResult};
use crate::infra::state::AppState;
use crate::store::{qa, settings, timezone};

pub const DATASET_VERSION: &str = "qa01-v1";
const DATASET_KEY: &str = "qa.seed.version";
const SEED_TIMEZONE: &str = "Asia/Shanghai";

#[derive(Debug, Clone)]
pub struct SeedOptions {
    /// 显式重建：先校验 QA 标记再清空。
    pub rebuild: bool,
    /// 测试用故障注入：第 N 个订单之后强制失败，验证"失败不留半成品"。
    pub fail_after: Option<usize>,
}

impl Default for SeedOptions {
    fn default() -> Self {
        Self {
            rebuild: false,
            fail_after: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SeedReport {
    pub root: String,
    pub version: String,
    pub already_seeded: bool,
    pub orders: i64,
    pub clients: i64,
    pub templates: i64,
    pub attachments: i64,
    pub events: i64,
    pub completed_events: i64,
    pub summary: Vec<String>,
}

/// 预置 seeded 场景。已存在同版本数据集时直接返回 `already_seeded`，不重复插入。
pub fn seed_seeded(root: &Path, options: &SeedOptions) -> AppResult<SeedReport> {
    qa::write_marker(root)?;
    qa::verify_marker(root)?;

    if has_environment(root) {
        if !options.rebuild {
            if let Some(report) = existing_report(root)? {
                return Ok(report);
            }
            return Err(AppError::conflict(format!(
                "{} 已有 QA 数据，但不是本版本预置的（缺少数据集标记）。\
                 需要重建请显式加 --rebuild。",
                root.display()
            )));
        }
        wipe_generated(root)?;
    }

    let result = seed_inner(root, options);
    if result.is_err() {
        // 失败不留"看起来完整"的数据：只保留 QA 标记。
        let _ = wipe_generated(root);
    }
    result
}

/// 准备干净场景：只建目录与标记，**不建数据库**，让应用真正走首次启动。
pub fn prepare_clean(root: &Path, rebuild: bool) -> AppResult<SeedReport> {
    if has_environment(root) {
        if !rebuild {
            return Err(AppError::conflict(format!(
                "{} 已有数据。clean 场景只用于从零流程，需要清空请显式加 --rebuild。",
                root.display()
            )));
        }
        qa::verify_marker(root)?;
        wipe_generated(root)?;
    }
    qa::write_marker(root)?;
    Ok(SeedReport {
        root: root.display().to_string(),
        version: "empty".into(),
        already_seeded: false,
        orders: 0,
        clients: 0,
        templates: 0,
        attachments: 0,
        events: 0,
        completed_events: 0,
        summary: vec!["Clean 场景：空数据根，首次启动会自动初始化".into()],
    })
}

fn has_environment(root: &Path) -> bool {
    root.join("environment.json").exists() || root.join("generations").exists()
}

/// 清掉"我们自己生成"的东西，保留 QA 标记。调用前必须已通过标记校验。
fn wipe_generated(root: &Path) -> AppResult<()> {
    for name in ["generations", "state", "backups", "recovery", "environment.json"] {
        let path = root.join(name);
        if path.is_dir() {
            std::fs::remove_dir_all(&path)
                .map_err(|e| AppError::io(format!("清空 {} 失败：{e}", path.display())))?;
        } else if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|e| AppError::io(format!("删除 {} 失败：{e}", path.display())))?;
        }
    }
    Ok(())
}

/// 读已有数据的版本与计数；版本不匹配时返回 None。
fn existing_report(root: &Path) -> AppResult<Option<SeedReport>> {
    let state = AppState::open_qa(root, Some(qa::Scenario::Seeded))?;
    let conn = state.env.open_db()?;
    let version = settings::get(&conn, DATASET_KEY)?;
    if version.as_deref() != Some(DATASET_VERSION) {
        return Ok(None);
    }
    let report = report_from_conn(root, &conn, true)?;
    Ok(Some(report))
}

fn report_from_conn(root: &Path, conn: &rusqlite::Connection, already: bool) -> AppResult<SeedReport> {
    let count = |sql: &str| -> AppResult<i64> { Ok(conn.query_row(sql, [], |r| r.get(0))?) };
    Ok(SeedReport {
        root: root.display().to_string(),
        version: DATASET_VERSION.to_string(),
        already_seeded: already,
        orders: count("SELECT COUNT(*) FROM orders")?,
        clients: count("SELECT COUNT(*) FROM clients")?,
        templates: count("SELECT COUNT(*) FROM stage_templates")?,
        attachments: count("SELECT COUNT(*) FROM attachments")?,
        events: count("SELECT COUNT(*) FROM order_events")?,
        completed_events: count("SELECT COUNT(*) FROM order_events WHERE kind = 'completed'")?,
        summary: Vec::new(),
    })
}

fn seed_inner(root: &Path, options: &SeedOptions) -> AppResult<SeedReport> {
    let state = AppState::open_qa(root, Some(qa::Scenario::Seeded))?;
    let layout = state.env.layout().clone();
    let generation = state.env.active_generation().to_string();
    let mut conn = state.env.open_db()?;

    // 固定时区：QA 数据里的"今天"必须是可预期的，不跟系统时区漂移。
    let tz = timezone::parse(SEED_TIMEZONE)?;
    settings::set_working_timezone(&conn, SEED_TIMEZONE, &timezone::now_timestamp())?;

    let today = timezone::local_today(tz);
    let date = |offset: i64| (today + Duration::days(offset)).format("%Y-%m-%d").to_string();
    let mut summary: Vec<String> = Vec::new();
    let mut created = 0usize;
    let mut tick = |label: String| -> AppResult<()> {
        created += 1;
        if let Some(limit) = options.fail_after {
            if created > limit {
                return Err(AppError::db("预置故障注入：强制中断"));
            }
        }
        summary.push(label);
        Ok(())
    };

    // ---------------- 客户
    let lin_a = clients::create(
        &conn,
        clients::CreateClientInput {
            display_name: "林小满".into(),
            contact: Some("lin.a@example.test".into()),
            note: Some("QA 客户 A".into()),
        },
    )?;
    let lin_b = clients::create(
        &conn,
        clients::CreateClientInput {
            display_name: "林小满".into(),
            contact: Some("lin.b@example.test".into()),
            note: Some("QA 客户 B：与 A 同名，不同人".into()),
        },
    )?;
    let chen = clients::create(
        &conn,
        clients::CreateClientInput {
            display_name: "陈叙".into(),
            contact: None,
            note: None,
        },
    )?;

    // ---------------- 模板（默认模板由迁移种下，这里只补两套非默认）
    let light = templates::create(
        &mut conn,
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
    let rush = templates::create(
        &mut conn,
        CreateTemplateInput {
            name: "六阶段加急".into(),
            steps: vec![
                StepInput { step_id: None, title: "草图".into() },
                StepInput { step_id: None, title: "线稿".into() },
                StepInput { step_id: None, title: "铺色".into() },
                StepInput { step_id: None, title: "细化".into() },
                StepInput { step_id: None, title: "特效".into() },
                StepInput { step_id: None, title: "终稿".into() },
            ],
            make_default: false,
        },
    )?;

    // ---------------- 1) 双完成 + 跨月 + 重开
    let mut dual = orders::create_order(
        &mut conn,
        &state.highwater,
        tz,
        CreateOrderInput {
            title: "双完成演示稿".into(),
            client: ClientChoice::Existing { client_id: lin_a.id.clone() },
            commission_type: Some("半身立绘".into()),
            amount_cents: Some(88_000),
            planned_start_date: Some(date(-40)),
            planned_delivery_date: Some(date(-2)),
            note: Some("QA：完成两次 + 重开，两条 completed 事件".into()),
            ..Default::default()
        },
    )?;
    dual = lifecycle::start_work(&mut conn, LifecycleInput {
        order_id: dual.id.clone(), expected_revision: dual.revision, request_id: None,
    })?;
    for _ in 0..4 {
        dual = lifecycle::advance_stage(&mut conn, LifecycleInput {
            order_id: dual.id.clone(), expected_revision: dual.revision, request_id: None,
        })?;
    }
    dual = lifecycle::complete_order(&mut conn, LifecycleInput {
        order_id: dual.id.clone(), expected_revision: dual.revision, request_id: None,
    })?;
    dual = lifecycle::reopen_order(&mut conn, LifecycleInput {
        order_id: dual.id.clone(), expected_revision: dual.revision, request_id: None,
    })?;
    dual = lifecycle::complete_order(&mut conn, LifecycleInput {
        order_id: dual.id.clone(), expected_revision: dual.revision, request_id: None,
    })?;
    // 固定历史：9 月创建，10 月第一次完成，第二次完成保持"现在"。
    fixture::shift_order_created_at(&conn, &dual.id, "2026-09-12T03:00:00.000Z")?;
    let completions: Vec<i64> = {
        let mut stmt = conn.prepare(
            "SELECT id FROM order_events WHERE order_id = ?1 AND kind = 'completed' ORDER BY id",
        )?;
        let rows = stmt.query_map([&dual.id], |r| r.get::<_, i64>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    if let Some(first) = completions.first() {
        fixture::set_event_timestamp(&conn, *first, "2026-10-08T06:30:00.000Z")?;
    }
    tick(format!("{}「{}」完成两次（其中一次在 10 月）", dual.code, dual.title))?;

    // ---------------- 2) 跨月完成（9 月创建，10 月完成）
    let mut cross = orders::create_order(
        &mut conn,
        &state.highwater,
        tz,
        CreateOrderInput {
            title: "跨月完成稿".into(),
            client: ClientChoice::Existing { client_id: chen.id.clone() },
            commission_type: Some("头像".into()),
            amount_cents: Some(120_000),
            ..Default::default()
        },
    )?;
    cross = lifecycle::start_work(&mut conn, LifecycleInput {
        order_id: cross.id.clone(), expected_revision: cross.revision, request_id: None,
    })?;
    for _ in 0..4 {
        cross = lifecycle::advance_stage(&mut conn, LifecycleInput {
            order_id: cross.id.clone(), expected_revision: cross.revision, request_id: None,
        })?;
    }
    cross = lifecycle::complete_order(&mut conn, LifecycleInput {
        order_id: cross.id.clone(), expected_revision: cross.revision, request_id: None,
    })?;
    fixture::shift_order_created_at(&conn, &cross.id, "2026-09-20T02:00:00.000Z")?;
    let cross_completion: i64 = conn.query_row(
        "SELECT MAX(id) FROM order_events WHERE order_id = ?1 AND kind = 'completed'",
        [&cross.id],
        |r| r.get(0),
    )?;
    fixture::set_event_timestamp(&conn, cross_completion, "2026-10-05T09:15:00.000Z")?;
    tick(format!("{}「{}」9 月创建、10 月完成", cross.code, cross.title))?;

    // ---------------- 3) 制作中，今天到期
    let mut today_order = orders::create_order(
        &mut conn,
        &state.highwater,
        tz,
        CreateOrderInput {
            title: "制作中的加急稿".into(),
            client: ClientChoice::Existing { client_id: lin_b.id.clone() },
            commission_type: Some("全身".into()),
            amount_cents: Some(150_000),
            planned_start_date: Some(date(-5)),
            planned_delivery_date: Some(date(0)),
            ..Default::default()
        },
    )?;
    today_order = lifecycle::start_work(&mut conn, LifecycleInput {
        order_id: today_order.id.clone(), expected_revision: today_order.revision, request_id: None,
    })?;
    for _ in 0..2 {
        today_order = lifecycle::advance_stage(&mut conn, LifecycleInput {
            order_id: today_order.id.clone(), expected_revision: today_order.revision, request_id: None,
        })?;
    }
    let today_id = today_order.id.clone();
    tick(format!("{}「{}」制作中，今天到期", today_order.code, today_order.title))?;

    // ---------------- 4) 三日内到期
    let soon = orders::create_order(
        &mut conn,
        &state.highwater,
        tz,
        CreateOrderInput {
            title: "三天内交付的封面".into(),
            client: ClientChoice::Existing { client_id: chen.id.clone() },
            amount_cents: Some(45_000),
            planned_delivery_date: Some(date(2)),
            ..Default::default()
        },
    )?;
    tick(format!("{}「{}」还有 2 天到期", soon.code, soon.title))?;

    // ---------------- 5) 已逾期
    let overdue = orders::create_order(
        &mut conn,
        &state.highwater,
        tz,
        CreateOrderInput {
            title: "已逾期的线稿".into(),
            client: ClientChoice::None,
            amount_cents: Some(30_000),
            planned_start_date: Some(date(-12)),
            planned_delivery_date: Some(date(-3)),
            ..Default::default()
        },
    )?;
    tick(format!("{}「{}」逾期 3 天", overdue.code, overdue.title))?;

    // ---------------- 6) 未排期 + 金额未知
    let unscheduled = orders::create_order(
        &mut conn,
        &state.highwater,
        tz,
        CreateOrderInput {
            title: "未排期的草稿".into(),
            client: ClientChoice::None,
            amount_cents: None,
            ..Default::default()
        },
    )?;
    tick(format!("{}「{}」未排期 + 金额 NULL", unscheduled.code, unscheduled.title))?;

    // ---------------- 7) 0 元已完成
    let mut zero = orders::create_order(
        &mut conn,
        &state.highwater,
        tz,
        CreateOrderInput {
            title: "零元友情稿".into(),
            client: ClientChoice::None,
            amount_cents: Some(0),
            planned_delivery_date: Some(date(-1)),
            ..Default::default()
        },
    )?;
    zero = lifecycle::start_work(&mut conn, LifecycleInput {
        order_id: zero.id.clone(), expected_revision: zero.revision, request_id: None,
    })?;
    for _ in 0..4 {
        zero = lifecycle::advance_stage(&mut conn, LifecycleInput {
            order_id: zero.id.clone(), expected_revision: zero.revision, request_id: None,
        })?;
    }
    zero = lifecycle::complete_order(&mut conn, LifecycleInput {
        order_id: zero.id.clone(), expected_revision: zero.revision, request_id: None,
    })?;
    tick(format!("{}「{}」完成，金额 0", zero.code, zero.title))?;

    // ---------------- 8) 已取消
    let cancelled = orders::create_order(
        &mut conn,
        &state.highwater,
        tz,
        CreateOrderInput {
            title: "已取消的企划".into(),
            client: ClientChoice::None,
            amount_cents: Some(5_000),
            ..Default::default()
        },
    )?;
    let cancelled = lifecycle::cancel_order(&mut conn, LifecycleInput {
        order_id: cancelled.id.clone(), expected_revision: cancelled.revision, request_id: None,
    })?;
    tick(format!("{}「{}」已取消", cancelled.code, cancelled.title))?;

    // ---------------- 9) CSV 公式注入标题（4 条）
    for title in ["=1+1", "+1+1", "-2+3", "@SUM(1,2)"] {
        let injected = orders::create_order(
            &mut conn,
            &state.highwater,
            tz,
            CreateOrderInput {
                title: format!("{title} 注入样本"),
                client: ClientChoice::None,
                amount_cents: Some(100),
                ..Default::default()
            },
        )?;
        tick(format!("{}「{}」CSV 注入样本", injected.code, injected.title))?;
    }

    // ---------------- 附件：一张订单多张参考图 + 不同长宽比
    let images = write_fixture_images(&mut conn, &layout, &generation, &today_id, true)?;
    tick(format!("「制作中的加急稿」挂 {} 张参考图（PNG/JPEG/WebP）", images))?;

    // ---------------- 数据集标记与校验
    settings::set(&conn, DATASET_KEY, DATASET_VERSION, &timezone::now_timestamp())?;
    let report = report_from_conn(root, &conn, false)?;
    if report.orders < 12 || report.completed_events < 3 {
        return Err(AppError::db(format!(
            "预置校验失败：订单 {} / 完成事件 {}，低于预期",
            report.orders, report.completed_events
        )));
    }

    let mut report = report;
    report.summary = summary;
    report.summary.push(format!(
        "模板：默认「通用制作流程」5 阶段 /「{}」3 阶段 /「{}」6 阶段",
        light.name, rush.name
    ));
    Ok(report)
}

fn write_fixture_images(
    conn: &mut rusqlite::Connection,
    layout: &crate::store::paths::Layout,
    generation: &str,
    order_id: &str,
    prepare_small: bool,
) -> AppResult<usize> {
    let dir = std::env::temp_dir().join(format!("qa-seed-{}-{}", std::process::id(), order_id));
    std::fs::create_dir_all(&dir)?;
    let mut sources: Vec<std::path::PathBuf> = Vec::new();

    let png = dir.join("qa-blue.png");
    image::RgbImage::from_fn(320, 240, |x, y| image::Rgb([(x % 256) as u8, (y % 256) as u8, 200]))
        .save(&png)
        .map_err(|e| AppError::io(format!("生成 PNG 失败：{e}")))?;
    sources.push(png);

    let jpg = dir.join("qa-warm.jpg");
    image::RgbImage::from_fn(300, 420, |x, _y| image::Rgb([240, (x % 200) as u8, 120]))
        .save(&jpg)
        .map_err(|e| AppError::io(format!("生成 JPEG 失败：{e}")))?;
    sources.push(jpg);

    let webp = dir.join("qa-wide.webp");
    let encoded = image::RgbImage::from_fn(500, 200, |x, y| image::Rgb([80, (x % 200) as u8, (y % 200) as u8]))
        .save(&webp)
        .is_ok();
    if encoded {
        sources.push(webp);
    }

    if prepare_small {
        let small = dir.join("qa-small.png");
        image::RgbImage::from_fn(64, 64, |x, y| image::Rgb([(x * 4) as u8, (y * 4) as u8, 90]))
            .save(&small)
            .map_err(|e| AppError::io(format!("生成小图失败：{e}")))?;
        sources.push(small);
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

/// 供测试断言：给定日期偏移下的"今天"。QA 数据集里的相对日期都基于它。
pub fn today_for_seed() -> AppResult<NaiveDate> {
    Ok(timezone::local_today(timezone::parse(SEED_TIMEZONE)?))
}
