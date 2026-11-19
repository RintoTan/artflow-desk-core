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
  /** 选中的订单：原位置保留为参考（虚线幽灵），目标位置画预览条。 */
  preview: { orderId: string; from: DayIndex; to: DayIndex; valid: boolean } | null;
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
        previewed ? " is-ghost" : ""
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
                data-preview={
                  preview !== null && day >= preview.from && day <= preview.to
                    ? preview.valid
                      ? "1"
                      : "invalid"
                    : undefined
                }
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
