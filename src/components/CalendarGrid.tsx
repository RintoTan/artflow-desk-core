import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import type { OrderView } from "../bridge/commands";
import { civilFromDays, formatDayKey, type DayIndex } from "../lib/scheduleBar";
import {
  LANES,
  isSameMonth,
  layoutWeek,
  type CalendarView,
  type DropMode,
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
  /** 预览：某订单将被放到哪一天（只影响样式，不写库）。 */
  preview: { orderId: string; day: DayIndex } | null;
  onOpenOrder: (id: string) => void;
  onReschedule: (order: OrderView) => void;
  onChipPointerDown: (payload: ChipDragStart) => void;
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
        previewed ? " is-preview" : ""
      }`}
      data-order-id={order.id}
      data-kind={kind}
      data-mode={terminal ? "none" : mode}
      title={`${order.code} · ${order.title}`}
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
      onPointerDown={(event) => {
        if (terminal) return;
        if (event.button !== 0) return;
        event.preventDefault();
        onChipPointerDown({ order, mode, event });
      }}
    >
      <span className="cal-chip-mark" aria-hidden="true" />
      <span className="cal-chip-text">{order.title}</span>
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
  preview,
  onOpenOrder,
  onReschedule,
  onChipPointerDown,
}: Props) {
  const maxLanes = LANES[view];
  const layouts = useMemo(
    () => weeks.map((week) => layoutWeek(orders, week[0] ?? 0, maxLanes)),
    [weeks, orders, maxLanes],
  );

  const [more, setMore] = useState<{ day: DayIndex; orders: OrderView[]; x: number; y: number } | null>(
    null,
  );

  useEffect(() => {
    if (more === null) return;
    const close = () => setMore(null);
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, [more]);

  return (
    <div className={`cal-grid cal-view-${view}`}>
      <div className="cal-weekdays" aria-hidden="true">
        {WEEKDAYS.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>

      {weeks.map((week, index) => {
        const layout = layouts[index] ?? layoutWeek([], week[0] ?? 0, maxLanes);
        const outside = !isSameMonth(week[3] ?? anchor, anchor);
        return (
          <div
            className={`cal-week${outside ? " is-outside" : ""}`}
            key={week[0] ?? index}
            style={{ gridTemplateRows: `auto repeat(${maxLanes}, 22px) 18px` }}
          >
            {week.map((day, col) => (
              <div
                key={`bg-${day}`}
                className="cal-day-bg"
                data-day={day}
                data-today={day === today ? "1" : undefined}
                data-outside={isSameMonth(day, anchor) ? undefined : "1"}
                style={{ gridColumn: col + 1 }}
              />
            ))}
            {week.map((day, col) => {
              const d = civilFromDays(day);
              const isToday = day === today;
              return (
                <div
                  key={`num-${day}`}
                  className={`cal-day-num${isToday ? " is-today" : ""}`}
                  style={{ gridColumn: col + 1 }}
                  data-outside={isSameMonth(day, anchor) ? undefined : "1"}
                >
                  {d.day === 1 ? `${d.month} 月 ${d.day}` : d.day}
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

            {week.map((day, col) => {
              const hidden = layout.hidden.get(day);
              if (!hidden || hidden.length === 0) return null;
              return (
                <button
                  key={`more-${day}`}
                  type="button"
                  className="cal-more"
                  style={{ gridColumn: col + 1, gridRow: maxLanes + 2 }}
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setMore({ day, orders: hidden, x: rect.left, y: rect.bottom });
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
          <div className="cal-popover" role="dialog" aria-label={`${formatDayKey(more.day)} 的订单`} style={{ left: more.x, top: more.y }}>
            <header>
              <strong>{formatDayKey(more.day)}</strong>
              <button type="button" onClick={() => setMore(null)} aria-label="关闭">
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
                    <button type="button" onClick={() => onOpenOrder(order.id)}>
                      详情
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMore(null);
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
