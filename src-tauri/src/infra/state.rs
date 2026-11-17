//! 进程级应用状态：持有数据环境（含跨进程锁）与编号高水位。

use std::path::Path;

use crate::error::{AppError, AppResult};
use crate::store::environment::Environment;
use crate::store::highwater::HighWater;
use crate::store::qa::Scenario;

pub struct AppState {
    pub env: Environment,
    pub highwater: HighWater,
    /// Some = 本次进程跑在 QA 沙箱的某个场景里。界面必须显示标识。
    qa: Option<Scenario>,
}

impl AppState {
    pub fn open(root: &Path) -> AppResult<Self> {
        Self::open_qa(root, None)
    }

    pub fn open_qa(root: &Path, qa: Option<Scenario>) -> AppResult<Self> {
        let env = Environment::open(root)?;
        let hw_path = env.layout().highwater_db();
        if !hw_path.exists() {
            // 已初始化的环境里编号记录消失，说明状态不明，禁止继续分配编号。
            return Err(AppError::numbering(
                "编号记录（highwater.sqlite）缺失，已停止启动以避免编号复用。\
                 请从备份恢复数据目录。",
            ));
        }
        let highwater = HighWater::open(&hw_path)?;
        Ok(Self {
            env,
            highwater,
            qa,
        })
    }

    pub fn qa_mode(&self) -> bool {
        self.qa.is_some()
    }

    pub fn qa_scenario(&self) -> Option<&'static str> {
        self.qa.map(|s| s.as_str())
    }
}
