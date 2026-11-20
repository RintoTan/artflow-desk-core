import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import ConfirmDialog from "../components/ConfirmDialog";
import {
  describeError,
  trashApi,
  type PurgeCleanupStatus,
  type TrashGroup,
  type TrashOrder,
  type TrashSnapshot,
} from "../bridge/commands";
import { useQaRefresh } from "../lib/qaRefresh";
import { workStateLabel } from "../lib/workState";

/**
 * 回收站：查看、恢复、永久删除、清空。
 *
 * 两条不可让步的规则：
 * 1. 客户组只能整批操作——组内订单不提供单独入口，否则会出现「客户还在回收站、
 *    订单却已经回来」的半条链。
 * 2. 数据库删除与附件清理是两件事，结果必须分开报告；文件没清干净时不能说「全部完成」。
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

const EMPTY_CONFIRM_TEXT = "清空回收站";

/**
 * 批次完整性异常单独给一句人能读懂的话：它不是「再点一次就好了」的冲突，
 * 而应当先备份再排查。恢复与永久删除都可能遇到，所以两处共用。
 */
function describeTrashError(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  if (code === "INTEGRITY") {
    return "数据完整性检查未通过，操作已中止。建议先导出备份再联系支持。";
  }
  return describeError(error);
}

/** 清空结果：只留展示需要的内容，失败批次逐条列出。 */
/**
 * 清空结果只保留**数据库**维度。
 * 附件清理是全局状态（同一次清空之后还可能有别的任务失败，反之亦然），
 * 统一由 `cleanupStatus` 提供，不在这里混入本次批次的数字。
 */
type EmptySummary = {
  okBatches: number;
  ordersPurged: number;
  failed: { label: string; error: string }[];
};

type PurgeTarget =
  | { kind: "order"; order: TrashOrder }
  | { kind: "group"; group: TrashGroup };

function OrderRow({
  order,
  showDeletedAt,
  actions,
}: {
  order: TrashOrder;
  showDeletedAt: boolean;
  actions?: React.ReactNode;
}) {
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
        {actions}
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

  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<TrashGroup | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);

  const [purgeTarget, setPurgeTarget] = useState<PurgeTarget | null>(null);
  const [purgeBusy, setPurgeBusy] = useState(false);
  const [purgeError, setPurgeError] = useState<string | null>(null);

  const [emptyOpen, setEmptyOpen] = useState(false);
  const [emptyText, setEmptyText] = useState("");
  const [emptyBusy, setEmptyBusy] = useState(false);
  const [emptyError, setEmptyError] = useState<string | null>(null);
  /**
   * 「重试未完成」是在确认框关闭之后调用的，错误不能塞进 emptyError——
   * 那个只会在对话框里渲染，用户永远看不到。这里单独存一份给结果条。
   */
  const [emptyRetryError, setEmptyRetryError] = useState<string | null>(null);
  const [emptySummary, setEmptySummary] = useState<EmptySummary | null>(null);

  const emptyInFlight = useRef(false);
  const purgeInFlight = useRef(false);

  const refreshQa = useQaRefresh();
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

  /**
   * 重新读取回收站与附件清理状态。
   *
   * 先让旧状态失效：新的一次读取返回之前，页面不能拿旧的 `failed === 0`
   * 去说「全部完成」——对不可逆操作来说，短暂的错误成功反馈也不该出现。
   */
  const reload = useCallback(() => {
    // 立刻进入加载态：旧快照在新数据回来之前不能再被拿来操作。
    setLoading(true);
    setCleanup(null);
    setCleanupError(null);
    setReloading((n) => n + 1);
  }, []);

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
      // 重试失败后旧数字不再可信：清掉它，只留「状态不可用」，避免两个口径同时出现。
      setCleanup(null);
      setCleanupError(describeError(error));
    } finally {
      setRetrying(false);
    }
  }, []);

  /** 独立订单恢复：可逆操作，不弹确认。 */
  const restoreOrder = useCallback(
    async (order: TrashOrder) => {
      if (busyOrderId) return;
      setBusyOrderId(order.id);
      setActionError(null);
      setNotice(null);
      try {
        await trashApi.restoreOrder(order.id);
        setNotice(`已恢复订单 ${order.code}`);
        reload();
        refreshQa();
      } catch (error) {
        setActionError(describeTrashError(error));
      } finally {
        setBusyOrderId(null);
      }
    },
    [busyOrderId, refreshQa, reload],
  );

  /** 客户组整批恢复：先确认，服务端按批次带回全部订单。 */
  const restoreGroup = useCallback(async () => {
    if (!restoreTarget || restoreBusy) return;
    const target = restoreTarget;
    setRestoreBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const result = await trashApi.restoreClient(target.clientId);
      setRestoreTarget(null);
      setNotice(
        result.ordersRestored > 0
          ? `已恢复客户「${target.clientName}」及其 ${result.ordersRestored} 个订单`
          : `已恢复客户「${target.clientName}」`,
      );
      reload();
      refreshQa();
    } catch (error) {
      setActionError(describeTrashError(error));
      setRestoreTarget(null);
    } finally {
      setRestoreBusy(false);
    }
  }, [restoreTarget, restoreBusy, refreshQa, reload]);

  const purgeTargetLabel = purgeTarget
    ? purgeTarget.kind === "order"
      ? `订单「${purgeTarget.order.code}」`
      : `客户「${purgeTarget.group.clientName}」`
    : "";

  const purgeOrderCount =
    purgeTarget === null ? 0 : purgeTarget.kind === "order" ? 1 : purgeTarget.group.orders.length;

  const purgeAttachmentCount =
    purgeTarget === null
      ? 0
      : purgeTarget.kind === "order"
        ? purgeTarget.order.attachmentCount
        : purgeTarget.group.orders.reduce((sum, order) => sum + order.attachmentCount, 0);

  /** 永久删除：数据库删除与附件清理分开报告，失败不粉饰。 */
  const runPurge = useCallback(async () => {
    if (!purgeTarget || purgeInFlight.current) return;
    purgeInFlight.current = true;
    setPurgeBusy(true);
    setPurgeError(null);
    setNotice(null);
    try {
      const result =
        purgeTarget.kind === "order"
          ? await trashApi.purgeOrder(purgeTarget.order.id)
          : await trashApi.purgeClient(purgeTarget.group.clientId);

      setPurgeTarget(null);
      setNotice(
        result.cleanup.pending > 0
          ? `已永久删除；${result.cleanup.pending} 个附件文件未清理，可在顶部提示中重试`
          : "已永久删除，附件文件已清理",
      );
      reload();
      refreshQa();
    } catch (error) {
      setPurgeError(describeTrashError(error));
    } finally {
      purgeInFlight.current = false;
      setPurgeBusy(false);
    }
  }, [purgeTarget, refreshQa, reload]);

  /**
   * 清空回收站。后端逐批提交，所以成功与失败必须分别展示。
   * 重试复用这个函数：已清空的批次不存在了，再调一次就等于只处理剩下的。
   */
  const runEmpty = useCallback(async () => {
    if (emptyInFlight.current) return;
    emptyInFlight.current = true;
    setEmptyBusy(true);
    setEmptyError(null);
    setEmptyRetryError(null);
    try {
      const result = await trashApi.empty();
      const ok = result.batches.filter((batch) => batch.ok);
      const failed = result.batches.filter((batch) => !batch.ok);
      setEmptySummary({
        okBatches: ok.length,
        ordersPurged: ok.reduce((sum, batch) => sum + batch.ordersPurged, 0),
        failed: failed.map((batch) => ({
          label: batch.label,
          error: batch.error ?? "未知原因",
        })),
      });
      setEmptyOpen(false);
      setEmptyText("");
      reload();
      refreshQa();
    } catch (error) {
      const message = describeError(error);
      // 对话框还开着时写在对话框里；已经关掉（重试路径）就写在结果条里。
      setEmptyError(message);
      setEmptyRetryError(message);
    } finally {
      emptyInFlight.current = false;
      setEmptyBusy(false);
    }
  }, [refreshQa, reload]);

  const isEmpty = useMemo(
    () => snapshot !== null && snapshot.groupCount === 0 && snapshot.looseOrderCount === 0,
    [snapshot],
  );

  // 加载中时旧数据不算数：清空按钮不能在这期间被再次打开。
  const hasEntries = !loading && snapshot !== null && !isEmpty;
  const confirmTextMatches = emptyText === EMPTY_CONFIRM_TEXT;

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
        {hasEntries ? (
          <button
            type="button"
            className="btn btn-quiet-danger"
            disabled={loading || emptyBusy}
            onClick={() => {
              setEmptyText("");
              setEmptyError(null);
              setEmptyOpen(true);
            }}
          >
            清空回收站…
          </button>
        ) : null}
      </header>

      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}
      {actionError ? <p className="notice notice-error">{actionError}</p> : null}

      {emptySummary ? (
        <div className="trash-result" role="status">
          {/* 文本与按钮分开成两块：文字纵向排列，按钮不再挤压正文。 */}
          <div className="trash-result-copy">
          <p>
            数据库：已永久删除 {emptySummary.okBatches} 批
            {emptySummary.ordersPurged > 0 ? `、共 ${emptySummary.ordersPurged} 个订单` : ""}
            {emptySummary.failed.length > 0
              ? `；${emptySummary.failed.length} 批失败：${emptySummary.failed
                  .map((batch) => `${batch.label}（${batch.error}）`)
                  .join("、")}。`
              : "。"}
          </p>
          {cleanup && cleanup.failed > 0 ? (
            <p className="muted">
              附件清理：当前全局仍有 {cleanup.failed} 个清理任务失败，可在顶部「附件清理未完成」中重试。
            </p>
          ) : null}
          {emptySummary.failed.length === 0 && cleanup !== null && cleanup.failed === 0 ? (
            <p className="muted">全部完成。</p>
          ) : null}
          {emptyRetryError && !emptyOpen ? (
            <p className="notice notice-error">重试未成功：{emptyRetryError}</p>
          ) : null}
          </div>
          {emptySummary.failed.length > 0 ? (
            <button
              type="button"
              className="btn"
              onClick={() => void runEmpty()}
              disabled={emptyBusy}
            >
              {emptyBusy ? "正在重试…" : "重试未完成"}
            </button>
          ) : null}
        </div>
      ) : null}

      {cleanupError ? (
        <div className="trash-cleanup-unavailable">
          <p className="muted">附件清理状态暂时不可用：{cleanupError}</p>
          {/* 重试失败后 cleanup 会被清空，重试按钮也随之消失；
              这里给一个不依赖 failed 的入口，否则用户只能重启应用。 */}
          <button type="button" className="btn btn-sm" onClick={reload}>
            重新读取状态
          </button>
        </div>
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
          <button className="btn" type="button" onClick={reload}>
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
                      <span className="trash-actions">
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => setRestoreTarget(group)}
                        >
                          整批恢复
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-quiet-danger"
                          onClick={() => {
                            setPurgeError(null);
                            setPurgeTarget({ kind: "group", group });
                          }}
                        >
                          永久删除
                        </button>
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
                  <OrderRow
                    key={order.id}
                    order={order}
                    showDeletedAt
                    actions={
                      <span className="trash-actions">
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busyOrderId === order.id}
                          onClick={() => void restoreOrder(order)}
                        >
                          {busyOrderId === order.id ? "正在恢复…" : "恢复订单"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-quiet-danger"
                          onClick={() => {
                            setPurgeError(null);
                            setPurgeTarget({ kind: "order", order });
                          }}
                        >
                          永久删除
                        </button>
                      </span>
                    }
                  />
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}

      <ConfirmDialog
        open={restoreTarget !== null}
        title="整批恢复客户？"
        confirmLabel="整批恢复"
        busy={restoreBusy}
        onCancel={() => {
          if (restoreBusy) return;
          setRestoreTarget(null);
        }}
        onConfirm={restoreGroup}
      >
        <p>
          将恢复客户「{restoreTarget?.clientName ?? ""}」及其 {restoreTarget?.orders.length ?? 0}{" "}
          个订单。
        </p>
        <p className="muted">此前单独删除、后来并入该客户组的订单也会一起恢复。</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={purgeTarget !== null}
        title="永久删除？"
        confirmLabel="永久删除"
        danger
        busy={purgeBusy}
        error={purgeError}
        onCancel={() => {
          if (purgeBusy) return;
          setPurgeTarget(null);
          setPurgeError(null);
        }}
        onConfirm={runPurge}
      >
        <p>
          {purgeTargetLabel}、{purgeOrderCount} 个订单
          {purgeAttachmentCount > 0 ? `、${purgeAttachmentCount} 项附件` : ""}将被永久删除，
          <strong>无法恢复</strong>。
        </p>
        <p className="muted">附件文件会进入清理流程；若个别文件清理失败，可以稍后重试。</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={emptyOpen}
        title="清空回收站？"
        confirmLabel="永久删除"
        danger
        busy={emptyBusy}
        error={emptyError}
        confirmDisabled={!confirmTextMatches}
        onCancel={() => {
          if (emptyBusy) return;
          setEmptyOpen(false);
          setEmptyText("");
          setEmptyError(null);
        }}
        onConfirm={runEmpty}
      >
        <p>此操作不可撤销，以下记录将被永久删除：</p>
        <ul className="purge-counts">
          <li>
            <span>客户组</span>
            <strong>{snapshot?.groupCount ?? 0} 个</strong>
          </li>
          <li>
            <span>独立订单</span>
            <strong>{snapshot?.looseOrderCount ?? 0} 个</strong>
          </li>
          <li>
            <span>涉及订单总数</span>
            <strong>{snapshot?.totalOrderCount ?? 0} 个</strong>
          </li>
        </ul>
        <p className="muted">关联附件将进入清理流程。若部分文件清理失败，可以稍后重试。</p>
        <label className="field">
          <span>输入「{EMPTY_CONFIRM_TEXT}」以继续</span>
          <input
            value={emptyText}
            onChange={(event) => setEmptyText(event.target.value)}
            aria-label="清空确认文字"
            disabled={emptyBusy}
          />
        </label>
      </ConfirmDialog>
    </section>
  );
}
