//! QA-FIXTURE-01：DEV-06D-2 时间线验收专用场景。
//!
//! 四个场景各自一份数据根（`<qa>/timeline-*`），互不共享、互不覆盖 `seeded`。
//!
//! | 场景 | 目录 | 订单 | 用途 |
//! |---|---|---|---|
//! | A `timeline-unscheduled` | `<qa>/timeline-unscheduled` | 5 活动 | 完全未排期 vs 待定交付日 |
//! | B `timeline-empty` | `<qa>/timeline-empty` | 0 | 空数据状态 |
//! | C `timeline-no-dates` | `<qa>/timeline-no-dates` | 2 活动（两空） | 普通未排期空状态 |
//! | D `timeline-terminal` | `<qa>/timeline-terminal` | 1 完成 + 1 取消（两空） | 终态空状态 / FIX-01 |
//!
//! 所有订单标题带 `QA-A/B/C/D` 前缀，便于肉眼识别与清理；全部走 `domain::*`
//! 领域函数创建，不手写业务 INSERT。日期一律相对"工作时区的今天"，
//! 所以每次生成都得到同一组日期偏移，可重复。

use std::path::Path;

use chrono::Duration;

use crate::domain::lifecycle::{self, LifecycleInput};
use crate::domain::orders::{self, ClientChoice, CreateOrderInput};
use crate::error::{AppError, AppResult};
use crate::infra::state::AppState;
use crate::store::{qa, settings, timezone};

use super::{SeedOptions, SeedReport};

const DATASET_KEY: &str = "qa.seed.version";
const SEED_TIMEZONE: &str = "Asia/Shanghai";

pub const VERSION_A: &str = "qa-timeline-unscheduled-v1";
pub const VERSION_B: &str = "qa-timeline-empty-v1";
pub const VERSION_C: &str = "qa-timeline-no-dates-v1";
pub const VERSION_D: &str = "qa-timeline-terminal-v1";

fn version_of(scenario: qa::Scenario) -> &'static str {
    match scenario {
        qa::Scenario::TimelineUnscheduled => VERSION_A,
        qa::Scenario::TimelineEmpty => VERSION_B,
        qa::Scenario::TimelineNoDates => VERSION_C,
        qa::Scenario::TimelineTerminal => VERSION_D,
        _ => "unsupported",
    }
}

/// 时间线验收场景的入口。已存在同版本数据时直接返回报告，不重复插单。
pub fn seed(scenario: qa::Scenario, root: &Path, options: &SeedOptions) -> AppResult<SeedReport> {
    if !scenario.is_timeline_fixture() {
        return Err(AppError::invalid(format!(
            "{} 不是时间线验收场景",
            scenario.as_str()
        )));
    }
    let version = version_of(scenario);
    qa::write_marker(root)?;
    qa::verify_marker(root)?;

    if super::has_environment(root) {
        if !options.rebuild {
            if let Some(report) = existing(root, version)? {
                return Ok(report);
            }
            return Err(AppError::conflict(format!(
                "{} 已有数据，但不是 {} 预置的（缺少或不同版本的数据集标记）。\
                 需要重建请显式加 --rebuild。",
                root.display(),
                version
            )));
        }
        super::wipe_generated(root)?;
    }

    let result = seed_inner(scenario, root, version, options);
    if result.is_err() {
        // 与 seeded 一致：失败不留"看起来完整"的半成品。
        let _ = super::wipe_generated(root);
    }
    result
}

fn existing(root: &Path, version: &str) -> AppResult<Option<SeedReport>> {
    let state = AppState::open_qa(root, None)?;
    let conn = state.env.open_db()?;
    if settings::get(&conn, DATASET_KEY)?.as_deref() != Some(version) {
        return Ok(None);
    }
    let mut report = super::report_from_conn(root, &conn, true)?;
    report.version = version.to_string();
    Ok(Some(report))
}

fn seed_inner(
    scenario: qa::Scenario,
    root: &Path,
    version: &str,
    options: &SeedOptions,
) -> AppResult<SeedReport> {
    let state = AppState::open_qa(root, None)?;
    let mut conn = state.env.open_db()?;

    let tz = timezone::parse(SEED_TIMEZONE)?;
    settings::set_working_timezone(&conn, SEED_TIMEZONE, &timezone::now_timestamp())?;
    let today = timezone::local_today(tz);
    let date = |offset: i64| (today + Duration::days(offset)).format("%Y-%m-%d").to_string();

    // 头部说明先写进独立列表：tick 闭包会借用 summary，之后再 push 会冲突。
    let mut header: Vec<String> = Vec::new();
    let mut collected: Vec<String> = Vec::new();
    let mut created = 0usize;
    let mut tick = |label: String| -> AppResult<()> {
        created += 1;
        if let Some(limit) = options.fail_after {
            if created > limit {
                return Err(AppError::db("预置故障注入：强制中断"));
            }
        }
        collected.push(label);
        Ok(())
    };

    match scenario {
        qa::Scenario::TimelineUnscheduled => {
            header.push(format!("场景 A · 参考今天 {today}（{SEED_TIMEZONE}）"));

            // 1) 两条两个日期都为空的订单（进入「完全未排期」，不进入后端"待定交付日"以外的分区）
            for index in 1..=2 {
                let order = orders::create_order(
                    &mut conn,
                    &state.highwater,
                    tz,
                    CreateOrderInput {
                        title: format!("QA-A 完全未排期 {index}"),
                        client: ClientChoice::None,
                        commission_type: Some("草稿".into()),
                        amount_cents: Some(20_000 * index),
                        planned_start_date: None,
                        planned_delivery_date: None,
                        note: Some("QA-FIXTURE-01 场景 A：两个日期都为空".into()),
                        ..Default::default()
                    },
                )?;
                tick(format!(
                    "{}「{}」start=NULL delivery=NULL → 完全未排期",
                    order.code, order.title
                ))?;
            }

            // 2) 只有开始日期：时间线要画空心点，且**不**进完全未排期区
            let only_start = orders::create_order(
                &mut conn,
                &state.highwater,
                tz,
                CreateOrderInput {
                    title: "QA-A 仅有开始日期".into(),
                    client: ClientChoice::None,
                    commission_type: Some("线稿".into()),
                    amount_cents: Some(66_000),
                    planned_start_date: Some(date(1)),
                    planned_delivery_date: None,
                    note: Some("QA-FIXTURE-01 场景 A：待定交付日".into()),
                    ..Default::default()
                },
            )?;
            tick(format!(
                "{}「{}」start={} delivery=NULL → 仍在轨道 + 后端计入待定交付日",
                only_start.code,
                only_start.title,
                date(1)
            ))?;

            // 3) 只有交付日期：菱形标记
            let only_delivery = orders::create_order(
                &mut conn,
                &state.highwater,
                tz,
                CreateOrderInput {
                    title: "QA-A 仅有交付日期".into(),
                    client: ClientChoice::None,
                    commission_type: Some("头像".into()),
                    amount_cents: Some(48_000),
                    planned_start_date: None,
                    planned_delivery_date: Some(date(6)),
                    note: Some("QA-FIXTURE-01 场景 A：只有交付日期".into()),
                    ..Default::default()
                },
            )?;
            tick(format!(
                "{}「{}」start=NULL delivery={} → 菱形标记",
                only_delivery.code,
                only_delivery.title,
                date(6)
            ))?;

            // 4) 正常双日期
            let both = orders::create_order(
                &mut conn,
                &state.highwater,
                tz,
                CreateOrderInput {
                    title: "QA-A 正常双日期".into(),
                    client: ClientChoice::None,
                    commission_type: Some("半身立绘".into()),
                    amount_cents: Some(120_000),
                    planned_start_date: Some(date(-3)),
                    planned_delivery_date: Some(date(4)),
                    note: Some("QA-FIXTURE-01 场景 A：正常区间".into()),
                    ..Default::default()
                },
            )?;
            tick(format!(
                "{}「{}」start={} delivery={} → 区间条",
                both.code,
                both.title,
                date(-3),
                date(4)
            ))?;
        }

        qa::Scenario::TimelineEmpty => {
            header.push(format!("场景 B · 参考今天 {today}；已初始化环境，0 订单"));
            header.push("不插入任何订单：时间线应显示「尚无订单」".into());
        }

        qa::Scenario::TimelineNoDates => {
            header.push(format!("场景 C · 参考今天 {today}（{SEED_TIMEZONE}）"));
            for index in 1..=2 {
                let order = orders::create_order(
                    &mut conn,
                    &state.highwater,
                    tz,
                    CreateOrderInput {
                        title: format!("QA-C 全无计划日期 {index}"),
                        client: ClientChoice::None,
                        amount_cents: Some(30_000 * index),
                        planned_start_date: None,
                        planned_delivery_date: None,
                        note: Some("QA-FIXTURE-01 场景 C：活动订单全部没有计划日期".into()),
                        ..Default::default()
                    },
                )?;
                tick(format!(
                    "{}「{}」status=active start=NULL delivery=NULL",
                    order.code, order.title
                ))?;
            }
        }

        qa::Scenario::TimelineTerminal => {
            header.push(format!("场景 D · 参考今天 {today}（{SEED_TIMEZONE}）"));

            // complete：走真实生命周期（开工 → 推进到底 → 完成），日期全空
            let mut done = orders::create_order(
                &mut conn,
                &state.highwater,
                tz,
                CreateOrderInput {
                    title: "QA-D 已完成且无计划日期".into(),
                    client: ClientChoice::None,
                    amount_cents: Some(88_000),
                    planned_start_date: None,
                    planned_delivery_date: None,
                    note: Some("QA-FIXTURE-01 场景 D：终态 + 两空".into()),
                    ..Default::default()
                },
            )?;
            done = lifecycle::start_work(
                &mut conn,
                LifecycleInput {
                    order_id: done.id.clone(),
                    expected_revision: done.revision,
                    request_id: None,
                },
            )?;
            for _ in 0..4 {
                done = lifecycle::advance_stage(
                    &mut conn,
                    LifecycleInput {
                        order_id: done.id.clone(),
                        expected_revision: done.revision,
                        request_id: None,
                    },
                )?;
            }
            done = lifecycle::complete_order(
                &mut conn,
                LifecycleInput {
                    order_id: done.id.clone(),
                    expected_revision: done.revision,
                    request_id: None,
                },
            )?;
            tick(format!(
                "{}「{}」status=complete start=NULL delivery=NULL",
                done.code, done.title
            ))?;

            // cancelled：直接取消，日期全空
            let cancelled = orders::create_order(
                &mut conn,
                &state.highwater,
                tz,
                CreateOrderInput {
                    title: "QA-D 已取消且无计划日期".into(),
                    client: ClientChoice::None,
                    amount_cents: Some(12_000),
                    planned_start_date: None,
                    planned_delivery_date: None,
                    note: Some("QA-FIXTURE-01 场景 D：终态 + 两空".into()),
                    ..Default::default()
                },
            )?;
            let cancelled = lifecycle::cancel_order(
                &mut conn,
                LifecycleInput {
                    order_id: cancelled.id.clone(),
                    expected_revision: cancelled.revision,
                    request_id: None,
                },
            )?;
            tick(format!(
                "{}「{}」status=cancelled start=NULL delivery=NULL",
                cancelled.code, cancelled.title
            ))?;
        }

        _ => unreachable!("入口已过滤非时间线场景"),
    }

    settings::set(&conn, DATASET_KEY, version, &timezone::now_timestamp())?;

    let mut report = super::report_from_conn(root, &conn, false)?;
    report.version = version.to_string();

    let facts = facts(&conn)?;
    let mut summary = header;
    summary.extend(collected);
    summary.push(format!("数据核对：{facts}"));
    validate(scenario, &facts)?;
    report.summary = summary;
    Ok(report)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FixtureFacts {
    pub total: i64,
    pub active: i64,
    pub complete: i64,
    pub cancelled: i64,
    pub both_empty: i64,
    pub only_start: i64,
    pub only_delivery: i64,
    pub both_dates: i64,
}

impl std::fmt::Display for FixtureFacts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "订单 {}（活动 {} / 完成 {} / 取消 {}）；日期：两空 {} / 仅开始 {} / 仅交付 {} / 双日期 {}",
            self.total,
            self.active,
            self.complete,
            self.cancelled,
            self.both_empty,
            self.only_start,
            self.only_delivery,
            self.both_dates
        )
    }
}

pub fn facts(conn: &rusqlite::Connection) -> AppResult<FixtureFacts> {
    let count = |sql: &str| -> AppResult<i64> { Ok(conn.query_row(sql, [], |r| r.get(0))?) };
    Ok(FixtureFacts {
        total: count("SELECT COUNT(*) FROM orders")?,
        active: count("SELECT COUNT(*) FROM orders WHERE status = 'active'")?,
        complete: count("SELECT COUNT(*) FROM orders WHERE status = 'complete'")?,
        cancelled: count("SELECT COUNT(*) FROM orders WHERE status = 'cancelled'")?,
        both_empty: count(
            "SELECT COUNT(*) FROM orders \
             WHERE planned_start_date IS NULL AND planned_delivery_date IS NULL",
        )?,
        only_start: count(
            "SELECT COUNT(*) FROM orders \
             WHERE planned_start_date IS NOT NULL AND planned_delivery_date IS NULL",
        )?,
        only_delivery: count(
            "SELECT COUNT(*) FROM orders \
             WHERE planned_start_date IS NULL AND planned_delivery_date IS NOT NULL",
        )?,
        both_dates: count(
            "SELECT COUNT(*) FROM orders \
             WHERE planned_start_date IS NOT NULL AND planned_delivery_date IS NOT NULL",
        )?,
    })
}

/// 每个场景必须有确定的形状；数量对不上就报错，而不是"生成了就算成功"。
fn validate(scenario: qa::Scenario, f: &FixtureFacts) -> AppResult<()> {
    let expected = match scenario {
        qa::Scenario::TimelineUnscheduled => FixtureFacts {
            total: 5,
            active: 5,
            complete: 0,
            cancelled: 0,
            both_empty: 2,
            only_start: 1,
            only_delivery: 1,
            both_dates: 1,
        },
        qa::Scenario::TimelineEmpty => FixtureFacts {
            total: 0,
            active: 0,
            complete: 0,
            cancelled: 0,
            both_empty: 0,
            only_start: 0,
            only_delivery: 0,
            both_dates: 0,
        },
        qa::Scenario::TimelineNoDates => FixtureFacts {
            total: 2,
            active: 2,
            complete: 0,
            cancelled: 0,
            both_empty: 2,
            only_start: 0,
            only_delivery: 0,
            both_dates: 0,
        },
        qa::Scenario::TimelineTerminal => FixtureFacts {
            total: 2,
            active: 0,
            complete: 1,
            cancelled: 1,
            both_empty: 2,
            only_start: 0,
            only_delivery: 0,
            both_dates: 0,
        },
        _ => {
            return Err(AppError::invalid("校验只覆盖时间线验收场景"));
        }
    };
    if f != &expected {
        return Err(AppError::db(format!(
            "{} 预置校验失败：得到 {f}，期望 {expected}",
            scenario.as_str()
        )));
    }
    Ok(())
}


