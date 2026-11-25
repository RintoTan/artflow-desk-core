//! SQL 可见性 Lint：业务代码里出现裸 `FROM orders` / `FROM clients` 就失败。
//!
//! 为什么要有这条 lint：v8 之后「看不见回收站数据」靠三样东西——
//! 视图（`*_visible`）、守卫（`store::visibility`）、以及**每个新查询都记得用它们**。
//! 前两样有代码，第三样只有纪律。这条 lint 把纪律变成编译期之后的硬失败。
//!
//! 白名单精确到**具体一行文本 + 该文本应出现的行数**，不接受模块级豁免：
//! - 新增一条裸查询 → 文本对不上 → 失败；
//! - 复制一条已豁免的查询 → 行数对不上 → 失败；
//! - 删除一条已豁免的查询 → 行数为 0（陈旧条目）→ 失败。
//!
//! 每个豁免都必须说明「这条查询为什么必须看全量」，并且由本文件末尾的
//! 专项断言逐类复核，避免白名单变成垃圾桶。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// 豁免类别。分类不是为了好看，是为了让「哪些文件允许出现哪类豁免」可断言。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// 迁移脚本里的建表/建视图语句，本身就是 schema 定义。
    MigrationSchema,
    /// 守卫自身要读 `deleted_at`，只能查基表。
    GuardSelf,
    /// 备份与备份摘要：快照必须完整，不能按可见性裁剪。
    BackupSnapshot,
    /// 诊断统计：面向排障，要报真实总量。
    Diagnostics,
    /// `request_id` 幂等：重放请求必须能找到已落库的订单，包括已删除的。
    Idempotency,
    /// 模板删除守卫：数全部订单，含回收站，否则恢复后引用断裂。
    TemplateGuard,
    /// 按 id 读写前的内部读取。入口已有 `require_visible_*` 守卫，这里读基表
    /// 是为了拿到 `status`/`revision` 等守卫不返回的字段。
    GuardedRead,
    /// QA 夹具断言：需要核对「库里确实有 N 条」这类事实。
    QaFixture,
    /// 导出按 `includeTrashed` 动态选表，SQL 里表名是 `{table}` 占位。
    ExportDynamic,
    /// 列表里取客户显示名。订单可见 ⇒ 按删除协议其客户也可见，
    /// 这里的基表 join 只为避免显示名变空白。
    DisplayJoin,
    /// 回收站自己：它的任务就是读「被隐藏的那些行」，用视图会一行都读不到。
    TrashRead,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::MigrationSchema => "MIGRATION_SCHEMA",
            Kind::GuardSelf => "GUARD_SELF",
            Kind::BackupSnapshot => "BACKUP_SNAPSHOT",
            Kind::Diagnostics => "DIAGNOSTICS",
            Kind::Idempotency => "IDEMPOTENCY",
            Kind::TemplateGuard => "TEMPLATE_GUARD",
            Kind::GuardedRead => "GUARDED_READ",
            Kind::QaFixture => "QA_FIXTURE",
            Kind::ExportDynamic => "EXPORT_DYNAMIC",
            Kind::DisplayJoin => "DISPLAY_JOIN",
            Kind::TrashRead => "TRASH_READ",
        }
    }
}

struct Exemption {
    file: &'static str,
    /// 该行（去掉首尾空白后）必须包含的片段。
    needle: &'static str,
    /// 预期命中的行数。多了少了都算漂移。
    lines: usize,
    kind: Kind,
    why: &'static str,
}

const EXEMPTIONS: &[Exemption] = &[
    // ---- schema 定义 ----
    Exemption {
        file: "store/migrations/v8.rs",
        needle: "CREATE VIEW orders_visible  AS SELECT * FROM orders  WHERE deleted_at IS NULL;",
        lines: 1,
        kind: Kind::MigrationSchema,
        why: "视图自身的定义必须读基表",
    },
    Exemption {
        file: "store/migrations/v8.rs",
        needle: "CREATE VIEW orders_trashed  AS SELECT * FROM orders  WHERE deleted_at IS NOT NULL;",
        lines: 1,
        kind: Kind::MigrationSchema,
        why: "回收站视图按定义只能读基表",
    },
    // v9 加 archived_at 后必须重建视图（SQLite 的 SELECT * 列冻结），
    // 重建语句与 v8 同形，但属于新文件，单独登记。
    Exemption {
        file: "store/migrations/v9.rs",
        needle: "CREATE VIEW orders_visible  AS SELECT * FROM orders  WHERE deleted_at IS NULL;",
        lines: 1,
        kind: Kind::MigrationSchema,
        why: "v9 重建可见性视图，让新列在视图里可见",
    },
    Exemption {
        file: "store/migrations/v9.rs",
        needle: "CREATE VIEW orders_trashed  AS SELECT * FROM orders  WHERE deleted_at IS NOT NULL;",
        lines: 1,
        kind: Kind::MigrationSchema,
        why: "v9 重建回收站视图，同上",
    },
    // v13 加 pinned_at 后同样要重建（列冻结），与 v9 同理，单独登记。
    Exemption {
        file: "store/migrations/v13.rs",
        needle: "CREATE VIEW orders_visible  AS SELECT * FROM orders  WHERE deleted_at IS NULL;",
        lines: 1,
        kind: Kind::MigrationSchema,
        why: "v13 重建可见性视图，让 pinned_at 在视图里可见",
    },
    Exemption {
        file: "store/migrations/v13.rs",
        needle: "CREATE VIEW orders_trashed  AS SELECT * FROM orders  WHERE deleted_at IS NOT NULL;",
        lines: 1,
        kind: Kind::MigrationSchema,
        why: "v13 重建回收站视图，同上",
    },
    Exemption {
        file: "backup/restore.rs",
        needle: "SELECT code FROM orders\"",
        lines: 1,
        kind: Kind::BackupSnapshot,
        why: "重建编号高水位：回收站里的订单仍占着编号，必须读基表",
    },
    Exemption {
        file: "store/migrations/v8.rs",
        needle: "CREATE VIEW clients_visible AS SELECT * FROM clients WHERE deleted_at IS NULL;",
        lines: 1,
        kind: Kind::MigrationSchema,
        why: "客户视图定义",
    },
    // ---- 守卫自身 ----
    Exemption {
        file: "store/visibility.rs",
        needle: "SELECT deleted_at FROM orders WHERE id = ?1",
        lines: 1,
        kind: Kind::GuardSelf,
        why: "守卫的工作就是读 deleted_at，不能查 visible 视图",
    },
    Exemption {
        file: "store/visibility.rs",
        needle: "SELECT deleted_at FROM clients WHERE id = ?1",
        lines: 1,
        kind: Kind::GuardSelf,
        why: "同上（客户侧）",
    },
    // ---- 备份 ----
    Exemption {
        file: "backup/manifest.rs",
        needle: "SELECT COUNT(*) FROM orders\"",
        lines: 1,
        kind: Kind::BackupSnapshot,
        why: "摘要报「包里有多少订单」，含回收站",
    },
    Exemption {
        file: "backup/manifest.rs",
        needle: "SELECT COUNT(*) FROM orders WHERE status = 'active'",
        lines: 1,
        kind: Kind::BackupSnapshot,
        why: "活动订单数同样是快照口径",
    },
    Exemption {
        file: "backup/manifest.rs",
        needle: "SELECT COUNT(*) FROM clients\"",
        lines: 1,
        kind: Kind::BackupSnapshot,
        why: "客户总数含回收站",
    },
    Exemption {
        file: "backup/manifest.rs",
        needle: "SELECT COUNT(*) FROM orders WHERE deleted_at IS NOT NULL",
        lines: 1,
        kind: Kind::BackupSnapshot,
        why: "回收站订单数是 orders 的子集，必须从基表算",
    },
    Exemption {
        file: "backup/manifest.rs",
        needle: "SELECT COUNT(*) FROM clients WHERE deleted_at IS NOT NULL",
        lines: 1,
        kind: Kind::BackupSnapshot,
        why: "同上（客户侧）",
    },
    Exemption {
        file: "commands/backup.rs",
        needle: "SELECT COUNT(*) FROM orders",
        lines: 1,
        kind: Kind::BackupSnapshot,
        why: "备份前提示将要打包多少订单，含回收站",
    },
    // ---- 诊断 ----
    Exemption {
        file: "store/diagnostics.rs",
        needle: "SELECT COUNT(*) FROM orders",
        lines: 1,
        kind: Kind::Diagnostics,
        why: "诊断包要报真实行数",
    },
    Exemption {
        file: "store/diagnostics.rs",
        needle: "SELECT COUNT(*) FROM clients",
        lines: 1,
        kind: Kind::Diagnostics,
        why: "同上（客户侧）",
    },
    // ---- 幂等 ----
    Exemption {
        file: "domain/orders.rs",
        needle: "SELECT id FROM orders WHERE request_id = ?1",
        lines: 1,
        kind: Kind::Idempotency,
        why: "重放建单请求时，已删除订单也要能命中，否则会重复建单",
    },
    // ---- 模板守卫 ----
    Exemption {
        file: "domain/templates.rs",
        needle: "SELECT COUNT(*) FROM orders WHERE stage_template_id = ?1",
        lines: 1,
        kind: Kind::TemplateGuard,
        why: "回收站订单仍持有模板引用（该列无外键），只数有效订单会误删模板",
    },
    // ---- 按 id 读写的内部读取（入口均有守卫） ----
    Exemption {
        file: "domain/orders.rs",
        needle: "FROM orders WHERE id = ?1",
        lines: 1,
        kind: Kind::GuardedRead,
        why: "改单前读当前值；update_details 入口已 require_visible_order",
    },
    Exemption {
        file: "domain/clients.rs",
        needle: "FROM clients WHERE id = ?1",
        lines: 1,
        kind: Kind::GuardedRead,
        why: "改客户前读当前值；update 入口已 require_visible_client",
    },
    Exemption {
        file: "domain/lifecycle.rs",
        needle: "revision FROM orders WHERE id = ?1",
        lines: 1,
        kind: Kind::GuardedRead,
        why: "load_facts 读状态机事实；8 个生命周期入口已守卫",
    },
    Exemption {
        file: "domain/workflow.rs",
        needle: "status FROM orders WHERE id = ?1",
        lines: 1,
        kind: Kind::GuardedRead,
        why: "load_frame 读阶段框架；4 个阶段写入口已守卫",
    },
    // ---- 导出动态表名 ----
    Exemption {
        file: "domain/export.rs",
        needle: "FROM {table} o LEFT JOIN clients c",
        lines: 1,
        kind: Kind::ExportDynamic,
        why: "includeTrashed 决定 {table} 是 orders 还是 orders_visible",
    },
    // ---- 列表里取客户名 ----
    Exemption {
        file: "domain/orders.rs",
        needle: "LEFT JOIN clients c ON c.id = o.client_id",
        lines: 1,
        kind: Kind::DisplayJoin,
        why: "订单详情取客户显示名；订单可见则其客户按删除协议也可见",
    },
    Exemption {
        file: "domain/queue.rs",
        needle: "FROM orders_visible o LEFT JOIN clients c",
        lines: 1,
        kind: Kind::DisplayJoin,
        why: "队列列表同上",
    },
    // ---- 回收站读模型（03B / 03C） ----
    // 这些查询按定义要读已删除的行；换成 *_visible 会得到空结果。
    // 下面的 trash_module_* 用例单独验证「确实带了 deleted_at 过滤」。
    Exemption {
        file: "domain/trash.rs",
        needle: "FROM clients c",
        lines: 2,
        kind: Kind::TrashRead,
        why: "客户组主表与清空列表都要包含已删除客户",
    },
    Exemption {
        file: "domain/trash.rs",
        needle: "LEFT JOIN orders o ON o.client_id = c.id AND o.deleted_at IS NOT NULL",
        lines: 1,
        kind: Kind::TrashRead,
        why: "组内订单只要已删除的那些",
    },
    Exemption {
        file: "domain/trash.rs",
        needle: "FROM orders o",
        lines: 3,
        kind: Kind::TrashRead,
        why: "独立订单查询、清空列表、组内订单计数",
    },
    Exemption {
        file: "domain/trash.rs",
        needle: "LEFT JOIN clients c ON c.id = o.client_id",
        lines: 2,
        kind: Kind::TrashRead,
        why: "独立订单要显示原客户名（客户可能已删除）",
    },
    Exemption {
        file: "domain/trash.rs",
        needle: "SELECT display_name FROM clients WHERE id = ?1",
        lines: 1,
        kind: Kind::TrashRead,
        why: "删除确认框需要客户名，客户此刻仍有效",
    },
    Exemption {
        file: "domain/trash.rs",
        needle: "\"SELECT COUNT(*) FROM orders WHERE client_id = ?1\",",
        lines: 3,
        kind: Kind::TrashRead,
        why: "影响范围、删除结果、清空批次文案都要数「全部订单」",
    },
    Exemption {
        file: "domain/trash.rs",
        needle: "\"SELECT COUNT(*) FROM orders WHERE client_id = ?1 AND deleted_at IS NOT NULL\",",
        lines: 2,
        kind: Kind::TrashRead,
        why: "统计其中已在回收站的订单数",
    },
    Exemption {
        file: "domain/trash.rs",
        needle: "SELECT deleted_at, client_id FROM orders WHERE id = ?1",
        lines: 1,
        kind: Kind::TrashRead,
        why: "恢复单张订单要先判断它是否已删除、客户是否已删除",
    },
    Exemption {
        file: "domain/trash.rs",
        needle: "SELECT deleted_at, client_id, deleted_batch FROM orders WHERE id = ?1",
        lines: 1,
        kind: Kind::TrashRead,
        why: "永久删除前要读批次，确认它不归某个客户组",
    },
    Exemption {
        file: "domain/trash.rs",
        needle: "SELECT deleted_at, deleted_batch FROM clients WHERE id = ?1",
        lines: 2,
        kind: Kind::TrashRead,
        why: "恢复与永久删除客户都要先取批次，才能限定范围",
    },
    Exemption {
        file: "domain/trash.rs",
        needle: "SELECT deleted_at FROM clients WHERE id = ?1",
        lines: 1,
        kind: Kind::TrashRead,
        why: "单独永久删除订单前，判断它的客户是否也在回收站",
    },
    Exemption {
        file: "domain/trash.rs",
        needle: "\"SELECT code, deleted_batch FROM orders",
        lines: 1,
        kind: Kind::TrashRead,
        why: "批次完整性检查：找出不在本批次的订单",
    },
    Exemption {
        file: "domain/trash.rs",
        needle: "SELECT id FROM orders WHERE client_id = ?1 AND deleted_batch = ?2",
        lines: 1,
        kind: Kind::TrashRead,
        why: "永久删除客户组：展开本批次全部订单",
    },
    Exemption {
        file: "domain/trash.rs",
        needle: "DELETE FROM orders WHERE id = ?1",
        lines: 1,
        kind: Kind::TrashRead,
        why: "永久删除的落点，必须作用于回收站行",
    },
    Exemption {
        file: "domain/trash.rs",
        needle: "DELETE FROM clients WHERE id = ?1",
        lines: 1,
        kind: Kind::TrashRead,
        why: "客户组永久删除的落点，前面已断言无订单引用",
    },
    // ---- QA 夹具 ----
    Exemption {
        file: "qa_dataset/mod.rs",
        needle: "SELECT COUNT(*) FROM orders\"",
        lines: 1,
        kind: Kind::QaFixture,
        why: "QA 场景断言总单数",
    },
    Exemption {
        file: "qa_dataset/mod.rs",
        needle: "SELECT COUNT(*) FROM clients\"",
        lines: 1,
        kind: Kind::QaFixture,
        why: "QA 场景断言总客户数",
    },
    Exemption {
        file: "qa_dataset/timeline_fixtures.rs",
        needle: "total: count(\"SELECT COUNT(*) FROM orders\")?",
        lines: 1,
        kind: Kind::QaFixture,
        why: "时间线夹具核对总单数",
    },
    Exemption {
        file: "qa_dataset/timeline_fixtures.rs",
        needle: "active: count(\"SELECT COUNT(*) FROM orders WHERE status = 'active'\")?",
        lines: 1,
        kind: Kind::QaFixture,
        why: "按原始状态核对",
    },
    Exemption {
        file: "qa_dataset/timeline_fixtures.rs",
        needle: "complete: count(\"SELECT COUNT(*) FROM orders WHERE status = 'complete'\")?",
        lines: 1,
        kind: Kind::QaFixture,
        why: "按原始状态核对",
    },
    Exemption {
        file: "qa_dataset/timeline_fixtures.rs",
        needle: "cancelled: count(\"SELECT COUNT(*) FROM orders WHERE status = 'cancelled'\")?",
        lines: 1,
        kind: Kind::QaFixture,
        why: "按原始状态核对",
    },
    Exemption {
        file: "qa_dataset/timeline_fixtures.rs",
        needle: "\"SELECT COUNT(*) FROM orders \\",
        lines: 4,
        kind: Kind::QaFixture,
        why: "四类排期组合（无日期/仅开始/仅交付/都有）计数，SQL 前三行文字相同",
    },
];

fn src_root() -> PathBuf {
    // CARGO_MANIFEST_DIR = src-tauri
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .expect("读目录失败")
        .map(|e| e.expect("目录项失败").path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            if path.file_name().and_then(|n| n.to_str()) == Some("target") {
                continue;
            }
            rust_files(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            out.push(path);
        }
    }
}

/// 裸表名：`orders` / `clients` 后面不能再接标识符字符，`orders_visible` 不算。
fn bare_tables(line: &str) -> Vec<&'static str> {
    let mut hits = Vec::new();
    for keyword in ["FROM", "JOIN"] {
        for table in ["orders", "clients"] {
            let needle = format!("{keyword} {table}");
            let mut from = 0;
            while let Some(pos) = line[from..].find(&needle) {
                let start = from + pos;
                let end = start + needle.len();
                let next = line[end..].chars().next();
                let boundary_ok = match next {
                    None => true,
                    Some(c) => !(c.is_alphanumeric() || c == '_'),
                };
                if boundary_ok {
                    hits.push(if table == "orders" {
                        "orders"
                    } else {
                        "clients"
                    });
                }
                from = end;
            }
        }
    }
    hits
}

fn is_comment(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("//") || t.starts_with('*') || t.starts_with("/*")
}

struct Hit {
    file: String,
    line_no: usize,
    text: String,
}

fn collect_hits() -> Vec<Hit> {
    let mut files = Vec::new();
    rust_files(&src_root(), &mut files);
    assert!(files.len() > 20, "扫描到的源文件过少，路径可能不对");

    let mut hits = Vec::new();
    for path in files {
        let rel = path
            .strip_prefix(src_root())
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let text = fs::read_to_string(&path).expect("读文件失败");
        for (index, line) in text.lines().enumerate() {
            if is_comment(line) {
                continue;
            }
            if !bare_tables(line).is_empty() {
                hits.push(Hit {
                    file: rel.clone(),
                    line_no: index + 1,
                    text: line.trim().to_string(),
                });
            }
        }
    }
    hits
}

#[test]
fn no_unescaped_bare_orders_or_clients_queries() {
    let hits = collect_hits();
    let mut used = vec![0usize; EXEMPTIONS.len()];
    let mut unclassified = Vec::new();

    for hit in &hits {
        let mut matched = false;
        for (i, ex) in EXEMPTIONS.iter().enumerate() {
            if ex.file == hit.file && hit.text.contains(ex.needle) {
                used[i] += 1;
                matched = true;
            }
        }
        if !matched {
            unclassified.push(format!(
                "{}:{}  {}\n        业务查询必须改用 orders_visible / clients_visible，或走 visibility 守卫",
                hit.file, hit.line_no, hit.text
            ));
        }
    }

    let mut problems = Vec::new();
    if !unclassified.is_empty() {
        problems.push(format!(
            "有 {} 处裸查询没有任何豁免：\n  {}",
            unclassified.len(),
            unclassified.join("\n  ")
        ));
    }
    for (i, ex) in EXEMPTIONS.iter().enumerate() {
        if used[i] != ex.lines {
            problems.push(format!(
                "豁免条目命中数不符（期望 {} 实际 {}）：{} :: {}\n        豁免理由：{}\n        可能原因：查询被改写、被复制，或已删除。请同步更新白名单。",
                ex.lines,
                used[i],
                ex.file,
                ex.kind.as_str(),
                ex.why
            ));
        }
    }

    assert!(
        problems.is_empty(),
        "\nSQL 可见性 lint 失败：\n{}\n",
        problems.join("\n")
    );
}

#[test]
fn exemptions_only_appear_in_files_allowed_for_that_kind() {
    // 分类与文件的对应关系：domain 下只允许「按用途明确」的四类，
    // 备份/诊断/QA 的豁免不许混进业务模块。
    let mut per_file: BTreeMap<&str, Vec<Kind>> = BTreeMap::new();
    for ex in EXEMPTIONS {
        per_file.entry(ex.file).or_default().push(ex.kind);
    }

    for (file, kinds) in &per_file {
        if file.starts_with("domain/") {
            for kind in kinds {
                assert!(
                    matches!(
                        kind,
                        Kind::Idempotency
                            | Kind::TemplateGuard
                            | Kind::GuardedRead
                            | Kind::ExportDynamic
                            | Kind::DisplayJoin
                            | Kind::TrashRead
                    ),
                    "{file} 不该出现 {:?} 类豁免",
                    kind
                );
            }
        }
    }

    assert_eq!(
        per_file.get("backup/manifest.rs").map(|v| v.as_slice()),
        Some(
            [
                Kind::BackupSnapshot,
                Kind::BackupSnapshot,
                Kind::BackupSnapshot,
                Kind::BackupSnapshot,
                Kind::BackupSnapshot,
            ]
            .as_slice()
        ),
        "备份摘要必须全是快照口径"
    );
}

#[test]
fn historical_migrations_are_untouched_snapshots() {
    // v1–v7 是历史快照，不该出现任何业务查询；一旦有人往里加，
    // 就会绕过 lint 的「迁移脚本」豁免。
    let mut files = Vec::new();
    rust_files(&src_root(), &mut files);
    let mut offenders = Vec::new();
    for path in files {
        let rel = path
            .strip_prefix(src_root())
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        // v8 引入可见性视图、v9 与 v13 因加列重建它们：三者都必须读基表。
        if !rel.starts_with("store/migrations/")
            || rel.ends_with("mod.rs")
            || rel.ends_with("v8.rs")
            || rel.ends_with("v9.rs")
            || rel.ends_with("v13.rs")
        {
            continue;
        }
        let text = fs::read_to_string(&path).unwrap();
        for (index, line) in text.lines().enumerate() {
            if is_comment(line) {
                continue;
            }
            if !bare_tables(line).is_empty() {
                offenders.push(format!("{rel}:{}  {}", index + 1, line.trim()));
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "历史迁移里出现裸查询（不应再改历史快照）：\n  {}",
        offenders.join("\n  ")
    );
}

#[test]
fn business_list_modules_reference_visible_views() {
    // 防止「整文件回退」：这些模块负责业务列表/统计，必须至少用到一次视图。
    for (file, view) in [
        ("domain/orders.rs", "orders_visible"),
        ("domain/clients.rs", "clients_visible"),
        ("domain/queue.rs", "orders_visible"),
        ("domain/dashboard.rs", "orders_visible"),
        ("domain/stats.rs", "orders_visible"),
        ("domain/export.rs", "orders_visible"),
    ] {
        let text = fs::read_to_string(src_root().join(file)).unwrap();
        assert!(
            text.contains(view),
            "{file} 里找不到 {view}：业务列表可能被改回基表"
        );
    }
}

#[test]
fn trash_module_reads_hidden_rows_and_says_so() {
    // TRASH_READ 豁免的针对性验证：豁免的前提是「确实在读已删除的行」。
    // 如果哪天有人把它改成视图，回收站会静默变空——这里先红。
    let source = fs::read_to_string(src_root().join("domain/trash.rs")).unwrap();

    assert!(
        !source.contains("orders_visible") && !source.contains("clients_visible"),
        "回收站不得读可见性视图：那会把要恢复的数据过滤掉"
    );

    // 每条读取都必须显式涉及 deleted_at，否则等于把整库当回收站读。
    let with_filter = source.matches("deleted_at IS NOT NULL").count();
    assert!(with_filter >= 4, "回收站查询应带 deleted_at 过滤，实际 {with_filter} 处");

    // 恢复必须同时清掉两列，只清一列会留下「有效但带批次」的脏标记。
    assert_eq!(
        source.matches("SET deleted_at = NULL, deleted_batch = NULL").count(),
        3,
        "恢复订单 1 处 + 恢复客户时订单与客户各 1 处，都要清空两列"
    );
}

#[test]
fn full_scan_queries_are_still_full_scan() {
    // 白名单里最容易被「顺手改掉」的两条，单独钉住：
    // 幂等查询与模板删除守卫都必须保持全量。
    let orders = fs::read_to_string(src_root().join("domain/orders.rs")).unwrap();
    assert!(
        orders.contains("SELECT id FROM orders WHERE request_id = ?1"),
        "request_id 幂等查询被改动：重放请求可能找不到已删除订单"
    );
    assert!(
        !orders.contains("FROM orders_visible WHERE request_id"),
        "幂等查询不得改成视图：删除后重放会重复建单"
    );

    let templates = fs::read_to_string(src_root().join("domain/templates.rs")).unwrap();
    assert!(
        templates.contains("SELECT COUNT(*) FROM orders WHERE stage_template_id = ?1"),
        "模板删除守卫被改动"
    );
    assert!(
        !templates.contains("orders_visible"),
        "模板守卫不得用视图：回收站订单仍持有模板引用"
    );
}
