//! 集成测试共用夹具。

#![allow(dead_code)]

use std::path::Path;

use chrono_tz::Tz;
use minidesk::store::environment::Environment;
use minidesk::store::highwater::HighWater;
use minidesk::store::migrations;

pub fn tz() -> Tz {
    Tz::Asia__Shanghai
}

/// 用正式迁移表打开（或首次创建）一个数据环境。
pub fn open(root: &Path) -> Environment {
    Environment::open_with(
        root,
        &migrations::production(),
        migrations::APP_SCHEMA_VERSION,
        Some(tz()),
    )
    .expect("打开数据环境失败")
}

/// 打开失败时返回错误（用于断言"必须拒绝"的场景）。
pub fn try_open(root: &Path) -> minidesk::error::AppResult<Environment> {
    Environment::open_with(
        root,
        &migrations::production(),
        migrations::APP_SCHEMA_VERSION,
        Some(tz()),
    )
}

pub fn highwater(env: &Environment) -> HighWater {
    HighWater::open(&env.layout().highwater_db()).expect("打开编号记录失败")
}

/// 直接插入一张可用于约束测试的订单（不经过领域层）。
/// 订单与当前阶段的可延迟外键要求两者在同一事务内提交。
pub fn insert_order(conn: &mut rusqlite::Connection, code: &str, title: &str) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let now = minidesk::store::timezone::now_timestamp();
    let tx = conn.transaction().expect("开启事务失败");
    tx.execute(
        "INSERT INTO orders (id, code, title, status, current_stage_id, queue_position,
                             revision, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'active', 'draft', 0, 0, ?4, ?4)",
        rusqlite::params![id, code, title, now],
    )
    .expect("插入订单失败");
    tx.execute(
        "INSERT INTO order_stages (order_id, stage_id, title, position)
         VALUES (?1, 'draft', '草稿', 0)",
        [&id],
    )
    .expect("插入阶段失败");
    tx.commit().expect("提交失败");
    id
}
