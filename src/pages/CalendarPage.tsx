import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api, describeError, isConflict, type OrderView } from "../bridge/commands";
import CalendarGrid, { type ChipDragStart } from "../components/CalendarGrid";
import RescheduleDialog, { type ReschedulePlan } from "../components/RescheduleDialog";
import {
  canReschedule,
  compareUnscheduled,
  dropPlan,
  isTerminal,
  monthMatrix,
  monthTitle,
  orderSpan,
  rescheduleInput,
  shiftMonth,
  shiftWeek,
  weekDays,
  weekTitle,
  type CalendarView,
  type DropMode,
} from "../lib/calendar";
import { formatDayKey, localDayIndex, parseDayKey, type DayIndex } from "../lib/scheduleBar";

type DragState = {
  order: OrderView;
  mode: DropMode;
  /** 指针移动超过阈值后才算真正开始拖动，之前一律当普通点击。 */
  armed: boolean;
  targetDay: DayIndex | null;
  plan: ReschedulePlan | null;
  blocked: string | null;
};

type DialogState = {
  order: OrderView;
  initial: ReschedulePlan;
  allowFieldChoice: boolean;
  droppedDay: string | null;
};

export default function CalendarPage() {
  const navigate = useNavigate();
  const [orders, setOrders] = useState<OrderView[] | null>(null);
  const [timezone, setTimezone] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [generation, setGeneration] = useState(0);
  const [view, setView] = useState<CalendarView>("month");
  const [anchor, setAnchor] = useState<DayIndex | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [saving, setSaving] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const requested = useRef(0);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  /** 按下时的坐标，用于区分点击与拖动。 */
  const pressRef = useRef<{ x: number; y: number } | null>(null);
  /** 拖动结束后吞掉随之而来的那一次 click，避免误进详情。 */
  const suppressClickRef = useRef(false);
  const suppressTimerRef = useRef<number | null>(null);

  const timezoneRef = useRef<string | null>(null);
  timezoneRef.current = timezone;

  const today = useMemo(
    () => (timezone === null ? null : localDayIndex(new Date().toISOString(), timezone)),
    [timezone],
  );

  useEffect(() => {
    let cancelled = false;
    const seq = ++requested.current;
    setLoading(true);
    (async () => {
      try {
        const status = await api.status();
        const list = await api.listOrders();
        if (cancelled || seq !== requested.current) return;
        setTimezone(status.workingTimezone);
        setOrders(list);
        setLoadError(null);
        setRefreshError(null);
      } catch (error) {
        if (cancelled || seq !== requested.current) return;
        const message = describeError(error);
        if (orders === null) setLoadError(message);
        else setRefreshError(message);
      } finally {
        if (!cancelled && seq === requested.current) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // orders 故意不进依赖：只在首次失败时用于区分"首次加载"与"刷新失败"
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation]);

  useEffect(() => {
    const onFocus = () => setGeneration((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // 今天到位后确定初始锚点（只做一次，不覆盖用户导航）
  useEffect(() => {
    if (anchor === null && today !== null) setAnchor(today);
  }, [anchor, today]);

  // 拖放：在 window 上收尾，不用 setPointerCapture（会吞 click）
  useEffect(() => {
    if (drag === null) return;

    const move = (event: PointerEvent) => {
      if (!drag.armed) {
        const press = pressRef.current;
        if (press !== null) {
          const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y);
          if (moved < 6) return;
        }
        setDrag((prev) => (prev === null ? prev : { ...prev, armed: true }));
      }
      // 指针可能压在订单条或浮层上，所以按层取第一个日期格，
      // 而不是只看最顶层元素的祖先（那样拖到订单条上就丢失目标日期）。
      const stack = document.elementsFromPoint(event.clientX, event.clientY);
      const cell =
        stack.find((el) => el instanceof HTMLElement && el.matches(".cal-day-bg[data-day]")) ??
        stack
          .map((el) => (el instanceof HTMLElement ? el.closest<HTMLElement>("[data-day]") : null))
          .find((el): el is HTMLElement => el !== null);
      const day = cell ? Number((cell as HTMLElement).dataset.day) : Number.NaN;
      if (Number.isNaN(day)) {
        setDrag((prev) => (prev === null ? prev : { ...prev, targetDay: null, plan: null, blocked: null }));
        return;
      }
      const plan = dropPlan(drag.order, day, drag.mode);
      setDrag((prev) =>
        prev === null
          ? prev
          : {
              ...prev,
              targetDay: day,
              plan: plan.ok ? { start: plan.start, delivery: plan.delivery } : null,
              blocked: plan.ok ? null : plan.reason,
            },
      );
    };

    const finish = () => {
      const current = dragRef.current;
      if (current !== null && current.armed) {
        // 只有真正拖动过才抑制点击；普通点击不进入这里。
        suppressClickRef.current = true;
        if (suppressTimerRef.current !== null) window.clearTimeout(suppressTimerRef.current);
        suppressTimerRef.current = window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 400);
      }
      if (current !== null && current.armed && current.plan !== null && current.targetDay !== null) {
        const span = orderSpan(current.order);
        setDialog({
          order: current.order,
          initial: current.plan,
          allowFieldChoice: span === null,
          droppedDay: formatDayKey(current.targetDay),
        });
        setDialogError(null);
      }
      setDrag(null);
    };

    const cancel = () => setDrag(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      document.removeEventListener("keydown", onKey);
    };
  }, [drag]);

  const startDrag = useCallback(({ order, mode, event }: ChipDragStart) => {
    const span = orderSpan(order);
    pressRef.current = { x: event.clientX, y: event.clientY };
    setDrag({
      order,
      mode: span === null ? "unscheduled" : mode,
      armed: false,
      targetDay: null,
      plan: null,
      blocked: null,
    });
  }, []);

  /** 拖动刚结束时吞掉一次点击，其余情况照常进详情。 */
  const openOrder = useCallback(
    (id: string) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      navigate(`/orders?orderId=${id}`);
    },
    [navigate],
  );

  function openKeyboardDialog(order: OrderView) {
    if (!canReschedule(order)) return;
    setDialog({
      order,
      initial: { start: order.plannedStartDate, delivery: order.plannedDeliveryDate },
      allowFieldChoice: orderSpan(order) === null,
      droppedDay: null,
    });
    setDialogError(null);
  }

  async function confirmReschedule(plan: ReschedulePlan, reason: string) {
    if (dialog === null) return;
    setSaving(true);
    setDialogError(null);
    try {
      await api.updateOrderDetails(
        rescheduleInput(dialog.order, plan, "calendar", reason === "" ? null : reason),
      );
      setDialog(null);
      setGeneration((n) => n + 1);
    } catch (error) {
      if (isConflict(error)) {
        setDialogError(`${describeError(error)} 已重新载入最新数据，请确认后再试。`);
        setGeneration((n) => n + 1);
      } else {
        setDialogError(describeError(error));
      }
    } finally {
      setSaving(false);
    }
  }

  if (loadError !== null && orders === null) {
    return (
      <section className="panel panel-error">
        <h2>无法读取日历数据</h2>
        <p className="mono">{loadError}</p>
        <button type="button" onClick={() => setGeneration((n) => n + 1)}>
          重试
        </button>
      </section>
    );
  }

  if (orders === null || today === null || anchor === null) {
    return (
      <section className="panel">
        <p>{loading ? "正在读取订单…" : "暂无数据"}</p>
      </section>
    );
  }

  const active = orders.filter((order) => order.status === "active");
  const visible = showTerminal ? orders : active;

  const unscheduledActive = orders
    .filter((order) => order.status === "active" && orderSpan(order) === null)
    .sort(compareUnscheduled);
  const unscheduledTerminal = orders
    .filter((order) => isTerminal(order) && orderSpan(order) === null)
    .sort(compareUnscheduled);

  const previewRange = (() => {
    if (drag === null || !drag.armed) return null;
    if (drag.plan !== null) {
      const start = drag.plan.start === null ? null : parseDayKey(drag.plan.start);
      const delivery = drag.plan.delivery === null ? null : parseDayKey(drag.plan.delivery);
      const from = start ?? delivery;
      const to = delivery ?? start;
      if (from === null || to === null) return null;
      return { orderId: drag.order.id, from: Math.min(from, to), to: Math.max(from, to), valid: true };
    }
    if (drag.targetDay !== null) {
      return { orderId: drag.order.id, from: drag.targetDay, to: drag.targetDay, valid: false };
    }
    return null;
  })();

  const weeks =
    view === "month"
      ? Array.from({ length: 6 }, (_, row) => monthMatrix(anchor).slice(row * 7, row * 7 + 7))
      : [weekDays(anchor)];

  const title = view === "month" ? monthTitle(anchor) : weekTitle(anchor);

  function shift(direction: -1 | 1) {
    setAnchor((prev) =>
      prev === null ? prev : view === "month" ? shiftMonth(prev, direction) : shiftWeek(prev, direction),
    );
  }

  function switchView(next: CalendarView) {
    // 保留当前浏览日期：只换视图，不回到今天
    setView(next);
  }

  return (
    <div className="cal-page">
      <header className="cal-head">
        <div>
          <h2>日历</h2>
          <p className="cal-sub">
            只读计划日期 · 拖放或「改期」都会先确认再写入 · 今天是 {formatDayKey(today)}（
            {timezone}）
          </p>
        </div>
        <div className="cal-head-actions">
          <button
            type="button"
            className="btn cal-refresh"
            onClick={() => setGeneration((n) => n + 1)}
          >
            刷新
          </button>
          <label className="cal-toggle">
            <input
              type="checkbox"
              checked={showTerminal}
              onChange={(event) => setShowTerminal(event.target.checked)}
            />
            显示已结束
          </label>
        </div>
      </header>

      {refreshError !== null && (
        <p className="cal-refresh-error" role="alert">
          刷新失败，仍显示上次读取的数据：{refreshError}
          <button type="button" onClick={() => setGeneration((n) => n + 1)}>
            重新尝试
          </button>
        </p>
      )}

      <div className="cal-body">
        <aside className="cal-pool" aria-label="未排期订单">
          <h3>
            未排期订单 <span className="cal-count">{unscheduledActive.length}</span>
          </h3>
          {unscheduledActive.length === 0 ? (
            <p className="cal-empty">所有活动订单都已排期。</p>
          ) : (
            <ul>
              {unscheduledActive.map((order) => (
                <li key={order.id}>
                  <button
                    type="button"
                    className="cal-pool-item"
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.preventDefault();
                      startDrag({ order, mode: "unscheduled", event });
                    }}
                    onClick={(event) => {
                      if (event.detail === 0) openKeyboardDialog(order);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        openKeyboardDialog(order);
                      }
                    }}
                  >
                    <span className="mono">{order.code}</span>
                    <strong>{order.title}</strong>
                    <span className="cal-pool-sub">{order.clientName ?? "未关联客户"}</span>
                  </button>
                  <button
                    type="button"
                    className="cal-pool-reschedule"
                    onClick={() => openKeyboardDialog(order)}
                    aria-label={`为 ${order.code} 改期`}
                  >
                    改期
                  </button>
                </li>
              ))}
            </ul>
          )}

          {showTerminal && (
            <section className="cal-pool-history">
              <h3>
                已结束且未排期 <span className="cal-count">{unscheduledTerminal.length}</span>
              </h3>
              {unscheduledTerminal.length === 0 ? (
                <p className="cal-empty">没有。</p>
              ) : (
                <ul>
                  {unscheduledTerminal.map((order) => (
                    <li key={order.id}>
                      <button
                        type="button"
                        className="cal-pool-item is-readonly"
                        onClick={(event) => {
                          if (event.detail === 0) return;
                          navigate(`/orders?orderId=${order.id}`);
                        }}
                        title="已结束订单不可改期"
                      >
                        <span className="mono">{order.code}</span>
                        <strong>{order.title}</strong>
                        <span className="cal-pool-sub">
                          {order.status === "complete" ? "已完成" : "已取消"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </aside>

        <section className="cal-main" aria-label="日历">
          <div className="cal-toolbar">
            <div className="cal-nav">
              <button type="button" onClick={() => shift(-1)} aria-label="上一段">
                ‹
              </button>
              <strong className="cal-title">{title}</strong>
              <button type="button" onClick={() => shift(1)} aria-label="下一段">
                ›
              </button>
              <button type="button" className="cal-today" onClick={() => setAnchor(today)}>
                今天
              </button>
            </div>
            <div className="segmented cal-views" role="group" aria-label="日历视图">
              <button type="button" aria-pressed={view === "month"} onClick={() => switchView("month")}>
                月
              </button>
              <button type="button" aria-pressed={view === "week"} onClick={() => switchView("week")}>
                周
              </button>
            </div>
          </div>

          {drag !== null && (
            <div className={`cal-drag-status${drag.blocked !== null ? " is-invalid" : ""}`} role="status">
              <strong>{drag.blocked !== null ? "无法放置到这里" : "正在调整排期"}</strong>
              {drag.plan !== null && (
                <dl>
                  <div className={drag.plan.start !== drag.order.plannedStartDate ? "is-changed" : undefined}>
                    <dt>开始日期</dt>
                    <dd>
                      <span>{drag.order.plannedStartDate ?? "未设置"}</span>
                      <span aria-hidden="true">→</span>
                      <span>{drag.plan.start ?? "未设置"}</span>
                    </dd>
                  </div>
                  <div
                    className={drag.plan.delivery !== drag.order.plannedDeliveryDate ? "is-changed" : undefined}
                  >
                    <dt>交付日期</dt>
                    <dd>
                      <span>{drag.order.plannedDeliveryDate ?? "未设置"}</span>
                      <span aria-hidden="true">→</span>
                      <span>{drag.plan.delivery ?? "未设置"}</span>
                    </dd>
                  </div>
                </dl>
              )}
              {drag.blocked !== null ? <em>{drag.blocked}</em> : <small>松开后进入确认框，确认之前不会写入。</small>}
            </div>
          )}

          <CalendarGrid
            view={view}
            anchor={anchor}
            today={today}
            weeks={weeks}
            orders={visible}
            preview={previewRange}
            onOpenOrder={openOrder}
            onReschedule={openKeyboardDialog}
            onChipPointerDown={startDrag}
          />

          {drag === null ? (
            <p className="cal-hint" role="status">
              拖动订单条可改期：拖两端改对应日期，拖条身整体平移。也可以聚焦订单后按 Enter 用「改期」。
            </p>
          ) : null}
        </section>
      </div>

      <RescheduleDialog
        open={dialog !== null}
        order={dialog?.order ?? null}
        initial={dialog?.initial ?? null}
        allowFieldChoice={dialog?.allowFieldChoice ?? false}
        droppedDay={dialog?.droppedDay ?? null}
        today={formatDayKey(today)}
        busy={saving}
        error={dialogError}
        onCancel={() => {
          setDialog(null);
          setDialogError(null);
        }}
        onConfirm={confirmReschedule}
      />
    </div>
  );
}

