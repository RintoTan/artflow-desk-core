//! QA 沙箱数据准备工具（开发/QA 专用，不随安装包分发）。
//!
//! ```text
//! qa_seed                              # 预置 seeded 场景（已存在则跳过）
//! qa_seed --scenario clean             # 准备空白 clean 场景
//! qa_seed --scenario seeded --rebuild  # 显式重建（先校验 QA 标记）
//! qa_seed --root <绝对路径> ...        # 自定义位置（测试用，需通过重叠检查）
//!
//! QA-FIXTURE-01 时间线验收场景（各自独立目录，互不覆盖 seeded）：
//! ```text
//! qa_seed --scenario timeline-unscheduled
//! qa_seed --scenario timeline-empty
//! qa_seed --scenario timeline-no-dates
//! qa_seed --scenario timeline-terminal
//! ```

use std::path::PathBuf;

use minidesk::error::{AppError, AppResult};
use minidesk::qa_dataset::{self, SeedOptions, SeedReport};
use minidesk::store::qa;

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
            "用法：qa_seed [--scenario seeded|clean] [--rebuild] [--root <绝对路径>] [--fail-after N]\n\
             \n\
             --scenario   seeded（虚构数据，默认）/ clean（空目录）/ \n\
                           timeline-unscheduled | timeline-empty | \n\
                           timeline-no-dates | timeline-terminal（DEV-06D-2 验收）\n\
             --rebuild    清空该场景后重建。目录必须带 .qa-root 标记\n\
             --root       自定义数据根（默认 ~/Library/Application Support/dev.artflow.minidesk.qa/<场景>）\n\
             --fail-after 仅测试用：第 N 个订单后强制失败，验证失败不留半成品"
        );
        return Ok(());
    }

    let mut scenario_raw: Option<String> = None;
    let mut rebuild = false;
    let mut root_override: Option<PathBuf> = None;
    let mut fail_after: Option<usize> = None;

    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--scenario" => {
                scenario_raw = Some(
                    iter.next()
                        .ok_or_else(|| AppError::invalid("--scenario 需要 seeded 或 clean"))?
                        .clone(),
                );
            }
            "--rebuild" => rebuild = true,
            "--root" => {
                root_override = Some(PathBuf::from(
                    iter.next()
                        .ok_or_else(|| AppError::invalid("--root 需要一个路径"))?,
                ));
            }
            "--fail-after" => {
                let raw = iter
                    .next()
                    .ok_or_else(|| AppError::invalid("--fail-after 需要一个数字"))?;
                fail_after = Some(
                    raw.parse::<usize>()
                        .map_err(|_| AppError::invalid("--fail-after 必须是正整数"))?,
                );
            }
            other => return Err(AppError::invalid(format!("未知参数：{other}"))),
        }
    }

    let scenario = match scenario_raw.as_deref() {
        Some(raw) => qa::Scenario::parse(raw)?,
        None => qa::Scenario::Seeded,
    };

    let root = match root_override {
        Some(path) => {
            if !path.is_absolute() {
                return Err(AppError::invalid("--root 必须是绝对路径"));
            }
            path
        }
        None => qa::default_root(scenario)?,
    };
    qa::ensure_not_production(&root)?;

    let report = match scenario {
        qa::Scenario::Seeded => qa_dataset::seed_seeded(
            &root,
            &SeedOptions {
                rebuild,
                fail_after,
            },
        )?,
        qa::Scenario::Clean => qa_dataset::prepare_clean(&root, rebuild)?,
        other if other.is_timeline_fixture() => {
            qa_dataset::seed_timeline(other, &root, &SeedOptions { rebuild, fail_after })?
        }
        other => {
            return Err(AppError::invalid(format!(
                "{} 没有对应的预置逻辑",
                other.as_str()
            )))
        }
    };

    print_report(scenario, &report);
    Ok(())
}

fn print_report(scenario: qa::Scenario, report: &SeedReport) {
    println!("[qa_seed] 场景={} root={}", scenario.as_str(), report.root);
    if report.already_seeded {
        println!(
            "[qa_seed] 该场景已是 {} 数据集，未做任何改动。",
            report.version
        );
    }
    println!(
        "[qa_seed] 计数：订单 {} / 客户 {} / 模板 {} / 附件 {} / 事件 {}（完成 {}）",
        report.orders,
        report.clients,
        report.templates,
        report.attachments,
        report.events,
        report.completed_events
    );
    for line in &report.summary {
        println!("  {line}");
    }
    println!(
        "\n启动该场景：\n  cd <仓库根目录>\n  npm run qa:{}",
        scenario.as_str()
    );
}
