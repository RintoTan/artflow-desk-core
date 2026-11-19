import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api, describeError, isConflict, type OrderView } from "../bridge/commands";
import CalendarGrid, { type ChipDragStart } from "../components/CalendarGrid";
import RescheduleDialog, { type ReschedulePlan } from "../components/RescheduleDialog";
import {
  canReschedule,
  compareUnscheduled,
  dominantMonthDay,
  dropPlan,
  isTerminal,
  monthGridMetrics,
  monthKeyOf,
  monthTitle,
  orderSpan,
  rescheduleInput,
  shiftMonth,
  shiftWeek,
  weekDays,
  weekGridMetrics,
  weeksInMonth,
  weekStartOf,
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
  /** 连续周行的起点（某周周一）与总周数；滚动到边界时向两侧扩展。 */
  const [rangeStart, setRangeStart] = useState<DayIndex | null>(null);
  const [rangeWeeks, setRangeWeeks] = useState(29);
  /** 当前可视范围内占格最多的月份，用于月份标题与当月着色。 */
  const [visibleAnchor, setVisibleAnchor] = useState<DayIndex | null>(null);
  /** 点击过的日期（非当月日期也照样可点）。 */
  const [focusedDay, setFocusedDay] = useState<DayIndex | null>(null);
  /** 日历可视高度：行高按它分配，窗口变化时跟着变。 */
  const [viewportH, setViewportH] = useState(0);
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

  // 用今天初始化连续周范围：前后各 14 周（共 29 行），滚动到边界再自动扩
  useEffect(() => {
    if (today === null) return;
    setRangeStart((prev) => prev ?? weekStartOf(today) - 14 * 7);
    setVisibleAnchor((prev) => prev ?? today);
  }, [today]);

  const rowHRef = useRef(0);
  const prevRowHRef = useRef(0);
  const observedScrollRef = useRef<HTMLDivElement | null>(null);
  /** 上一帧的行高/视口/滚动位置：缩放时用它把视口中心钉在同一行。 */
  const lastFrameRef = useRef<{
    rowH: number;
    clientH: number;
    scrollTop: number;
    centerDay: DayIndex | null;
  } | null>(null);
  const viewportObserverRef = useRef<ResizeObserver | null>(null);
  const prependRef = useRef(0);
  /** 头部被裁掉的行数：渲染后要把 scrollTop 往回退，否则视口会跳。 */
  const trimHeadRef = useRef(0);
  const scrollTargetRef = useRef<DayIndex | null>(null);
  const scrollEl = useRef<HTMLDivElement | null>(null);
  const initializedRef = useRef(false);

  /** 记录真实行高，用于把 scrollTop 换算成周序号（每行等高）。 */
  useLayoutEffect(() => {
    const el = scrollEl.current;
    const first = el?.querySelector<HTMLElement>(".cal-week");
    if (!el || !first) return;
    const measured = first.getBoundingClientRect().height || 0;
    const prev = lastFrameRef.current;
    if (measured > 0 && prev !== null && prev.rowH > 0 && prev.centerDay !== null && rangeStart !== null) {
      const heightChanged = Math.abs(measured - prev.rowH) > 0.5;
      const viewportChanged = Math.abs(el.clientHeight - prev.clientH) > 0.5;
      // 有明确的滚动目标（今天/跳转）时，目标优先，别让"保持视口中心"抢先返回
      if ((heightChanged || viewportChanged) && scrollTargetRef.current === null) {
        // 行高或视口高度变了：把"视口中心那一天"钉回原位。
        // 用具体日期而不是行序号/像素比例 —— 月份周数变化会让行高反复变，
        // 只有按天锚定才不会来回漂（实测按行序号连续缩放会漂到别的月份）。
        const weeks = (weekStartOf(prev.centerDay) - rangeStart) / 7;
        rowHRef.current = measured;
        prevRowHRef.current = measured;
        el.scrollTop = Math.max(0, (weeks + 0.5) * measured - el.clientHeight / 2);
        lastFrameRef.current = {
          rowH: measured,
          clientH: el.clientHeight,
          scrollTop: el.scrollTop,
          centerDay: prev.centerDay,
        };
        return;
      }
      rowHRef.current = measured;
      prevRowHRef.current = measured;
    } else if (measured > 0) {
      rowHRef.current = measured;
      prevRowHRef.current = measured;
    }
    lastFrameRef.current = {
      rowH: measured,
      clientH: el.clientHeight,
      scrollTop: el.scrollTop,
      centerDay:
        measured > 0 && rangeStart !== null
          ? rangeStart + Math.floor((el.scrollTop + el.clientHeight / 2) / measured) * 7 + 3
          : null,
    };
    if (trimHeadRef.current > 0) {
      el.scrollTop = Math.max(0, el.scrollTop - trimHeadRef.current * rowHRef.current);
      trimHeadRef.current = 0;
      lastFrameRef.current = null;
    }
    if (prependRef.current > 0) {
      // 向上补日期时把新增高度补给 scrollTop，视口内容保持不动
      el.scrollTop += prependRef.current * rowHRef.current;
      prependRef.current = 0;
    }
    // 首次渲染后把视口对准今天；之后只在显式跳转时才动。
    // 必须等可视高度量到（viewportH > 0）再定位：先用占位行高定位，
    // 行高随后被改成真实值，scrollTop 的含义就全变了，会漂到别的月份。
    const target =
      scrollTargetRef.current ??
      (initializedRef.current || today === null || viewportH === 0 ? null : today);
    if (target !== null && rangeStart !== null) {
      const targetWeek = weekStartOf(target);
      // 目标还不在当前窗口里（刚触发扩范围、要下一帧才生效）：先别用旧 rangeStart 换算，
      // 否则会整整偏一段，跳到一个不相干的月份去。
      if (targetWeek < rangeStart || targetWeek >= rangeStart + rangeWeeks * 7) return;
      initializedRef.current = true;
      const index = Math.round((targetWeek - rangeStart) / 7);
      // 把目标周放到视口中部，这样 handleScroll 用"中心"推导月份时与目标一致
      const centered = index * rowHRef.current - el.clientHeight / 2 + rowHRef.current / 2;
      el.scrollTop = Math.max(0, centered);
      scrollTargetRef.current = null;
      setVisibleAnchor(target);
    }
  });

  /**
   * 跟踪日历可视高度：月视图行高按它分配，订单数量不参与。
   *
   * 首次渲染时还在"正在读取订单"的分支里，`.cal-scroll` 尚未挂载，
   * 所以这里不用依赖数组，每次渲染检查一次挂载元素是否换了。
   */
  useLayoutEffect(() => {
    const el = scrollEl.current;
    if (el === null) return;
    if (observedScrollRef.current === el) return;
    observedScrollRef.current = el;
    const update = () => setViewportH(el.clientHeight);
    update();
    if (typeof ResizeObserver === "undefined") return;
    viewportObserverRef.current?.disconnect();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    viewportObserverRef.current = observer;
  });

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
      // 未排期订单拖进格子：默认写交付日期（与「改期」默认预填交付一致），
      // 两个字段都会带进确认框，用户可以再改或清空。
      const plan = dropPlan(
        drag.order,
        day,
        drag.mode,
        drag.mode === "unscheduled" ? "delivery" : undefined,
      );
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
        setDialog({
          order: current.order,
          initial: current.plan,
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

  // 注意：这里必须用普通计算，不能用 useMemo —— 它位于条件 return 之后。
  const weeks = (() => {
    if (view === "week") return [weekDays(anchor)];
    const start = rangeStart ?? weekStartOf(anchor);
    return Array.from({ length: rangeWeeks }, (_, i) =>
      Array.from({ length: 7 }, (_, col) => start + i * 7 + col),
    );
  })();

  const monthAnchor = view === "month" ? (visibleAnchor ?? anchor) : anchor;
  const title = view === "month" ? monthTitle(monthAnchor) : weekTitle(anchor);
  const metrics =
    view === "month"
      ? monthGridMetrics(viewportH, weeksInMonth(monthAnchor ?? anchor))
      : weekGridMetrics();

  /**
   * 滚动窗口上限（周）。窗口本身是有界的，但**不是**用户能感觉到的墙：
   * 到上限时把另一端裁掉，而不是拒绝扩展 —— 之前"卡在 60 周"就是这么来的。
   */
  const MAX_WEEKS = 104;

  function extendWeeks(direction: "up" | "down") {
    if (today === null || rangeStart === null) return;
    if (direction === "up") {
      const nextStart = rangeStart - 12 * 7;
      prependRef.current = 12;
      setRangeStart(nextStart);
      // 超出上限就少补几周（尾部的行被裁掉），视口位置由 prepend 补偿保住
      setRangeWeeks((n) => Math.min(MAX_WEEKS, n + 12));
    } else {
      const nextEnd = rangeStart + (rangeWeeks + 12) * 7;
      void nextEnd;
      if (rangeWeeks + 12 <= MAX_WEEKS) {
        setRangeWeeks((n) => n + 12);
        return;
      }
      // 已到窗口上限：把头部整段裁掉，总行数不变，滚动继续往未来走
      setRangeStart(rangeStart + 12 * 7);
      trimHeadRef.current = 12;
      setRangeWeeks(MAX_WEEKS);
    }
  }

  function handleScroll() {
    const el = scrollEl.current;
    if (el === null || rangeStart === null || rowHRef.current === 0) return;
    const rowH = rowHRef.current;
    // 月份归属按"视口内可见格子的多数票"决定：跨月那一周里 6 天属于本月、
    // 1 天属于下月时，标题不应该提前切到下个月。
    const firstRow = Math.max(0, Math.floor(el.scrollTop / rowH));
    const lastRow = Math.min(
      rangeWeeks - 1,
      Math.floor((el.scrollTop + Math.max(el.clientHeight - 1, 0)) / rowH),
    );
    // 只让"至少露出一半"的周行参与投票：贴在视口边上的半行不该决定整屏的月份
    const visibleRows: DayIndex[][] = [];
    for (let row = firstRow; row <= lastRow; row += 1) {
      const top = row * rowH;
      const overlap = Math.min(top + rowH, el.scrollTop + el.clientHeight) - Math.max(top, el.scrollTop);
      if (overlap < rowH * 0.5) continue;
      visibleRows.push(Array.from({ length: 7 }, (_, col) => rangeStart + row * 7 + col));
    }
    const winner = dominantMonthDay(visibleRows);
    if (winner !== null) {
      const current = visibleAnchor ?? anchor;
      if (current === null || monthKeyOf(winner) !== monthKeyOf(current)) setVisibleAnchor(winner);
    }
    // 接近上下边界时提前补数据，滚动本身不中断
    if (el.scrollTop < rowH * 4) extendWeeks("up");
    else if (el.scrollTop + el.clientHeight > el.scrollHeight - rowH * 4) extendWeeks("down");
  }

  /** 点击日期格：记录焦点；跨月时把当前可视月份切到那一天。 */
  function pickDay(day: DayIndex) {
    setFocusedDay(day);
    const base = visibleAnchor ?? anchor;
    if (base === null || monthKeyOf(day) !== monthKeyOf(base)) setVisibleAnchor(day);
  }

  /** 把某一天滚到视口（用于「今天」、月份跳转与视图切换）。 */
  function scrollToDay(day: DayIndex) {
    if (rangeStart === null) return;
    const needStart = weekStartOf(day) - 2 * 7;
    const needEnd = weekStartOf(day) + 3 * 7;
    if (needStart < rangeStart) {
      const add = Math.ceil((rangeStart - needStart) / 7) * 7;
      setRangeStart(rangeStart - add);
      setRangeWeeks((n) => n + add / 7);
    } else if (needEnd > rangeStart + rangeWeeks * 7) {
      const add = Math.ceil((needEnd - (rangeStart + rangeWeeks * 7)) / 7) * 7;
      setRangeWeeks((n) => n + add / 7);
    }
    scrollTargetRef.current = day;
    setVisibleAnchor(day);
  }

  function shift(direction: -1 | 1) {
    if (view === "week") {
      setAnchor((prev) => (prev === null ? prev : shiftWeek(prev, direction)));
      return;
    }
    const base = visibleAnchor ?? anchor;
    if (base === null) return;
    scrollToDay(shiftMonth(base, direction));
  }

  function switchView(next: CalendarView) {
    if (next === "week") {
      // 月 → 周：停在当前可视日期所在的周
      if (visibleAnchor !== null) setAnchor(visibleAnchor);
      setView("week");
      return;
    }
    // 周 → 月：把该周滚到视口中央附近
    const day = anchor;
    setView("month");
    if (day !== null) scrollToDay(day);
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
                    onMouseDown={(event) => event.preventDefault()}
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
              <button
                type="button"
                className="cal-today"
                onClick={() => {
                  setAnchor(today);
                  setFocusedDay(today);
                  if (view === "month") scrollToDay(today);
                  else setAnchor(today);
                }}
              >
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

          <div className="cal-scroll" ref={scrollEl} onScroll={handleScroll}>
          <CalendarGrid
            view={view}
            anchor={monthAnchor ?? anchor}
            today={today}
            weeks={weeks}
            orders={visible}
            metrics={metrics}
            preview={previewRange}
            focused={focusedDay}
            onOpenOrder={openOrder}
            onReschedule={openKeyboardDialog}
            onChipPointerDown={startDrag}
            onPickDay={pickDay}
          />
          </div>

          <div className="cal-hint-slot">
            {drag === null ? (
              <p className="cal-hint" role="status">
                拖动订单条可改期：拖两端改对应日期，拖条身整体平移。也可以聚焦订单后按 Enter 用「改期」。
              </p>
            ) : (
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
          </div>
        </section>
      </div>

      <RescheduleDialog
        open={dialog !== null}
        order={dialog?.order ?? null}
        initial={dialog?.initial ?? null}
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

