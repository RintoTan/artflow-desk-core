//! QA 沙箱：独立应用标识 + 独立场景目录。
//!
//! 设计取舍：**不使用环境变量覆盖数据目录**。
//! 正式发布版如果接受任意路径，就等于给"把用户数据指到别处"开了后门，
//! 一旦误设（或被人恶意设置）就可能覆盖真实台账。
//!
//! 因此改用结构性隔离：
//!
//! 1. QA 用独立应用标识 `dev.artflow.minidesk.qa`，`app_data_dir()` 天然指向
//!    `~/Library/Application Support/dev.artflow.minidesk.qa`，与正式目录是兄弟目录。
//! 2. QA 模式下再按场景分子目录：`<qa>/seeded` 与 `<qa>/clean`，两套场景互不影响。
//! 3. 场景名只接受 `seeded` / `clean` 两个白名单值，**不接受路径**，
//!    所以即使变量被乱设，也只会落在 QA 目录内部。
//! 4. 正式模式完全不读该变量；并且在正式目录里发现 QA 标记时拒绝启动（反向守卫）。
//! 5. 路径比较前先做"最长存在祖先"的 canonicalize，符号链接别名绕不过去。
//!
//! 结果是：正式构建没有任何参数能改变它的数据目录；QA 构建只能在自己的目录内换场景。

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

pub const PRODUCTION_IDENTIFIER: &str = "dev.artflow.minidesk";
pub const QA_IDENTIFIER: &str = "dev.artflow.minidesk.qa";
pub const SCENARIO_ENV: &str = "AF_MINIDESK_QA_SCENARIO";
pub const QA_MARKER_FILE: &str = ".qa-root";
pub const QA_MARKER_BODY: &str = "artflow-minidesk-qa";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scenario {
    /// 预置虚构数据，用于看复杂状态。
    Seeded,
    /// 空白环境，用于从零走流程（首次启动、建单、导图）。
    Clean,
    /// QA-FIXTURE-01 场景 A：完全未排期分类（含仅有单端日期的订单）。
    TimelineUnscheduled,
    /// QA-FIXTURE-01 场景 B：已初始化但没有任何订单。
    TimelineEmpty,
    /// QA-FIXTURE-01 场景 C：只有活动订单，且全部没有计划日期。
    TimelineNoDates,
    /// QA-FIXTURE-01 场景 D：全部订单都是终态，且全部没有计划日期。
    TimelineTerminal,
}

impl Scenario {
    pub fn as_str(self) -> &'static str {
        match self {
            Scenario::Seeded => "seeded",
            Scenario::Clean => "clean",
            Scenario::TimelineUnscheduled => "timeline-unscheduled",
            Scenario::TimelineEmpty => "timeline-empty",
            Scenario::TimelineNoDates => "timeline-no-dates",
            Scenario::TimelineTerminal => "timeline-terminal",
        }
    }

    pub fn parse(raw: &str) -> AppResult<Self> {
        match raw.trim() {
            "seeded" => Ok(Scenario::Seeded),
            "clean" => Ok(Scenario::Clean),
            "timeline-unscheduled" => Ok(Scenario::TimelineUnscheduled),
            "timeline-empty" => Ok(Scenario::TimelineEmpty),
            "timeline-no-dates" => Ok(Scenario::TimelineNoDates),
            "timeline-terminal" => Ok(Scenario::TimelineTerminal),
            other => Err(AppError::env(format!(
                "{SCENARIO_ENV} 只接受 seeded / clean / timeline-unscheduled / \
                 timeline-empty / timeline-no-dates / timeline-terminal，收到 {other:?}；\
                 这里是场景名，不是路径，目录不会因此改变。"
            ))),
        }
    }

    /// 是否属于 QA-FIXTURE-01 的时间线验收场景。
    pub fn is_timeline_fixture(self) -> bool {
        matches!(
            self,
            Scenario::TimelineUnscheduled
                | Scenario::TimelineEmpty
                | Scenario::TimelineNoDates
                | Scenario::TimelineTerminal
        )
    }
}

/// 只有 QA 构建（独立标识）才允许进入 QA 模式。
pub fn is_qa_identifier(identifier: &str) -> bool {
    identifier == QA_IDENTIFIER
}

/// 场景名 → 该场景的数据根。白名单场景名，永远是 QA 目录的子目录。
pub fn scenario_root(qa_app_data_dir: &Path, scenario: Scenario) -> PathBuf {
    qa_app_data_dir.join(scenario.as_str())
}

/// 只在 QA 构建里调用。正式构建根本不读这个变量。
pub fn scenario_from_env() -> AppResult<Scenario> {
    match std::env::var(SCENARIO_ENV) {
        Ok(value) => Scenario::parse(&value),
        Err(std::env::VarError::NotPresent) => Ok(Scenario::Seeded),
        Err(std::env::VarError::NotUnicode(_)) => Err(AppError::env(format!(
            "{SCENARIO_ENV} 不是合法 UTF-8，拒绝启动"
        ))),
    }
}

/// 正式应用的数据目录（用于交叉检查；只依赖 HOME，不依赖当前进程身份）。
pub fn production_data_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| {
        PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join(PRODUCTION_IDENTIFIER)
    })
}

/// 取"最长存在祖先"的 canonical 路径，再接回不存在的尾部。
///
/// 这样即使 `qa_root` 还不存在、或者中间某一段是符号链接，
/// 比较结果也不会被别名骗过去。
pub fn normalize(path: &Path) -> PathBuf {
    let mut missing: Vec<OsString> = Vec::new();
    let mut cursor = path.to_path_buf();
    loop {
        if let Ok(canon) = fs::canonicalize(&cursor) {
            let mut out = canon;
            for segment in missing.iter().rev() {
                out.push(segment);
            }
            return out;
        }
        match (cursor.file_name(), cursor.parent()) {
            (Some(name), Some(parent)) => {
                missing.push(name.to_os_string());
                cursor = parent.to_path_buf();
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// QA 根不得与正式数据目录等价、嵌套或互为别名。
pub fn ensure_not_production(qa_root: &Path) -> AppResult<()> {
    ensure_isolated(qa_root, production_data_dir().as_deref())
}

/// 可注入正式目录的版本，供测试构造符号链接等场景。
pub fn ensure_isolated(qa_root: &Path, production: Option<&Path>) -> AppResult<()> {
    if let Some(production) = production {
        let qa = normalize(qa_root);
        let prod = normalize(&production);
        if qa == prod || qa.starts_with(&prod) || prod.starts_with(&qa) {
            return Err(AppError::env(format!(
                "QA 数据根与正式数据目录重叠，拒绝启动：qa={} production={}",
                qa.display(),
                prod.display()
            )));
        }
    }
    Ok(())
}

/// 正式模式的反向守卫：正式目录里出现 QA 标记就不启动。
pub fn guard_production_root(app_data_dir: &Path) -> AppResult<()> {
    if app_data_dir.join(QA_MARKER_FILE).exists() {
        return Err(AppError::env(format!(
            "正式数据目录里出现 QA 标记（{}），拒绝启动：\
             这通常意味着测试数据被写进了正式目录，请先确认数据来源。",
            app_data_dir.join(QA_MARKER_FILE).display()
        )));
    }
    Ok(())
}

pub fn has_marker(dir: &Path) -> bool {
    dir.join(QA_MARKER_FILE).is_file()
}

pub fn write_marker(dir: &Path) -> AppResult<()> {
    fs::create_dir_all(dir)?;
    fs::write(dir.join(QA_MARKER_FILE), format!("{QA_MARKER_BODY}\n"))?;
    Ok(())
}

pub fn verify_marker(dir: &Path) -> AppResult<()> {
    if !dir.is_dir() {
        return Err(AppError::env(format!(
            "QA 场景目录不存在：{}",
            dir.display()
        )));
    }
    match fs::read_to_string(dir.join(QA_MARKER_FILE)) {
        Ok(body) if body.trim() == QA_MARKER_BODY => Ok(()),
        Ok(_) => Err(AppError::denied(format!(
            "{} 的 QA 标记内容不正确，拒绝执行任何改动",
            dir.display()
        ))),
        Err(_) => Err(AppError::denied(format!(
            "{} 缺少 QA 标记 {}，拒绝执行任何改动",
            dir.display(),
            QA_MARKER_FILE
        ))),
    }
}

/// `qa_seed` 与测试用：默认 QA 根（`~/Library/Application Support/dev.artflow.minidesk.qa/<scenario>`）。
pub fn default_root(scenario: Scenario) -> AppResult<PathBuf> {
    let home = std::env::var_os("HOME")
        .ok_or_else(|| AppError::env("无法读取 HOME，不能定位 QA 目录"))?;
    let base = PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join(QA_IDENTIFIER);
    Ok(scenario_root(&base, scenario))
}
