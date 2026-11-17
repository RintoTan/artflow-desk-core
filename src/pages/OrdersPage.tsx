import { useCallback, useEffect, useMemo, useState } from "react";
import { useBlocker } from "react-router-dom";

import AttachmentPanel from "../components/AttachmentPanel";
import ConfirmDialog from "../components/ConfirmDialog";
import UnsavedChangesDialog from "../components/UnsavedChangesDialog";
import { densityClass, dropIndex, filterOrders, type StatusFilter } from "../lib/ordersView";
import {
  api,
  describeError,
  isConflict,
  newRequestId,
  preferenceApi,
  queueApi,
  type ClientView,
  type ListDensity,
  type CreateOrderInput,
  type OrderEvent,
  type OrderView,
  type UpdateDetailsInput,
} from "../bridge/commands";

// ---------------------------------------------------------------- 展示辅助

const STATUS_LABEL: Record<string, string> = {
  active: "活动",
  complete: "已完成",
  cancelled: "已取消",
};

const WORK_LABEL: Record<string, string> = {
  queued: "排队中",
  inProgress: "制作中",
  completed: "已完成",
  cancelled: "已取消",
};

const EVENT_LABEL: Record<string, string> = {
  created: "创建订单",
  work_started: "开始制作",
  work_start_undone: "撤销开工",
  stage_advanced: "推进阶段",
  stage_reworked: "返工",
  workflow_changed: "修改流程",
  completed: "完成",
  cancelled: "取消",
  reopened: "重新打开",
};

function formatMoney(cents: number | null): string {
  if (cents === null) return "金额未知";
  return `¥ ${(cents / 100).toFixed(2)}`;
}

function yuanToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new Error("金额只能是最多两位小数的非负数");
  }
  const [whole, fraction = ""] = trimmed.split(".");
  return Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
}

function centsToYuan(cents: number | null): string {
  if (cents === null) return "";
  return (cents / 100).toFixed(2).replace(/\.00$/, "");
}

function useTimeFormatter(timezone: string | null) {
  return useCallback(
    (iso: string | null): string => {
      if (!iso) return "—";
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return iso;
      try {
        return new Intl.DateTimeFormat("zh-CN", {
          timeZone: timezone ?? undefined,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }).format(date);
      } catch {
        return date.toLocaleString("zh-CN");
      }
    },
    [timezone],
  );
}

// ---------------------------------------------------------------- 类型

type Draft = {
  title: string;
  clientId: string;
  commissionType: string;
  amount: string;
  startDate: string;
  deliveryDate: string;
  note: string;
};

function draftFrom(order: OrderView): Draft {
  return {
    title: order.title,
    clientId: order.clientId ?? "",
    commissionType: order.commissionType ?? "",
    amount: centsToYuan(order.amountCents),
    startDate: order.plannedStartDate ?? "",
    deliveryDate: order.plannedDeliveryDate ?? "",
    note: order.note ?? "",
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.title === b.title &&
    a.clientId === b.clientId &&
    a.commissionType === b.commissionType &&
    a.amount === b.amount &&
    a.startDate === b.startDate &&
    a.deliveryDate === b.deliveryDate &&
    a.note === b.note
  );
}

type PendingAction = {
  title: string;
  detail: string;
  confirmLabel: string;
  run: () => Promise<void>;
};

type PendingNav =
  | { kind: "order"; orderId: string }
  | { kind: "create" }
  | { kind: "route" };

// ---------------------------------------------------------------- 主页面

export default function OrdersPage() {
  const [orders, setOrders] = useState<OrderView[]>([]);
  const [clients, setClients] = useState<ClientView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrderView | null>(null);
  const [events, setEvents] = useState<OrderEvent[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [timezone, setTimezone] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [density, setDensity] = useState<ListDensity>("comfortable");
  const [queueRev, setQueueRev] = useState(0);
  const [dragging, setDragging] = useState<{ orderId: string; fromIndex: number } | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [manualNav, setManualNav] = useState<PendingNav | null>(null);
  const [guardBusy, setGuardBusy] = useState(false);
  const [guardError, setGuardError] = useState<string | null>(null);

  const dirty = useMemo(() => {
    if (!detail || !draft) return false;
    return !sameDraft(draft, draftFrom(detail));
  }, [detail, draft]);

  const blocker = useBlocker(dirty);
  const formatTime = useTimeFormatter(timezone);

  const loadList = useCallback(async () => {
    const [list, clientList] = await Promise.all([api.listOrders(), api.listClients()]);
    setOrders(list);
    setClients(clientList);
    return list;
  }, []);

  const selectOrder = useCallback(
    async (orderId: string) => {
      setError(null);
      setNotice(null);
      setDraftError(null);
      try {
        const [order, history] = await Promise.all([
          api.getOrder(orderId),
          api.listOrderEvents(orderId),
        ]);
        setSelectedId(orderId);
        setDetail(order);
        setEvents(history);
        setDraft(draftFrom(order));
        setCreating(false);
      } catch (e) {
        setError(describeError(e));
      }
    },
    [],
  );

  const refresh = useCallback(
    async (orderId: string) => {
      const [order, history, list] = await Promise.all([
        api.getOrder(orderId),
        api.listOrderEvents(orderId),
        api.listOrders(),
      ]);
      setDetail(order);
      setEvents(history);
      setOrders(list);
      setDraft(draftFrom(order));
      return order;
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [list, clientList, status, queue, densityValue] = await Promise.all([
          api.listOrders(),
          api.listClients(),
          api.status(),
          queueApi.list(),
          preferenceApi.get("list_density"),
        ]);
        if (!alive) return;
        setOrders(list);
        setClients(clientList);
        setTimezone(status.workingTimezone);
        setQueueRev(queue.revision);
        if (densityValue === "compact" || densityValue === "comfortable") {
          setDensity(densityValue);
        }
        if (list.length > 0 && list[0]) {
          await selectOrder(list[0].id);
        }
      } catch (e) {
        if (alive) setError(describeError(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [selectOrder]);

  const visible = useMemo(
    () => filterOrders(orders, { query, status: statusFilter }),
    [orders, query, statusFilter],
  );
  const activeQueue = useMemo(
    () =>
      orders
        .filter((order) => order.status === "active")
        .sort((a, b) => a.queuePosition - b.queuePosition),
    [orders],
  );

  async function applyQueueMove(orderId: string, toIndex: number) {
    setBusy(true);
    setError(null);
    try {
      const snap = await queueApi.move({
        orderId,
        expectedQueueRevision: queueRev,
        toIndex,
      });
      setQueueRev(snap.revision);
      setOrders(await api.listOrders());
    } catch (e) {
      setError(describeError(e));
      if (isConflict(e)) {
        const snap = await queueApi.list().catch(() => null);
        if (snap) setQueueRev(snap.revision);
        setOrders(await api.listOrders().catch(() => orders));
      }
    } finally {
      setBusy(false);
    }
  }

  function shiftQueue(orderId: string, delta: number) {
    const index = activeQueue.findIndex((order) => order.id === orderId);
    if (index < 0) return;
    const target = index + delta;
    if (target < 0 || target >= activeQueue.length) return;
    void applyQueueMove(orderId, target);
  }

  async function toggleDensity() {
    const next: ListDensity = density === "compact" ? "comfortable" : "compact";
    setDensity(next);
    try {
      await preferenceApi.set("list_density", next);
    } catch (e) {
      setError(describeError(e));
    }
  }

  // 指针拖拽：在 window 上收尾，指针移出列表也能结束拖动。
  useEffect(() => {
    if (!dragging) return;
    const finish = () => {
      const target = hoverIndex;
      const from = dragging.fromIndex;
      const orderId = dragging.orderId;
      setDragging(null);
      setHoverIndex(null);
      if (target === null) return;
      const next = dropIndex(from, target, activeQueue.length);
      if (next === null) return;
      void applyQueueMove(orderId, next);
    };
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  });

  // ---------------------------------------------------------------- 动作

  async function saveDraft(): Promise<string | null> {
    if (!detail || !draft) return "当前没有可保存的订单";
    setBusy(true);
    setDraftError(null);
    try {
      const amountCents = yuanToCents(draft.amount);
      const input: UpdateDetailsInput = {
        orderId: detail.id,
        expectedRevision: detail.revision,
        title: draft.title,
        clientId: draft.clientId === "" ? null : draft.clientId,
        commissionType: draft.commissionType.trim() === "" ? null : draft.commissionType,
        amountCents,
        plannedStartDate: draft.startDate === "" ? null : draft.startDate,
        plannedDeliveryDate: draft.deliveryDate === "" ? null : draft.deliveryDate,
        note: draft.note.trim() === "" ? null : draft.note,
      };
      const updated = await api.updateOrderDetails(input);
      await refresh(updated.id);
      setNotice("资料已保存");
      return null;
    } catch (e) {
      if (isConflict(e)) {
        setDraftError(`${describeError(e)} 已重新载入最新数据，你的修改仍保留在表单中。`);
        try {
          const latest = await api.getOrder(detail.id);
          setDetail(latest);
          const latestEvents = await api.listOrderEvents(detail.id);
          setEvents(latestEvents);
        } catch {
          /* 保留原有错误提示 */
        }
      } else {
        setDraftError(describeError(e));
      }
      return `${describeError(e)} 草稿仍保留在表单中。`;
    } finally {
      setBusy(false);
    }
  }

  async function runLifecycle(
    label: string,
    call: (order: OrderView) => Promise<OrderView>,
  ): Promise<void> {
    if (!detail) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await call(detail);
      await refresh(updated.id);
      setNotice(label);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  function openCreate() {
    setCreating(true);
    setSelectedId(null);
    setDetail(null);
    setDraft(null);
    setEvents([]);
    setError(null);
    setNotice(null);
  }

  function attemptSelect(orderId: string) {
    if (orderId === selectedId && !creating) return;
    if (dirty) {
      setGuardError(null);
      setManualNav({ kind: "order", orderId });
      return;
    }
    void selectOrder(orderId);
  }

  function attemptCreate() {
    if (dirty) {
      setGuardError(null);
      setManualNav({ kind: "create" });
      return;
    }
    openCreate();
  }

  // 路由级离页与手动切换共用同一个对话框：
  // 路由被 blocker 拦下时对话框"就是打开状态"，不额外维护一份状态，
  // 避免 reset/proceed 与本地状态更新的时序竞争导致对话框重新弹出。
  const routeBlocked = blocker.state === "blocked";
  const dialogOpen = routeBlocked || manualNav !== null;
  const pendingNav: PendingNav | null = manualNav ?? (routeBlocked ? { kind: "route" } : null);

  function leaveTo(nav: PendingNav) {
    if (nav.kind === "route") {
      blocker.proceed?.();
      return;
    }
    if (nav.kind === "create") {
      openCreate();
      return;
    }
    void selectOrder(nav.orderId);
  }

  function handleStay() {
    setGuardError(null);
    setManualNav(null);
    if (routeBlocked) blocker.reset?.();
  }

  async function handleDiscard() {
    if (guardBusy) return;
    const nav = pendingNav;
    if (!nav) return;
    setGuardBusy(true);
    try {
      setGuardError(null);
      if (nav.kind === "route") {
        blocker.proceed?.();
      } else {
        setDraft(null);
        setManualNav(null);
        leaveTo(nav);
      }
    } finally {
      setGuardBusy(false);
    }
  }

  async function handleSaveAndLeave() {
    if (guardBusy) return;
    const nav = pendingNav;
    if (!nav) return;
    setGuardBusy(true);
    setGuardError(null);
    try {
      const failure = await saveDraft();
      if (failure) {
        // 保存失败：对话框保持打开，草稿不动。
        setGuardError(failure);
        return;
      }
      if (nav.kind === "route") {
        blocker.proceed?.();
      } else {
        setManualNav(null);
        leaveTo(nav);
      }
    } finally {
      setGuardBusy(false);
    }
  }

  // ---------------------------------------------------------------- 渲染

  if (loading) {
    return <section className="panel">正在读取订单…</section>;
  }

  return (
    <div className="orders-layout">
      <aside className="orders-list panel">
        <header className="panel-head compact">
          <div>
            <h2>订单</h2>
            <p className="muted">
              {visible.length}/{orders.length} 张 · 活动在前
            </p>
          </div>
          <button type="button" className="btn btn-primary btn-sm" onClick={attemptCreate}>
            新建
          </button>
        </header>

        <div className="list-tools">
          <input
            className="list-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题 / 编号 / 客户"
            aria-label="搜索订单"
          />
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => void toggleDensity()}
            aria-pressed={density === "compact"}
            title={density === "compact" ? "切换到舒适模式" : "切换到紧凑模式"}
          >
            {density === "compact" ? "紧凑" : "舒适"}
          </button>
        </div>

        <div className="filter-row" role="group" aria-label="按状态筛选">
          {(
            [
              ["all", "全部"],
              ["active", "活动"],
              ["complete", "已完成"],
              ["cancelled", "已取消"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`filter-chip${statusFilter === value ? " filter-chip-active" : ""}`}
              aria-pressed={statusFilter === value}
              onClick={() => setStatusFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>

        {visible.length === 0 ? (
          <div className="empty">
            <p>{orders.length === 0 ? "还没有订单。" : "没有符合筛选条件的订单。"}</p>
            {orders.length === 0 && <p className="muted">点击「新建」创建第一张委托。</p>}
          </div>
        ) : (
          <ul className={`order-rows ${densityClass(density)}`}>
            {visible.map((order) => {
              const queueIndex = activeQueue.findIndex((item) => item.id === order.id);
              const canReorder = order.status === "active" && statusFilter !== "complete" && statusFilter !== "cancelled";
              return (
                <li
                  key={order.id}
                  onPointerEnter={() => {
                    if (!dragging || !canReorder) return;
                    setHoverIndex(queueIndex);
                  }}
                  className={[
                    dragging?.orderId === order.id ? "row-dragging" : "",
                    dragging && hoverIndex === queueIndex && dragging.orderId !== order.id
                      ? "row-drop-target"
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ") || undefined}
                >
                  {canReorder && (
                    <button
                      type="button"
                      className="drag-handle"
                      aria-label={`拖动 ${order.code} 调整队列位置`}
                      title="按住拖到目标位置"
                      disabled={busy}
                      onPointerDown={(event) => {
                        if (busy) return;
                        event.preventDefault();
                        setDragging({ orderId: order.id, fromIndex: queueIndex });
                        setHoverIndex(queueIndex);
                      }}
                    >
                      ⠿
                    </button>
                  )}
                  <button
                    type="button"
                    className={`order-row${order.id === selectedId ? " order-row-active" : ""}`}
                    onClick={() => attemptSelect(order.id)}
                  >
                    <span className="order-row-top">
                      <code className="order-code">{order.code}</code>
                      <span className={`chip chip-${order.status}`}>{STATUS_LABEL[order.status]}</span>
                    </span>
                    <span className="order-row-title">{order.title}</span>
                    <span className="order-row-meta">
                      <span className={`dot dot-${order.workState}`} />
                      {WORK_LABEL[order.workState]}
                      {order.currentStageTitle ? ` · ${order.currentStageTitle}` : ""}
                      {order.clientName ? ` · ${order.clientName}` : ""}
                    </span>
                  </button>
                  {canReorder && activeQueue.length > 1 && (
                    <span className="queue-tools">
                      <button
                        type="button"
                        className="link-btn"
                        disabled={busy || queueIndex <= 0}
                        aria-label={`把 ${order.code} 上移`}
                        onClick={() => shiftQueue(order.id, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="link-btn"
                        disabled={busy || queueIndex >= activeQueue.length - 1}
                        aria-label={`把 ${order.code} 下移`}
                        onClick={() => shiftQueue(order.id, 1)}
                      >
                        ↓
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {dragging && hoverIndex !== null && (
          <p className="drag-hint">
            松开后放到第 {hoverIndex + 1} 位
            {hoverIndex === dragging.fromIndex ? "（当前位置，不会改变顺序）" : ""}
          </p>
        )}
        {statusFilter === "complete" || statusFilter === "cancelled" ? (
          <p className="muted list-hint">
            当前筛选下不显示活动队列，拖拽与 ↑ ↓ 已禁用；切到「全部」或「活动」后可调整顺序。
          </p>
        ) : activeQueue.length > 1 ? (
          <p className="muted list-hint">
            按住行首的 ⠿ 拖到目标位置，或用 ↑ ↓ 调整顺序；排序不影响订单编号。
          </p>
        ) : null}
      </aside>

      <section className="orders-detail">
        {error && (
          <div className="banner banner-error">
            <span>{error}</span>
            <button type="button" className="btn btn-sm" onClick={() => setError(null)}>
              关闭
            </button>
          </div>
        )}
        {notice && (
          <div className="banner banner-ok">
            <span>{notice}</span>
            <button type="button" className="btn btn-sm" onClick={() => setNotice(null)}>
              关闭
            </button>
          </div>
        )}

        {creating ? (
          <CreateOrderPanel
            clients={clients}
            busy={busy}
            onCancel={() => setCreating(false)}
            onCreated={async (order) => {
              setCreating(false);
              await loadList();
              await selectOrder(order.id);
              setNotice(`已创建 ${order.code}`);
            }}
            onError={setError}
            setBusy={setBusy}
          />
        ) : !detail ? (
          <section className="panel empty">
            <p>从左侧选择一张订单，或新建一张委托。</p>
          </section>
        ) : (
          <>
            <section className="panel">
              <header className="panel-head">
                <div>
                  <div className="detail-code">
                    <code>{detail.code}</code>
                    <span className={`chip chip-${detail.status}`}>
                      {STATUS_LABEL[detail.status]}
                    </span>
                    <span className={`chip chip-state-${detail.workState}`}>
                      {WORK_LABEL[detail.workState]}
                    </span>
                  </div>
                  <h1 className="detail-title">{detail.title}</h1>
                  <p className="muted">
                    当前阶段 {detail.currentStageTitle ?? "—"} · 第{" "}
                    {(detail.currentStageIndex ?? 0) + 1}/{detail.stageCount} 步 · 队列位置{" "}
                    {detail.queuePosition + 1}
                    {detail.clientName ? ` · 客户 ${detail.clientName}` : ""}
                  </p>
                </div>
              </header>

              <div className="facts">
                <span>{formatMoney(detail.amountCents)}</span>
                <span>开始 {detail.plannedStartDate ?? "未排"}</span>
                <span>交付 {detail.plannedDeliveryDate ?? "未排"}</span>
                <span>版本 {detail.revision}</span>
              </div>

              <ActionBar
                order={detail}
                busy={busy}
                onRequest={setPendingAction}
                onRun={runLifecycle}
                onDirtyGuard={() => dirty}
              />

              {pendingAction && (
                <div className="confirm-bar">
                  <div>
                    <strong>{pendingAction.title}</strong>
                    <p className="muted">{pendingAction.detail}</p>
                  </div>
                  <div className="confirm-actions">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setPendingAction(null)}
                      disabled={busy}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={busy}
                      onClick={async () => {
                        const action = pendingAction;
                        setPendingAction(null);
                        await action.run();
                      }}
                    >
                      {pendingAction.confirmLabel}
                    </button>
                  </div>
                </div>
              )}
            </section>

            <section className="panel">
              <header className="panel-head compact">
                <h2>资料</h2>
                <span className="muted">{dirty ? "有未保存的修改" : "已保存"}</span>
              </header>
              <DetailsForm
                draft={draft}
                clients={clients}
                onChange={(next) => {
                  setDraft(next);
                  setDraftError(null);
                }}
                disabled={busy}
              />
              {draftError && <p className="notice notice-error">{draftError}</p>}
              <div className="actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void saveDraft()}
                  disabled={busy || !dirty}
                >
                  {busy ? "保存中…" : "保存资料"}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => detail && setDraft(draftFrom(detail))}
                  disabled={busy || !dirty}
                >
                  还原修改
                </button>
              </div>
            </section>

            <AttachmentPanel
              orderId={detail.id}
              onError={setError}
              onNotice={setNotice}
            />

            <StagePanel
              order={detail}
              busy={busy}
              onRun={runLifecycle}
              onError={setError}
            />

            <EventTimeline events={events} formatTime={formatTime} />
          </>
        )}

      </section>

      <UnsavedChangesDialog
        open={dialogOpen}
        detail={
          pendingNav?.kind === "create"
            ? "新建订单会离开当前订单，尚未保存的资料修改将丢失。"
            : pendingNav?.kind === "route"
              ? "离开订单页面会丢失尚未保存的资料修改。"
              : "切换订单会丢失当前尚未保存的资料修改。"
        }
        error={guardError}
        busy={guardBusy || busy}
        onSaveAndLeave={handleSaveAndLeave}
        onDiscard={handleDiscard}
        onStay={handleStay}
      />
    </div>
  );
}

// ---------------------------------------------------------------- 子组件

function ActionBar({
  order,
  busy,
  onRequest,
  onRun,
  onDirtyGuard,
}: {
  order: OrderView;
  busy: boolean;
  onRequest: (action: PendingAction) => void;
  onRun: (label: string, call: (order: OrderView) => Promise<OrderView>) => Promise<void>;
  onDirtyGuard: () => boolean;
}) {
  const caps = order.capabilities;

  const lifecycleCall = (
    fn: (input: {
      orderId: string;
      expectedRevision: number;
      requestId?: string | null;
    }) => Promise<OrderView>,
    order: OrderView,
    prefix: string,
  ) =>
    fn({
      orderId: order.id,
      expectedRevision: order.revision,
      requestId: newRequestId(prefix),
    });

  return (
    <div className="action-bar">
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy || !caps.canStartWork}
        title={caps.canStartWork ? "" : "只有活动且未开工的订单可以开始制作"}
        onClick={() => void onRun("已开始制作", (o) => lifecycleCall(api.startWork, o, "start"))}
      >
        开始制作
      </button>

      <button
        type="button"
        className="btn"
        disabled={busy || !caps.canUndoStartWork}
        title={caps.undoBlockedReason ?? ""}
        onClick={() =>
          void onRun("已撤销开工", (o) => lifecycleCall(api.undoStartWork, o, "undo-start"))
        }
      >
        撤销开工
      </button>

      <button
        type="button"
        className="btn"
        disabled={busy || !caps.canAdvance}
        title={caps.canAdvance ? "" : "尚未开工或已在最后一个阶段"}
        onClick={() => void onRun("已推进到下一阶段", (o) => lifecycleCall(api.advanceStage, o, "advance"))}
      >
        推进阶段
      </button>

      <button
        type="button"
        className="btn"
        disabled={busy || !caps.canRework}
        title={caps.canRework ? "" : "尚未开工或已在第一阶段"}
        onClick={() =>
          onRequest({
            title: "返工",
            detail: `把「${order.currentStageTitle ?? ""}」退回上一阶段？历史会记录这次返工。`,
            confirmLabel: "确认返工",
            run: () =>
              onRun("已返工到上一阶段", (o) =>
                api.reworkStage({
                  orderId: o.id,
                  expectedRevision: o.revision,
                  targetStageId: null,
                  requestId: newRequestId("rework"),
                }),
              ),
          })
        }
      >
        返工一步
      </button>

      <button
        type="button"
        className="btn"
        disabled={busy || !caps.canComplete}
        title={caps.canComplete ? "" : "必须已开工且位于最后一个阶段"}
        onClick={() =>
          onRequest({
            title: "完成订单",
            detail: "完成后会锁定制作流程与开工状态，只能在确认后重新打开。",
            confirmLabel: "确认完成",
            run: () => onRun("订单已完成", (o) => lifecycleCall(api.completeOrder, o, "complete")),
          })
        }
      >
        完成
      </button>

      <button
        type="button"
        className="btn"
        disabled={busy || !caps.canCancel}
        onClick={() =>
          onRequest({
            title: "取消订单",
            detail: "取消后订单退出活动队列，制作流程被锁定；普通资料仍可编辑。",
            confirmLabel: "确认取消",
            run: () => onRun("订单已取消", (o) => lifecycleCall(api.cancelOrder, o, "cancel")),
          })
        }
      >
        取消
      </button>

      <button
        type="button"
        className="btn"
        disabled={busy || !caps.canReopen}
        title={caps.canReopen ? "" : "只有已完成或已取消的订单可以重新打开"}
        onClick={() =>
          onRequest({
            title: "重新打开订单",
            detail: "订单将回到活动状态并加入队列末尾，保留当前阶段与开工记录。",
            confirmLabel: "确认重新打开",
            run: () => onRun("订单已重新打开", (o) => lifecycleCall(api.reopenOrder, o, "reopen")),
          })
        }
      >
        重新打开
      </button>

      {onDirtyGuard() && (
        <span className="muted action-hint">资料有未保存修改，生命周期操作不受影响</span>
      )}
    </div>
  );
}

function DetailsForm({
  draft,
  clients,
  onChange,
  disabled,
}: {
  draft: Draft | null;
  clients: ClientView[];
  onChange: (next: Draft) => void;
  disabled: boolean;
}) {
  if (!draft) return null;
  const patch = (part: Partial<Draft>) => onChange({ ...draft, ...part });

  return (
    <div className="form-grid">
      <label className="field field-wide">
        <span>委托标题</span>
        <input
          value={draft.title}
          onChange={(e) => patch({ title: e.target.value })}
          disabled={disabled}
          maxLength={120}
        />
      </label>

      <label className="field">
        <span>客户</span>
        <select
          value={draft.clientId}
          onChange={(e) => patch({ clientId: e.target.value })}
          disabled={disabled}
        >
          <option value="">不关联客户</option>
          {clients.map((client) => (
            <option key={client.id} value={client.id}>
              {client.displayName}（{client.orderCount} 单）
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>委托类型</span>
        <input
          value={draft.commissionType}
          onChange={(e) => patch({ commissionType: e.target.value })}
          disabled={disabled}
          maxLength={80}
          placeholder="例如 半身立绘"
        />
      </label>

      <label className="field">
        <span>委托金额（元，留空表示未知）</span>
        <input
          value={draft.amount}
          onChange={(e) => patch({ amount: e.target.value })}
          disabled={disabled}
          placeholder="例如 1200.00"
          inputMode="decimal"
        />
      </label>

      <label className="field">
        <span>预计开始日期</span>
        <input
          type="date"
          value={draft.startDate}
          onChange={(e) => patch({ startDate: e.target.value })}
          disabled={disabled}
        />
      </label>

      <label className="field">
        <span>预计交付日期</span>
        <input
          type="date"
          value={draft.deliveryDate}
          onChange={(e) => patch({ deliveryDate: e.target.value })}
          disabled={disabled}
        />
      </label>

      <label className="field field-wide">
        <span>委托说明</span>
        <textarea
          value={draft.note}
          onChange={(e) => patch({ note: e.target.value })}
          disabled={disabled}
          rows={3}
          maxLength={4000}
        />
      </label>
    </div>
  );
}

function StagePanel({
  order,
  busy,
  onRun,
  onError,
}: {
  order: OrderView;
  busy: boolean;
  onRun: (label: string, call: (order: OrderView) => Promise<OrderView>) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [newTitle, setNewTitle] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [stageToDelete, setStageToDelete] = useState<{
    id: string;
    title: string;
    replacementId: string;
    isCurrent: boolean;
  } | null>(null);

  const locked = !order.capabilities.canEditWorkflow;

  async function guarded(label: string, run: () => Promise<OrderView>) {
    try {
      const updated = await run();
      await onRun(label, async () => updated);
    } catch (e) {
      onError(describeError(e));
    }
  }

  return (
    <section className="panel">
      <header className="panel-head compact">
        <h2>制作流程</h2>
        <span className="muted">
          {order.stageCount} 个阶段{locked ? " · 终态订单已锁定" : ""}
        </span>
      </header>

      <ol className="stage-list">
        {order.stages.map((stage, index) => (
          <li key={stage.id} className={stage.isCurrent ? "stage stage-current" : "stage"}>
            <span className="stage-index">{index + 1}</span>
            {renaming === stage.id ? (
              <span className="stage-edit">
                <input
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  disabled={busy}
                  maxLength={80}
                />
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy || renameValue.trim() === ""}
                  onClick={() =>
                    void guarded("阶段已重命名", () =>
                      api.workflowRenameStage({
                        orderId: order.id,
                        expectedRevision: order.revision,
                        stageId: stage.id,
                        title: renameValue.trim(),
                        requestId: newRequestId("rename"),
                      }),
                    ).then(() => setRenaming(null))
                  }
                >
                  保存
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setRenaming(null)}>
                  取消
                </button>
              </span>
            ) : (
              <>
                <span className="stage-title">{stage.title}</span>
                {stage.isCurrent && <span className="chip chip-current">当前</span>}
                {!locked && (
                  <span className="stage-tools">
                    <button
                      type="button"
                      className="link-btn"
                      disabled={busy}
                      onClick={() => {
                        setRenaming(stage.id);
                        setRenameValue(stage.title);
                      }}
                    >
                      改名
                    </button>
                    <button
                      type="button"
                      className="link-btn"
                      disabled={busy || index === 0}
                      onClick={() =>
                        void guarded("阶段顺序已调整", () => {
                          const ids = order.stages.map((s) => s.id);
                          const [moved] = ids.splice(index, 1);
                          if (!moved) return Promise.reject(new Error("阶段不存在"));
                          ids.splice(index - 1, 0, moved);
                          return api.workflowReorderStages({
                            orderId: order.id,
                            expectedRevision: order.revision,
                            orderedStageIds: ids,
                            requestId: newRequestId("reorder"),
                          });
                        })
                      }
                    >
                      上移
                    </button>
                    <button
                      type="button"
                      className="link-btn"
                      disabled={busy || index === order.stages.length - 1}
                      onClick={() =>
                        void guarded("阶段顺序已调整", () => {
                          const ids = order.stages.map((s) => s.id);
                          const [moved] = ids.splice(index, 1);
                          if (!moved) return Promise.reject(new Error("阶段不存在"));
                          ids.splice(index + 1, 0, moved);
                          return api.workflowReorderStages({
                            orderId: order.id,
                            expectedRevision: order.revision,
                            orderedStageIds: ids,
                            requestId: newRequestId("reorder"),
                          });
                        })
                      }
                    >
                      下移
                    </button>
                    {order.stages.length > 1 && (
                      <button
                        type="button"
                        className="link-btn link-danger"
                        disabled={busy}
                        onClick={() => {
                          const fallback = order.stages.find((s) => s.id !== stage.id);
                          if (!fallback) return;
                          setStageToDelete({
                            id: stage.id,
                            title: stage.title,
                            replacementId: fallback.id,
                            isCurrent: stage.isCurrent,
                          });
                        }}
                      >
                        删除
                      </button>
                    )}
                  </span>
                )}
              </>
            )}
          </li>
        ))}
      </ol>

      <ConfirmDialog
        open={stageToDelete !== null}
        title="确认删除这个阶段？"
        danger
        confirmLabel="确认删除"
        busy={busy}
        onCancel={() => setStageToDelete(null)}
        onConfirm={async () => {
          const target = stageToDelete;
          if (!target) return;
          setStageToDelete(null);
          await guarded("已删除阶段", () =>
            api.workflowRemoveStage({
              orderId: order.id,
              expectedRevision: order.revision,
              stageId: target.id,
              replacementStageId: target.isCurrent ? target.replacementId : null,
              requestId: newRequestId("remove-stage"),
            }),
          );
        }}
      >
        {stageToDelete && (
          <>
            <p>
              即将删除阶段 <strong>「{stageToDelete.title}」</strong>。
            </p>
            <p>
              {stageToDelete.isCurrent
                ? "这是当前阶段，删除后当前阶段会改为同一流程里的下一个阶段。"
                : "已发生的历史事件保留当时的阶段名称，不会因为删除而失真。"}
            </p>
          </>
        )}
      </ConfirmDialog>

      {!locked && (
        <div className="stage-add">
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="新增阶段名称"
            maxLength={80}
            disabled={busy}
          />
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy || newTitle.trim() === ""}
            onClick={() =>
              void guarded("已新增阶段", () =>
                api.workflowAddStage({
                  orderId: order.id,
                  expectedRevision: order.revision,
                  title: newTitle.trim(),
                  requestId: newRequestId("add-stage"),
                }),
              ).then(() => setNewTitle(""))
            }
          >
            添加阶段
          </button>
        </div>
      )}
    </section>
  );
}

function EventTimeline({
  events,
  formatTime,
}: {
  events: OrderEvent[];
  formatTime: (iso: string | null) => string;
}) {
  return (
    <section className="panel">
      <header className="panel-head compact">
        <h2>制作历史</h2>
        <span className="muted">{events.length} 条事件</span>
      </header>
      {events.length === 0 ? (
        <p className="muted">还没有历史事件。</p>
      ) : (
        <ul className="timeline">
          {[...events].reverse().map((event) => (
            <li key={event.id}>
              <span className="timeline-kind">{EVENT_LABEL[event.kind] ?? event.kind}</span>
              <span className="timeline-detail">
                {event.fromStageTitle && event.toStageTitle
                  ? `${event.fromStageTitle} → ${event.toStageTitle}`
                  : event.toStageTitle ?? ""}
                {event.note ? ` · ${event.note}` : ""}
              </span>
              <time className="timeline-time">{formatTime(event.occurredAt)}</time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CreateOrderPanel({
  clients,
  busy,
  onCancel,
  onCreated,
  onError,
  setBusy,
}: {
  clients: ClientView[];
  busy: boolean;
  onCancel: () => void;
  onCreated: (order: OrderView) => Promise<void>;
  onError: (message: string) => void;
  setBusy: (value: boolean) => void;
}) {
  const [title, setTitle] = useState("");
  const [clientMode, setClientMode] = useState<"none" | "existing" | "new">("none");
  const [clientId, setClientId] = useState("");
  const [newClientName, setNewClientName] = useState("");
  const [commissionType, setCommissionType] = useState("");
  const [amount, setAmount] = useState("");
  const [startDate, setStartDate] = useState("");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [note, setNote] = useState("");
  const requestId = useMemo(() => newRequestId("create"), []);

  async function submit() {
    setBusy(true);
    onError("");
    try {
      const client: CreateOrderInput["client"] =
        clientMode === "existing"
          ? { mode: "existing", clientId }
          : clientMode === "new"
            ? { mode: "new", displayName: newClientName.trim() }
            : { mode: "none" };

      const order = await api.createOrder({
        title,
        client,
        commissionType: commissionType.trim() === "" ? null : commissionType,
        amountCents: yuanToCents(amount),
        plannedStartDate: startDate === "" ? null : startDate,
        plannedDeliveryDate: deliveryDate === "" ? null : deliveryDate,
        note: note.trim() === "" ? null : note,
        requestId,
      });
      await onCreated(order);
    } catch (e) {
      onError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>新建订单</h2>
          <p className="muted">只有委托标题是必填项。创建后会自动分配编号并加入队列末尾。</p>
        </div>
      </header>

      <div className="form-grid">
        <label className="field field-wide">
          <span>委托标题 *</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            autoFocus
            disabled={busy}
          />
        </label>

        <label className="field">
          <span>客户</span>
          <select
            value={clientMode}
            onChange={(e) => setClientMode(e.target.value as "none" | "existing" | "new")}
            disabled={busy}
          >
            <option value="none">不关联客户</option>
            <option value="existing">选择已有客户</option>
            <option value="new">新建客户</option>
          </select>
        </label>

        {clientMode === "existing" && (
          <label className="field">
            <span>已有客户</span>
            <select value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={busy}>
              <option value="">请选择</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </select>
          </label>
        )}

        {clientMode === "new" && (
          <label className="field">
            <span>新客户名称</span>
            <input
              value={newClientName}
              onChange={(e) => setNewClientName(e.target.value)}
              maxLength={120}
              disabled={busy}
            />
          </label>
        )}

        <label className="field">
          <span>委托类型</span>
          <input
            value={commissionType}
            onChange={(e) => setCommissionType(e.target.value)}
            maxLength={80}
            disabled={busy}
          />
        </label>

        <label className="field">
          <span>委托金额（元，留空表示未知）</span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="例如 800"
            disabled={busy}
          />
        </label>

        <label className="field">
          <span>预计开始日期</span>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            disabled={busy}
          />
        </label>

        <label className="field">
          <span>预计交付日期</span>
          <input
            type="date"
            value={deliveryDate}
            onChange={(e) => setDeliveryDate(e.target.value)}
            disabled={busy}
          />
        </label>

        <label className="field field-wide">
          <span>委托说明</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={4000}
            disabled={busy}
          />
        </label>
      </div>

      <div className="actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void submit()}
          disabled={busy || title.trim() === "" || (clientMode === "existing" && clientId === "") ||
            (clientMode === "new" && newClientName.trim() === "")}
        >
          {busy ? "创建中…" : "创建订单"}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          取消
        </button>
      </div>
    </section>
  );
}
