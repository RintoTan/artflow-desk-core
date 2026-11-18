import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api, describeError, type OrderView } from "../bridge/commands";
import { formatDayKey, localDayIndex, shortDate, type DayIndex } from "../lib/scheduleBar";
import {
  SCALE_CONFIG,
  buildTicks,
  canvasWidth,
  dayToX,
  rowGeometry,
  shiftAnchor,
  splitOrders,
  timelineWindow,
  visibleRange,
  type TimelineScale,
} from "../lib/timeline";

const SCALES: TimelineScale[] = ["day", "week", "month", "year"];

const LEGEND = [
  { key: "scheduled", label: "按排期" },
  { key: "dueSoon", label: "三日内" },
  { key: "today", label: "今天到期" },
  { key: "overdue", label: "已逾期" },
  { key: "terminal", label: "已结束" },
] as const;

type Tone = (typeof LEGEND)[number]["key"];

function toneOf(order: OrderView, terminal: boolean, invalidRange: boolean): Tone {
  if (terminal) return "terminal";
  if (invalidRange) return "scheduled";
  switch (order.deadlineState) {
    case "overdue":
      return "overdue";
    case "today":
      return "today";
    case "dueSoon":
      return "dueSoon";
    default:
      return "scheduled";
  }
}

function rangeText(from: DayIndex, to: DayIndex): string {
  return `${formatDayKey(from)} ~ ${formatDayKey(to)}`;
}

/**
 * 工作台里的跨订单项目时间线。
 *
 * 只读：不改任何日期，不写库。轨道表达「计划区间在哪」，不表达完成度；
 * 逾期只读后端的 `deadlineState`，不在前端重算。
 */
export function ProjectTimeline({ nowIso }: { nowIso?: string }) {
  const navigate = useNavigate();
  const [scale, setScale] = useState<TimelineScale>("month");
  const [anchor, setAnchor] = useState<DayIndex | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  const [orders, setOrders] = useState<OrderView[] | null>(null);
  const [timezone, setTimezone] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewport, setViewport] = useState(0);
  const [centerOn, setCenterOn] = useState<DayIndex | null>(null);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef(0);
  const hasDataRef = useRef(false);

  const load = useCallback(async () => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    const firstLoad = !hasDataRef.current;
    if (firstLoad) setLoading(true);
    try {
      const [status, list] = await Promise.all([api.status(), api.listOrders()]);
      if (requestId !== requestRef.current) return;
      setTimezone(status.workingTimezone);
      setOrders(list);
      hasDataRef.current = true;
      setLoadError(null);
      setRefreshError(null);
    } catch (error) {
      if (requestId !== requestRef.current) return;
      if (firstLoad) setLoadError(describeError(error));
      else setRefreshError(describeError(error));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, generation]);

  // 回到工作台（窗口重新获得焦点）时刷新；不做定时轮询。
  useEffect(() => {
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  useEffect(() => {
    const node = scrollerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setViewport(node.clientWidth));
    observer.observe(node);
    setViewport(node.clientWidth);
    return () => observer.disconnect();
  }, [orders, loading, loadError]);

  const today = useMemo(() => {
    if (!timezone) return null;
    return localDayIndex(nowIso ?? new Date().toISOString(), timezone);
  }, [timezone, nowIso]);

  const effectiveAnchor = anchor ?? today;
  const win = useMemo(
    () => (effectiveAnchor === null ? null : timelineWindow(scale, effectiveAnchor)),
    [scale, effectiveAnchor],
  );
  const ticks = useMemo(
    () => (win === null || today === null ? null : buildTicks(win, scale, today)),
    [win, scale, today],
  );
  const split = useMemo(
    () => splitOrders(orders ?? [], showTerminal),
    [orders, showTerminal],
  );

  // 首次进入、点「今天」、切尺度后把参照点放到视口 45% 处。
  useEffect(() => {
    if (centerOn === null || win === null || viewport === 0) return;
    const node = scrollerRef.current;
    if (!node) return;
    const x = dayToX(centerOn, win, scale) + SCALE_CONFIG[scale].pxPerDay / 2;
    node.scrollLeft = Math.max(0, x - viewport * 0.45);
    setScrollLeft(node.scrollLeft);
    setCenterOn(null);
  }, [centerOn, win, scale, viewport]);

  useEffect(() => {
    if (orders === null || today === null) return;
    setCenterOn(today);
  }, [orders, today]);

  const gotoOrder = useCallback(
    (id: string) => {
      navigate(`/orders?orderId=${encodeURIComponent(id)}`);
    },
    [navigate],
  );

  const goToday = () => {
    setAnchor(today);
    setCenterOn(today);
  };

  const changeScale = (next: TimelineScale) => {
    setScale(next);
    if (effectiveAnchor !== null) setCenterOn(effectiveAnchor);
  };

  const shift = (direction: -1 | 1) => {
    if (effectiveAnchor === null) return;
    setAnchor(shiftAnchor(scale, effectiveAnchor, direction));
    const node = scrollerRef.current;
    if (node) {
      node.scrollLeft = 0;
      setScrollLeft(0);
    }
  };

  if (loading) {
    return (
      <section className="panel" aria-busy="true">
        <h2>跨订单项目时间线</h2>
        <p className="muted">正在读取订单与工作时区…</p>
      </section>
    );
  }

  if (loadError || !orders || today === null || win === null || ticks === null) {
    return (
      <section className="panel panel-error">
        <h2>无法读取时间线</h2>
        <p className="muted">订单或工作时区读取失败，时间线不会用示例数据代替真实数据。</p>
        <p className="mono">{loadError ?? "缺少工作时区或订单数据"}</p>
        <button type="button" className="btn" onClick={() => setGeneration((n) => n + 1)}>
          重试
        </button>
      </section>
    );
  }

  const total = canvasWidth(win, scale);
  const todayX = dayToX(today, win, scale) + SCALE_CONFIG[scale].pxPerDay / 2;
  const todayInside = today >= win.from && today <= win.to;
  const visible = visibleRange(win, scale, scrollLeft, viewport);
  // 只要现存订单里存在终态、且当前没有可见订单，就说明"活动订单已全部结束"。
  // 这里不能要求终态订单有日期：已完成/已取消的订单通常两个日期都为空。
  const hiddenByTerminal =
    !showTerminal &&
    split.scheduled.length === 0 &&
    split.unscheduled.length === 0 &&
    orders.some((order) => order.status !== "active");

  return (
    <section className="panel" aria-labelledby="timeline-title">
      <header className="panel-head timeline-head">
        <div>
          <h2 id="timeline-title">跨订单项目时间线</h2>
          <p id="timeline-subtitle" className="muted">
            只读 · {SCALE_CONFIG[scale].label}尺度 · 按计划日期绘制 · 不表示完成进度 · 逾期读后端判定
          </p>
        </div>
        <div className="timeline-controls">
          <button type="button" className="btn btn-icon" aria-label="上一时间段" onClick={() => shift(-1)}>
            ‹
          </button>
          <button type="button" className="btn" onClick={goToday}>
            今天
          </button>
          <button type="button" className="btn btn-icon" aria-label="下一时间段" onClick={() => shift(1)}>
            ›
          </button>
          <div className="segmented" role="group" aria-label="时间尺度">
            {SCALES.map((item) => (
              <button
                key={item}
                type="button"
                className={`filter-chip${item === scale ? " filter-chip-active" : ""}`}
                aria-pressed={item === scale}
                onClick={() => changeScale(item)}
              >
                {SCALE_CONFIG[item].label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="timeline-meta">
        <p className="timeline-range" data-testid="timeline-range">
          可见 <strong>{rangeText(visible.from, visible.to)}</strong> · 窗口 {rangeText(win.from, win.to)}
          {" · "}
          {SCALE_CONFIG[scale].label}尺度 · 时间线 {split.scheduled.length} 单 · 完全未排期{" "}
          {split.unscheduled.length} 单 · 共 {orders.length} 单
        </p>
        <ul className="timeline-legend" aria-label="排期状态图例">
          {LEGEND.map((item) => (
            <li key={item.key}>
              <i aria-hidden="true" className={`timeline-legend-swatch tone-${item.key}`} />
              <span>{item.label}</span>
            </li>
          ))}
        </ul>
        <label className="timeline-toggle">
          <input
            type="checkbox"
            checked={showTerminal}
            onChange={(event) => setShowTerminal(event.target.checked)}
          />
          显示已结束
        </label>
        <button
          type="button"
          className="btn timeline-refresh"
          onClick={() => setGeneration((n) => n + 1)}
        >
          刷新
        </button>
      </div>

      {refreshError && (
        <div className="timeline-notice" role="status">
          <span>刷新失败，仍显示上次读取的数据：{refreshError}</span>
          <button type="button" className="btn" onClick={() => setGeneration((n) => n + 1)}>
            重新尝试
          </button>
        </div>
      )}

      {split.scheduled.length === 0 ? (
        <div className="timeline-empty">
          {orders.length === 0 ? (
            <>
              <strong>尚无订单</strong>
              <span>
                先在「订单」里创建委托；填了计划开始或交付日期后，订单会出现在这条时间线上。
              </span>
            </>
          ) : hiddenByTerminal ? (
            <>
              <strong>活动订单已全部结束</strong>
              <span>勾选「显示已结束」可以查看已完成与已取消订单的排期。</span>
            </>
          ) : (
            <>
              <strong>没有任何订单填入计划日期</strong>
              <span>补上计划开始或交付日期后，订单会自动进入时间线；也可以先看下面的完全未排期列表。</span>
            </>
          )}
        </div>
      ) : (
        <div className="timeline-frame" data-testid="timeline-frame">
          <div className="timeline-info-col">
            <div className="timeline-corner">订单 / 客户 / 阶段</div>
            {split.scheduled.map((order) => {
              const geo = rowGeometry(order, win, today, timezone, scale);
              const tone = toneOf(order, geo.terminal, geo.invalidRange);
              const sub = [
                order.clientName,
                order.currentStageTitle,
                order.amountCents === null ? null : `¥${(order.amountCents / 100).toLocaleString("zh-CN")}`,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <a
                  key={order.id}
                  className="timeline-info"
                  href={`/orders?orderId=${encodeURIComponent(order.id)}`}
                  data-order-id={order.id}
                  data-tone={tone}
                  title={order.title}
                  onClick={(event) => {
                    event.preventDefault();
                    gotoOrder(order.id);
                  }}
                >
                  <span className="timeline-code">{order.code}</span>
                  <span className="timeline-title">{order.title}</span>
                  <span className="timeline-sub">{sub}</span>
                </a>
              );
            })}
          </div>

          <div
            className="timeline-scroll"
            ref={scrollerRef}
            tabIndex={0}
            role="group"
            aria-label="时间轨道，可横向滚动"
            onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
          >
            <div className="timeline-canvas" style={{ width: `${total}px` }} data-testid="timeline-canvas">
              <div className="timeline-axis">
                <div className="timeline-tier timeline-tier-1">
                  {ticks.tier1.map((tick) => (
                    <span
                      key={`t1-${tick.day}`}
                      className="timeline-tick"
                      style={{ left: `${tick.left}px`, width: `${Math.max(1, tick.width)}px` }}
                    >
                      <span className="timeline-tick-text">{tick.label}</span>
                    </span>
                  ))}
                </div>
                <div className="timeline-tier timeline-tier-2">
                  {ticks.tier2.map((tick) => (
                    <span
                      key={`t2-${tick.day}`}
                      className={`timeline-tick${tick.isToday ? " is-today" : ""}`}
                      style={{ left: `${tick.left}px`, width: `${Math.max(1, tick.width)}px` }}
                    >
                      <span className="timeline-tick-text">
                        {tick.label}
                        {tick.sub && <span className="timeline-tick-sub">{tick.sub}</span>}
                      </span>
                    </span>
                  ))}
                </div>
                {todayInside && (
                  <span className="timeline-today-flag" style={{ left: `${todayX}px` }}>
                    今天
                  </span>
                )}
              </div>

              <div className="timeline-grid" aria-hidden="true">
                {ticks.boundaries.map((left, index) => (
                  <span key={`grid-${index}`} className="timeline-grid-line" style={{ left: `${left}px` }} />
                ))}
              </div>

              {todayInside && (
                <span className="timeline-today-line" style={{ left: `${todayX}px` }} aria-hidden="true" />
              )}

              <div className="timeline-rows">
                {split.scheduled.map((order) => {
                  const geo = rowGeometry(order, win, today, timezone, scale);
                  const tone = toneOf(order, geo.terminal, geo.invalidRange);
                  const singleDay =
                    order.plannedStartDate !== null &&
                    order.plannedStartDate === order.plannedDeliveryDate;
                  // 标签不能钉在画布左端：画布比视口宽，钉死会滚出视野。
                  const pinnedLeft = scrollLeft + 12;
                  const startMarker = geo.markers.find((marker) => marker.kind === "planStart");
                  const deliveryMarker = geo.markers.find((marker) => marker.kind === "delivery");
                  return (
                    <div
                      key={order.id}
                      className={`timeline-row${geo.terminal ? " is-terminal" : ""}`}
                      data-order-id={order.id}
                      data-tone={tone}
                      onClick={() => gotoOrder(order.id)}
                      title={`${order.code} · ${order.title}`}
                    >
                      {geo.band && (
                        <span
                          className={`timeline-bar tone-${tone}${singleDay ? " is-single" : ""}`}
                          style={{ left: `${geo.band.left}px`, width: `${geo.band.width}px` }}
                          data-clip={
                            geo.band.clippedLeft ? "left" : geo.band.clippedRight ? "right" : undefined
                          }
                        />
                      )}
                      {geo.band?.clippedLeft && (
                        <span
                          className="timeline-edge"
                          style={{ left: 0 }}
                          title={`计划开始早于窗口：${order.plannedStartDate ?? ""}`}
                          aria-hidden="true"
                        >
                          ◀
                        </span>
                      )}
                      {geo.band?.clippedRight && (
                        <span
                          className="timeline-edge is-right"
                          style={{ right: 0 }}
                          title={`计划交付晚于窗口：${order.plannedDeliveryDate ?? ""}`}
                          aria-hidden="true"
                        >
                          ▶
                        </span>
                      )}
                      {!geo.band &&
                        geo.markers.map((marker) => (
                          <span
                            key={`${marker.kind}-${marker.day}`}
                            className={`timeline-mark is-${marker.kind} tone-${marker.tone === "neutral" ? "terminal" : marker.tone}`}
                            style={{ left: `${marker.x}px` }}
                            data-overflow={marker.overflow ?? undefined}
                            title={`${marker.kind === "planStart" ? "计划开始" : "计划交付"} ${formatDayKey(marker.day)}`}
                          />
                        ))}
                      {geo.invalidRange && (
                        <span className="timeline-tag is-alert" style={{ left: `${pinnedLeft}px` }}>
                          日期顺序异常
                        </span>
                      )}
                      {geo.fullyOutside && (
                        <span className="timeline-tag" style={{ left: `${pinnedLeft}px` }}>
                          窗口外：{order.plannedStartDate} → {order.plannedDeliveryDate}
                        </span>
                      )}
                      {!geo.band && !geo.invalidRange && startMarker && !deliveryMarker && (
                        <span
                          className="timeline-tag"
                          style={{ left: `${Math.min(startMarker.x + 10, total - 52)}px` }}
                        >
                          仅开始
                        </span>
                      )}
                      {!geo.band && !geo.invalidRange && !startMarker && deliveryMarker && (
                        <span
                          className="timeline-tag"
                          style={{ left: `${Math.min(deliveryMarker.x + 10, total - 52)}px` }}
                        >
                          仅交付
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="timeline-unscheduled">
        <h3>
          完全未排期 <span className="timeline-count">{split.unscheduled.length}</span>
        </h3>
        {split.unscheduled.length === 0 ? (
          <p className="muted">没有两个日期都为空的订单。仅有开始日期的订单仍然显示在时间线上。</p>
        ) : (
          <ul>
            {split.unscheduled.map((order) => (
              <li key={order.id}>
                <a
                  href={`/orders?orderId=${encodeURIComponent(order.id)}`}
                  data-order-id={order.id}
                  onClick={(event) => {
                    event.preventDefault();
                    gotoOrder(order.id);
                  }}
                >
                  <span className="mono">{order.code}</span>
                  <span>{order.title}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="muted timeline-hint">
        轨道只表示计划日期的位置，不表示完成度。横向滚动只作用于右侧轨道，左侧订单列固定不动；
        {shortDate(today)} 为工作时时区（{timezone}）的今天。
      </p>
    </section>
  );
}
