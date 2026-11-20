import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { describeError, trashApi, type PurgeCleanupStatus, type TrashOrder, type TrashSnapshot } from "../bridge/commands";
import { workStateLabel } from "../lib/workState";

/**
 * 回收站（D3：只读展示）。
 *
 * 本阶段只呈现数据与「附件清理未完成」的重试，不提供删除、恢复、永久删除、清空。
 * 所有计数直接用后端返回的三段数字，不在前端做加减——否则页头与列表迟早会不一致。
 */

/** 本地日期口径：回收站展示的是「哪一天删的」，不能拿 UTC 字符串直接截断。 */
function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso.slice(0, 10);
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function OrderRow({ order, showDeletedAt }: { order: TrashOrder; showDeletedAt: boolean }) {
  return (
    <li className="trash-order">
      <div className="trash-order-main">
        <span className="trash-order-code">{order.code}</span>
        <span className="trash-order-title">{order.title}</span>
      </div>
      <div className="trash-order-meta">
        {order.originalClientName ? (
          <span className="trash-order-client">原客户：{order.originalClientName}</span>
        ) : null}
        <span>{workStateLabel(order.workState)}</span>
        {showDeletedAt ? <span>删除于 {formatDay(order.deletedAt)}</span> : null}
        {/* 附件是记录数：一条记录对应原图 + 缩略图，不能写成「个文件」。 */}
        {order.attachmentCount > 0 ? <span>{order.attachmentCount} 项附件</span> : null}
      </div>
    </li>
  );
}

export default function TrashPage() {
  const [snapshot, setSnapshot] = useState<TrashSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [cleanup, setCleanup] = useState<PurgeCleanupStatus | null>(null);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(0);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [retrying, setRetrying] = useState(false);

  const location = useLocation();
  const navigate = useNavigate();
  // 只有明确从设置页点进来才用历史返回；直接访问 #/trash 时历史里没有「上一页」。
  const cameFromSettings =
    (location.state as { from?: string } | null)?.from === "settings";

  const goBack = useCallback(() => {
    if (cameFromSettings) {
      navigate(-1);
      return;
    }
    // replace：不要为「一次直接访问」留下两条历史，否则后退会回到自己。
    navigate("/settings", { replace: true });
  }, [cameFromSettings, navigate]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setSnapshotError(null);

    // 主体与清理状态分开处理：清理状态读不到，不该让整个列表打不开。
    void (async () => {
      const [snap, status] = await Promise.allSettled([
        trashApi.snapshot(),
        trashApi.cleanupStatus(),
      ]);
      if (!alive) return;

      if (snap.status === "fulfilled") {
        setSnapshot(snap.value);
        // 只有一个客户组时直接展开；多组时先给总览。
        const only = snap.value.groups.length === 1 ? snap.value.groups[0] : null;
        setExpanded(only ? [only.clientId] : []);
      } else {
        setSnapshot(null);
        setSnapshotError(describeError(snap.reason));
      }

      if (status.status === "fulfilled") {
        setCleanup(status.value);
        setCleanupError(null);
      } else {
        setCleanup(null);
        setCleanupError(describeError(status.reason));
      }
      setLoading(false);
    })();

    return () => {
      alive = false;
    };
  }, [reloading]);

  const toggle = useCallback((clientId: string) => {
    setExpanded((current) =>
      current.includes(clientId) ? current.filter((id) => id !== clientId) : [...current, clientId],
    );
  }, []);

  const retryCleanup = useCallback(async () => {
    setRetrying(true);
    try {
      const status = await trashApi.retryCleanup();
      setCleanup(status);
      setCleanupError(null);
    } catch (error) {
      setCleanupError(describeError(error));
    } finally {
      setRetrying(false);
    }
  }, []);

  const isEmpty = useMemo(
    () => snapshot !== null && snapshot.groupCount === 0 && snapshot.looseOrderCount === 0,
    [snapshot],
  );

  return (
    <section className="panel" aria-labelledby="trash-title">
      <button type="button" className="trash-back" onClick={goBack}>
        ← 返回设置
      </button>

      <header className="panel-head">
        <div>
          <h2 id="trash-title">回收站</h2>
          <p className="muted">删除的订单与客户会保留在这里，直到你手动清空。</p>
          {snapshot && !isEmpty ? (
            <p className="trash-counts">
              {snapshot.groupCount} 个客户组 · {snapshot.looseOrderCount} 个独立订单 · 共{" "}
              {snapshot.totalOrderCount} 个订单
            </p>
          ) : null}
        </div>
      </header>

      {cleanupError ? (
        <p className="muted trash-cleanup-unavailable">附件清理状态暂时不可用：{cleanupError}</p>
      ) : null}

      {cleanup && cleanup.failed > 0 ? (
        <div className="trash-cleanup-note" role="status">
          <div>
            <strong>附件清理未完成</strong>
            <p className="muted">
              有 {cleanup.failed} 个附件文件尚未成功清理。对应的订单记录已永久删除，你可以手动重试清理。
            </p>
          </div>
          <button className="btn" type="button" onClick={retryCleanup} disabled={retrying}>
            {retrying ? "正在重试…" : "重试附件清理"}
          </button>
        </div>
      ) : null}

      {loading ? <p className="muted">正在读取回收站…</p> : null}

      {!loading && snapshotError ? (
        <div className="panel panel-error trash-error">
          <p className="muted">{snapshotError}</p>
          <button className="btn" type="button" onClick={() => setReloading((n) => n + 1)}>
            重新读取
          </button>
        </div>
      ) : null}

      {!loading && !snapshotError && isEmpty ? (
        <div className="trash-empty">
          <strong>回收站是空的</strong>
          <p className="muted">现在没有任何已删除的记录。</p>
        </div>
      ) : null}

      {!loading && !snapshotError && snapshot && !isEmpty ? (
        <>
          {snapshot.groups.length > 0 ? (
            <ul className="trash-groups">
              {snapshot.groups.map((group) => {
                const open = expanded.includes(group.clientId);
                const groupDay = formatDay(group.deletedAt);
                return (
                  <li key={group.clientId} className="trash-group">
                    <div className="trash-group-head">
                      <button
                        className="trash-group-toggle"
                        type="button"
                        aria-expanded={open}
                        aria-controls={`trash-group-${group.clientId}`}
                        onClick={() => toggle(group.clientId)}
                        title={group.clientName}
                      >
                        <span
                          className={`trash-group-caret${open ? " is-open" : ""}`}
                          aria-hidden="true"
                        >
                          ›
                        </span>
                        <span className="trash-group-name">{group.clientName}</span>
                      </button>
                      <span className="trash-group-meta">
                        删除于 {groupDay} ·{" "}
                        {group.orders.length > 0
                          ? `同批 ${group.orders.length} 个订单`
                          : "无关联订单"}
                      </span>
                    </div>

                    {open ? (
                      group.orders.length === 0 ? (
                        <p className="muted trash-group-empty">该客户名下没有订单。</p>
                      ) : (
                        <ul className="trash-orders" id={`trash-group-${group.clientId}`}>
                          {group.orders.map((order) => (
                            <OrderRow
                              key={order.id}
                              order={order}
                              // 与客户组同一天就不重复显示日期，减少噪音。
                              showDeletedAt={formatDay(order.deletedAt) !== groupDay}
                            />
                          ))}
                        </ul>
                      )
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}

          {snapshot.looseOrders.length > 0 ? (
            <div className="trash-loose">
              <h3 className="trash-loose-title">独立订单</h3>
              <ul className="trash-orders">
                {snapshot.looseOrders.map((order) => (
                  <OrderRow key={order.id} order={order} showDeletedAt />
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
