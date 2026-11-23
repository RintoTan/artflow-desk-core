#!/usr/bin/env python3
"""UX-04：给 QA 数据根播种 52 个客户与配套订单（只写 QA，不碰正式数据）。

用法：python3 scripts/qa-seed-customers.py "<QA generation>/database.sqlite"

约束：只插入，不删除既有数据；编号 AF-YYYY-NNNN 全局唯一；
订单/阶段/事件按 v8+ 真实约束写入。
"""
import sqlite3
import sys
from datetime import date, timedelta

DB = sys.argv[1]
con = sqlite3.connect(DB)
cur = con.cursor()
version = cur.execute("PRAGMA user_version").fetchone()[0]
has_archive = version >= 9
tpl = cur.execute("SELECT id FROM stage_templates WHERE is_default = 1").fetchone()[0]
steps = [r[0] for r in cur.execute(
    "SELECT step_id FROM stage_template_steps WHERE template_id = ? ORDER BY position", (tpl,))]
if len(steps) < 2:
    raise SystemExit("默认模板步数不足")

NOUNS = ["插画", "立绘", "封面", "场景", "头像", "概念图", "商稿"]
TAGS = [("长期合作",), ("新客户",), ("转介绍",), ("展会",)]
tag_ids = []
for (name,) in TAGS:
    row = cur.execute("SELECT id FROM client_tags WHERE name = ?", (name,)).fetchone()
    if row:
        tag_ids.append(row[0])
    else:
        tid = f"tag-{len(tag_ids)+1}"
        cur.execute("INSERT INTO client_tags (id, name, created_at) VALUES (?,?,?)",
                    (tid, name, "2026-09-01T00:00:00+08:00"))
        tag_ids.append(tid)

today = date(2026, 11, 23)
client_ids = []
for i in range(52):
    cid = f"qa-c-{i+1:03d}"
    name = f"QA 客户 {i+1:02d}"
    created = (today - timedelta(days=200 - i)).isoformat()
    cur.execute(
        "INSERT INTO clients (id, display_name, contact, note, revision, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?)",
        (cid, name, f"wx: qa{i+1:02d}" if i % 3 else None,
         "规模测试数据" if i % 4 == 0 else None, 1, created + "T09:00:00+08:00",
         created + "T09:00:00+08:00"))
    client_ids.append(cid)
    if i % 5 == 0:
        cur.execute(
            "INSERT OR IGNORE INTO client_tag_link (client_id, tag_id) VALUES (?,?)",
            (cid, tag_ids[i % len(tag_ids)]))

serial = {"2026": 500, "2025": 500}
order_no = 0
for i, cid in enumerate(client_ids):
    count = [0, 1, 2, 3, 5, 6][i % 6]
    for j in range(count):
        order_no += 1
        year = "2026" if j % 4 else "2025"
        serial[year] += 1
        code = f"AF-{year}-{serial[year]:04d}"
        oid = f"qa-o-{order_no:03d}"
        status = ["active", "complete", "cancelled"][j % 3]
        created = (today - timedelta(days=150 - (i + j) % 120)).isoformat()
        start = (today - timedelta(days=60 - (i + j) % 40)).isoformat()
        delivery = (today + timedelta(days=5 + (i + j) % 40)).isoformat()
        cur.execute(
            """INSERT INTO orders (id, code, title, client_id, amount_cents, status,
                   stage_template_id, current_stage_id, queue_position,
                   planned_start_date, planned_delivery_date, started_at, completed_at,
                   cancelled_at, revision, created_at, updated_at, source)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (oid, code, f"{NOUNS[(i + j) % len(NOUNS)]} {i+1:02d}-{j+1}", cid, 60000 + 10000 * j,
             status, tpl, steps[min(j, len(steps) - 1)], j,
             start, delivery,
             start + "T09:00:00+08:00" if status != "active" else None,
             created + "T18:00:00+08:00" if status == "complete" else None,
             created + "T18:00:00+08:00" if status == "cancelled" else None,
             1, created + "T09:00:00+08:00", created + "T09:00:00+08:00", "米画师"))
        for k, step in enumerate(steps):
            cur.execute(
                "INSERT INTO order_stages (order_id, stage_id, title, position)"
                " VALUES (?,?,?,?)", (oid, step, step, k))
        cur.execute(
            "INSERT INTO order_events (order_id, kind, to_status, occurred_at, request_id)"
            " VALUES (?,?,?,?,?)",
            (oid, "created", "active", created + "T09:00:00+08:00", f"qa-{order_no}"))
        # 每个客户的第 3、6 单做成已归档（仅 v9 有该列）
        if has_archive and j in (2, 5) and status == "complete":
            cur.execute("UPDATE orders SET archived_at = ? WHERE id = ?",
                        (created + "T19:00:00+08:00", oid))

con.commit()
print("clients:", cur.execute("SELECT COUNT(*) FROM clients").fetchone()[0])
print("orders:", cur.execute("SELECT COUNT(*) FROM orders").fetchone()[0])
print("events:", cur.execute("SELECT COUNT(*) FROM order_events").fetchone()[0])
if has_archive:
    print("archived:", cur.execute("SELECT COUNT(*) FROM orders WHERE archived_at IS NOT NULL").fetchone()[0])
else:
    print("archived: skipped (schema v8)")
con.close()
