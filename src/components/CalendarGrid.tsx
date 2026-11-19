import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import type { OrderView } from "../bridge/commands";
import { civilFromDays, formatDayKey, type DayIndex } from "../lib/scheduleBar";
import {
  isSameMonth,
  layoutWeek,
  type CalendarView,
  type DropMode,
  type GridMetrics,
  type Segment,
} from "../lib/calendar";

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

export type ChipDragStart = {
  order: OrderView;
  mode: DropMode;
  event: React.PointerEvent<HTMLElement>;
};

type Props = {
  view: CalendarView;
  anchor: DayIndex;
  today: DayIndex;
  weeks: DayIndex[][];
  orders: OrderView[];
  /** 日期格度量：三段行高由页面按视口算出，订单数量不参与。 */
  metrics: GridMetrics;
  /** 选中的订单：原位置保留为参考（虚线幽灵），目标位置画预览条。 */
  preview: { orderId: string; from: DayIndex; to: DayIndex; valid: boolean } | null;
  /** 点击过（或当前聚焦）的日期。 */
  focused: DayIndex | null;
  onOpenOrder: (id: string) => void;
  onReschedule: (order: OrderView) => void;
  onChipPointerDown: (payload: ChipDragStart) => void;
  onPickDay: (day: DayIndex) => void;
};

function tone(order: OrderView): string {
  if (order.status === "cancelled") return "cancelled";
  if (order.status === "complete") return "complete";
  return order.deadlineState;
}

function Chip({
  segment,
  previewed,
  onOpenOrder,
  onReschedule,
  onChipPointerDown,
}: {
  segment: Segment;
  previewed: boolean;
  onOpenOrder: (id: string) => void;
  onReschedule: (order: OrderView) => void;
  onChipPointerDown: (payload: ChipDragStart) => void;
}) {
  const { order, kind, clippedLeft, clippedRight } = segment;
  const terminal = order.status !== "active";
  const single = kind === "single";
  const mode: DropMode = single ? "single" : "move";

  return (
    <div
      className="cal-seg"
      style={{ gridColumn: `${segment.colStart + 1} / ${segment.colEnd + 2}`, gridRow: segment.lane + 2 }}
    >
    <button
      type="button"
      className={`cal-chip tone-${tone(order)}${single ? " is-single" : ""}${
        terminal ? " is-terminal" : ""
      }${clippedLeft ? " is-clipped-left" : ""}${clippedRight ? " is-clipped-right" : ""}${
        previewed ? " is-ghost" : ""
      }`}
      data-order-id={order.id}
      data-kind={kind}
      data-mode={terminal ? "none" : mode}
      title={`${order.code} · ${order.title}（拖两端调整日期，拖中间整体移动）`}
      aria-label={`${order.code} ${order.title}`}
      onClick={(event) => {
        // 拖动过就不当成点击；单纯点击进入详情
        if (event.detail === 0) return; // 键盘 Enter 由 onKeyDown 处理
        onOpenOrder(order.id);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onOpenOrder(order.id);
        }
      }}
      // 不让按下把焦点落到条上：聚焦会触发浏览器"滚动到可见"，拖动一开始网格就会跳一下
      onMouseDown={(event) => {
        if (!terminal) event.preventDefault();
      }}
      onPointerDown={(event) => {
        if (terminal) return;
        if (event.button !== 0) return;
        event.preventDefault();
        // 三个操作区：左端改开始、右端改交付、条身整体平移。
        // 单日订单没有端点可分，统一整体移动。
        const rect = event.currentTarget.getBoundingClientRect();
        const ratio = rect.width === 0 ? 0.5 : (event.clientX - rect.left) / rect.width;
        const edge = Math.min(0.25, 12 / Math.max(rect.width, 1));
        let zone: DropMode = mode;
        if (!single) {
          if (ratio <= edge && !clippedLeft) zone = "start";
          else if (ratio >= 1 - edge && !clippedRight) zone = "delivery";
          else zone = "move";
        }
        onChipPointerDown({ order, mode: zone, event });
      }}
    >
      <span className="cal-chip-mark" aria-hidden="true" />
      <span className="cal-chip-text">{order.title}</span>
      {!single && !clippedLeft && (
        <span
          className="cal-chip-handle is-start"
          aria-hidden="true"
          title="调整开始日期"
        />
      )}
      {!single && !clippedRight && (
        <span
          className="cal-chip-handle is-end"
          aria-hidden="true"
          title="调整交付日期"
        />
      )}
      {!single && <span className="cal-chip-grip" aria-hidden="true" />}
    </button>
      {!terminal && (
        <button
          type="button"
          className="cal-chip-action"
          onClick={() => onReschedule(order)}
          aria-label={`为 ${order.code} 改期`}
        >
          改期
        </button>
      )}
    </div>
  );
}

export default function CalendarGrid({
  view,
  anchor,
  today,
  weeks,
  orders,
  metrics,
  preview,
  focused,
  onOpenOrder,
  onReschedule,
  onChipPointerDown,
  onPickDay,
}: Props) {
  const laneCount = metrics.lanes;
  const layouts = useMemo(
    () => weeks.map((week) => layoutWeek(orders, week[0] ?? 0, laneCount)),
    [weeks, orders, laneCount],
  );

  const [more, setMore] = useState<{ day: DayIndex; orders: OrderView[]; x: number; y: number } | null>(
    null,
  );

  const closeMore = useCallback(() => setMore(null), []);

  useEffect(() => {
    if (more === null) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      // 浮层内部：交给它自己的按钮处理，不在这里关闭
      if (target.closest(".cal-popover") !== null) return;
      // +N 自身：由它的 click 负责"开/关/切换"，避免先关再开
      if (target.closest(".cal-more") !== null) return;
      closeMore();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeMore();
      }
    };
    // 浮层是 position: fixed 的，跟随滚动会脱离锚点，所以滚动即关闭
    const onScroll = () => closeMore();
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [more, closeMore]);

  const templateRows = `${metrics.numH}px repeat(${laneCount}, ${metrics.laneH}px) ${metrics.moreH}px`;
  // 行高、条高、字号由页面按可用空间算好后统一挂成变量：同一个尺寸只管一处
  const vars = {
    "--cal-num-h": `${metrics.numH}px`,
    "--cal-more-h": `${metrics.moreH}px`,
    "--cal-chip-h": `${metrics.chipH}px`,
    "--cal-chip-font": `${metrics.fontPx}px`,
  } as React.CSSProperties;

  return (
    <div
      className={`cal-grid cal-view-${view}`}
      data-weeks={weeks.length}
      data-view={view}
      data-row-h={metrics.rowH}
      style={vars}
    >
      <div className="cal-weekdays" aria-hidden="true">
        {WEEKDAYS.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>

      {weeks.map((week, index) => {
        const layout = layouts[index] ?? layoutWeek([], week[0] ?? 0, laneCount);
        return (
          <div
            className="cal-week"
            key={week[0] ?? index}
            style={{ gridTemplateRows: templateRows }}
            data-row-h={metrics.rowH}
          >
            {week.map((day, col) => {
              const outside = !isSameMonth(day, anchor);
              return (
                <div
                  key={`bg-${day}`}
                  className="cal-day-bg"
                  data-day={day}
                  data-today={day === today ? "1" : undefined}
                  data-outside={outside ? "1" : undefined}
                  data-focus={day === focused ? "1" : undefined}
                  data-preview={
                    preview !== null && day >= preview.from && day <= preview.to
                      ? preview.valid
                        ? "1"
                        : "invalid"
                      : undefined
                  }
                  role="gridcell"
                  aria-label={formatDayKey(day)}
                  aria-selected={day === focused ? true : undefined}
                  style={{ gridColumn: col + 1 }}
                  onClick={(event) => {
                    // 拖动收尾那一下不算"选中日期"，避免拖完顺手改焦点
                    if (event.detail === 0) return;
                    onPickDay(day);
                  }}
                />
              );
            })}
            {week.map((day, col) => {
              const d = civilFromDays(day);
              const isToday = day === today;
              return (
                <div
                  key={`num-${day}`}
                  className={`cal-day-num${isToday ? " is-today" : ""}`}
                  style={{ gridColumn: col + 1 }}
                  data-outside={isSameMonth(day, anchor) ? undefined : "1"}
                  data-focus={day === focused ? "1" : undefined}
                  aria-hidden="true"
                >
                  {d.day === 1 && <span className="cal-day-month">{d.month} 月</span>}
                  <span className="cal-day-pill">{d.day}</span>
                </div>
              );
            })}

            {layout.segments.map((segment) => (
              <Chip
                key={`${segment.order.id}-${index}`}
                segment={segment}
                previewed={preview?.orderId === segment.order.id}
                onOpenOrder={onOpenOrder}
                onReschedule={onReschedule}
                onChipPointerDown={onChipPointerDown}
              />
            ))}

            {preview !== null &&
              preview.to >= week[0]! &&
              preview.from <= (week[6] ?? week[0]!) &&
              (() => {
                const colStart = Math.max(0, preview.from - week[0]!);
                const colEnd = Math.min(6, preview.to - week[0]!);
                return (
                  <div
                    className={`cal-preview${preview.valid ? "" : " is-invalid"}`}
                    style={{
                      left: `${(colStart / 7) * 100}%`,
                      width: `${((colEnd - colStart + 1) / 7) * 100}%`,
                    }}
                    data-valid={preview.valid ? "1" : "0"}
                    aria-hidden="true"
                  />
                );
              })()}

            {focused !== null && week[0] !== undefined && focused >= week[0] && focused <= week[0] + 6 && (
              <div
                className="cal-focus-ring"
                aria-hidden="true"
                style={{
                  left: `${((focused - week[0]) / 7) * 100}%`,
                  width: `${100 / 7}%`,
                }}
              />
            )}

            {week.map((day, col) => {
              const hidden = layout.hidden.get(day);
              if (!hidden || hidden.length === 0) return null;
              const open = more !== null && more.day === day;
              return (
                <button
                  key={`more-${day}`}
                  type="button"
                  className="cal-more"
                  style={{ gridColumn: col + 1, gridRow: laneCount + 2 }}
                  aria-expanded={open}
                  aria-label={`${formatDayKey(day)} 还有 ${hidden.length} 笔订单`}
                  // 按下不抢焦点：聚焦会触发 WebKit 把按钮滚进视口，
                  // 滚动事件会立刻把刚开的浮层关掉（原生窗口里表现为"点了没反应"）。
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    if (open) {
                      closeMore();
                      return;
                    }
                    const rect = event.currentTarget.getBoundingClientRect();
                    // 浮层宽 300、最高 320：贴边时要往回收，避免跑出视口。
                    // 下方放不下就翻到按钮上方 —— 否则浮层会盖住 +N 本身，
                    // 再点同一个 +N 就变成了"点在浮层里"，关了又像没反应。
                    const x = Math.max(8, Math.min(rect.left, window.innerWidth - 308));
                    const below = rect.bottom + 4;
                    const y =
                      below + 328 <= window.innerHeight - 8
                        ? below
                        : Math.max(8, rect.top - 328 - 4);
                    setMore({ day, orders: hidden, x, y });
                  }}
                >
                  +{hidden.length}
                </button>
              );
            })}
          </div>
        );
      })}

      {more !== null &&
        createPortal(
          <div
            className="cal-popover"
            role="dialog"
            aria-label={`${formatDayKey(more.day)} 的订单`}
            style={{ left: more.x, top: more.y }}
          >
            <header>
              <strong>{formatDayKey(more.day)}</strong>
              <button type="button" onClick={closeMore} aria-label="关闭">
                ×
              </button>
            </header>
            <ul>
              {more.orders.map((order) => (
                <li key={order.id}>
                  <div className="cal-popover-order">
                    <span className="mono">{order.code}</span>
                    <strong>{order.title}</strong>
                    <span className="cal-popover-dates">
                      {order.plannedStartDate ?? "未设置"} → {order.plannedDeliveryDate ?? "未设置"}
                    </span>
                  </div>
                  <div className="cal-popover-actions">
                    <button
                      type="button"
                      onClick={() => {
                        closeMore();
                        onOpenOrder(order.id);
                      }}
                    >
                      详情
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        closeMore();
                        onReschedule(order);
                      }}
                      disabled={order.status !== "active"}
                    >
                      改期
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>,
          document.body,
        )}
    </div>
  );
}
