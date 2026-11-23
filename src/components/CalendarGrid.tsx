import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import type { OrderView } from "../bridge/commands";
import { chipDropZone } from "../lib/chipZone";
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
  /** +N 放日期行右侧（格宽够时），否则占独立底部行。 */
  topMore: boolean;
  /** 图钉定位聚焦的订单：A 高亮、B 弱化其它条。 */
  focusedOrderId: string | null;
  /** 单击选中的订单（与键盘焦点分开：焦点决定 Tab 落点，选中决定灰底） */
  selectedOrderId?: string | null;
  onSelectOrder?: (id: string) => void;
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
  focusedOrderId,
  onOpenOrder,
  onReschedule,
  onChipPointerDown,
  selected,
  onSelect,
}: {
  segment: Segment;
  previewed: boolean;
  focusedOrderId: string | null;
  selected: boolean;
  onSelect: (id: string) => void;
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
      className={`cal-seg${focusedOrderId === order.id ? " is-focus-target" : ""}${
        terminal ? "" : " has-action"
      }`}
      style={{ gridColumn: `${segment.colStart + 1} / ${segment.colEnd + 2}`, gridRow: segment.lane + 2 }}
    >
    <button
      type="button"
      className={`cal-chip tone-${tone(order)}${single ? " is-single" : ""}${
        terminal ? " is-terminal" : ""
      }${clippedLeft ? " is-clipped-left" : ""}${clippedRight ? " is-clipped-right" : ""}${
        previewed ? " is-ghost" : ""
      }${selected ? " is-selected" : ""}`}
      aria-selected={selected}
      data-order-id={order.id}
      data-kind={kind}
      data-mode={terminal ? "none" : mode}
      title={`${order.code} · ${order.title}（拖两端调整日期，拖中间整体移动）`}
      aria-label={`${order.code} ${order.title}`}
      onClick={(event) => {
        // 拖动过就不当成点击；单击只选中，双击才进详情
        if (event.detail === 0) return; // 键盘 Enter 由 onKeyDown 处理
        onSelect(order.id);
      }}
      onDoubleClick={(event) => {
        if (event.detail < 2) return;
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
        const handle = (event.target as HTMLElement | null)?.closest?.(
          ".cal-chip-handle",
        ) as HTMLElement | null;
        const zone = chipDropZone({
          singleDay: single,
          clippedLeft,
          clippedRight,
          handle: handle?.classList.contains("is-start")
            ? "start"
            : handle?.classList.contains("is-end")
              ? "end"
              : null,
          ratio,
          width: rect.width,
        });
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
  topMore,
  focusedOrderId,
  selectedOrderId = null,
  onSelectOrder,
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

  /**
   * 定位到被折叠在 +N 里的订单：自动点开那一天的 +N。
   * 目标日可能还在渲染（滚动/展开是异步的），所以轮询到出现为止，最多约 1.2s。
   */
  useEffect(() => {
    if (focusedOrderId === null) return;
    let tries = 0;
    let timeout: number | undefined;
    const attempt = () => {
      const btn = document.querySelector<HTMLElement>(
        `button[data-more-orders~="${focusedOrderId}"]`,
      );
      if (btn !== null) {
        btn.click();
        window.setTimeout(() => {
          document
            .querySelector<HTMLElement>(".cal-popover .is-target")
            ?.scrollIntoView({ block: "nearest" });
        }, 40);
        return;
      }
      tries += 1;
      if (tries < 16) timeout = window.setTimeout(attempt, 80);
    };
    timeout = window.setTimeout(attempt, 40);
    return () => {
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [focusedOrderId]);

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
    // 浮层是 position: fixed 的，跟随滚动会脱离锚点，所以滚动即关闭；
    // 但浮层内部自己的滚动不能算——否则一滚内容就消失（macOS 触控板尤其明显）。
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".cal-popover") !== null) return;
      closeMore();
    };
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
    "--cal-lane-h": `${metrics.laneH}px`,
  } as React.CSSProperties;

  return (
    <div
      className={`cal-grid cal-view-${view}`}
      data-weeks={weeks.length}
      data-view={view}
      data-row-h={metrics.rowH}
      data-focus-order={focusedOrderId ?? undefined}
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
            data-start={week[0]}
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
                focusedOrderId={focusedOrderId}
                selected={selectedOrderId === segment.order.id}
                onSelect={onSelectOrder ?? (() => {})}
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
                // 预览条贴在"这笔订单在这周占用的那条轨道"上；找不到（跨周/新落点）
                // 就落到第 0 条轨道。绝不贴周行底部 —— 行高一变它就会跑到 +N 或下一行去。
                const lane = layout.segments.find((seg) => seg.order.id === preview.orderId)?.lane ?? 0;
                const top = metrics.numH + Math.min(lane, laneCount - 1) * metrics.laneH + 1;
                return (
                  <div
                    className={`cal-preview${preview.valid ? "" : " is-invalid"}`}
                    style={{
                      left: `${(colStart / 7) * 100}%`,
                      width: `${((colEnd - colStart + 1) / 7) * 100}%`,
                      top: `${top}px`,
                      height: `${metrics.chipH}px`,
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
                  data-slot={topMore ? "top" : "bottom"}
                  style={{ gridColumn: col + 1, gridRow: topMore ? 1 : laneCount + 2 }}
                  aria-expanded={open}
                  aria-label={`${formatDayKey(day)} 还有 ${hidden.length} 笔订单`}
                  // 按下不抢焦点：聚焦会触发 WebKit 把按钮滚进视口，
                  // 滚动事件会立刻把刚开的浮层关掉（原生窗口里表现为"点了没反应"）。
                  data-more-day={day}
                  data-more-orders={hidden.map((o) => o.id).join(" ")}
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
            onWheel={(event) => event.stopPropagation()}
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
                <li
                  key={order.id}
                  className={focusedOrderId === order.id ? "is-target" : undefined}
                >
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
