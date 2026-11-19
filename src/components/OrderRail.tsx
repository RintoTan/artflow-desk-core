import { useEffect, useRef, useState } from "react";

import type { OrderView } from "../bridge/commands";
import { isTerminal, orderSpan } from "../lib/calendar";

export type RailSection = "unscheduled" | "scheduled" | "done";

type Props = {
  orders: OrderView[];
  query: string;
  onQuery: (value: string) => void;
  focusedOrderId: string | null;
  flashOrderId: string | null;
  /** 顶部「显示已结束」打开时，完成分区跟着展开。 */
  showTerminal: boolean;
  onOpenOrder: (order: OrderView) => void;
  onReschedule: (order: OrderView) => void;
  onLocate: (order: OrderView) => void;
  onDragStart: (order: OrderView, event: React.PointerEvent<HTMLElement>) => void;
};

function GripIcon() {
  return (
    <svg viewBox="0 0 12 16" width="10" height="14" aria-hidden="true" focusable="false">
      {[3, 8, 13].map((y) =>
        [4, 8].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.15" fill="currentColor" />),
      )}
    </svg>
  );
}

function PinIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path
        d="M8 1.6c-2.5 0-4.5 2-4.5 4.4 0 3.2 4.5 8.4 4.5 8.4s4.5-5.2 4.5-8.4c0-2.4-2-4.4-4.5-4.4Zm0 6.2a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6Z"
        fill="currentColor"
      />
    </svg>
  );
}

const SECTIONS: { key: RailSection; label: string }[] = [
  { key: "unscheduled", label: "未排期订单" },
  { key: "scheduled", label: "排期订单" },
  { key: "done", label: "完成订单" },
];

function matches(order: OrderView, needle: string): boolean {
  if (needle === "") return true;
  const haystack = [order.code, order.title, order.clientName ?? ""].join(" ").toLowerCase();
  return haystack.includes(needle);
}

export default function OrderRail({
  orders,
  query,
  onQuery,
  focusedOrderId,
  flashOrderId,
  showTerminal,
  onOpenOrder,
  onReschedule,
  onLocate,
  onDragStart,
}: Props) {
  const [open, setOpen] = useState<Record<RailSection, boolean>>({
    unscheduled: true,
    scheduled: true,
    done: false,
  });
  const listRef = useRef<HTMLDivElement | null>(null);
  const needle = query.trim().toLowerCase();

  const buckets: Record<RailSection, OrderView[]> = { unscheduled: [], scheduled: [], done: [] };
  for (const order of orders) {
    if (!matches(order, needle)) continue;
    if (isTerminal(order)) buckets.done.push(order);
    else if (orderSpan(order) === null) buckets.unscheduled.push(order);
    else buckets.scheduled.push(order);
  }
  const searching = needle !== "";
  const total = buckets.unscheduled.length + buckets.scheduled.length + buckets.done.length;

  // 定位到左侧卡片：分区折叠就展开，卡片不在视口里就滚过去
  useEffect(() => {
    if (flashOrderId === null) return;
    const section = SECTIONS.find((s) =>
      buckets[s.key].some((order) => order.id === flashOrderId),
    );
    if (section !== undefined) {
      setOpen((prev) => (prev[section.key] ? prev : { ...prev, [section.key]: true }));
    }
    const frame = window.requestAnimationFrame(() => {
      const card = listRef.current?.querySelector<HTMLElement>(
        `[data-rail-order="${flashOrderId}"]`,
      );
      card?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
    // buckets 每次渲染都是新对象，用 id 与查询串作为触发条件
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flashOrderId]);

  return (
    <aside className="cal-rail" aria-label="订单导航">
      <div className="cal-rail-search">
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" className="cal-rail-search-icon">
          <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="m10.4 10.4 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="搜索编号 / 标题 / 客户"
          aria-label="搜索订单"
        />
        {query !== "" && (
          <button type="button" className="cal-rail-clear" onClick={() => onQuery("")} aria-label="清空搜索">
            ×
          </button>
        )}
      </div>

      <div className="cal-rail-scroll" ref={listRef}>
        {searching && total === 0 && <p className="cal-empty">没有匹配的订单。</p>}

        {SECTIONS.map((section) => {
          const items = buckets[section.key];
          const expanded =
            searching || (section.key === "done" && showTerminal) || open[section.key];
          return (
            <section className={`cal-rail-section${expanded ? "" : " is-collapsed"}`} key={section.key}>
              <button
                type="button"
                className="cal-rail-head"
                aria-expanded={expanded}
                onClick={() => setOpen((prev) => ({ ...prev, [section.key]: !prev[section.key] }))}
                disabled={searching}
              >
                <span className={`cal-rail-caret${expanded ? " is-open" : ""}`} aria-hidden="true" />
                <span className="cal-rail-title">{section.label}</span>
                <span className="cal-count">{items.length}</span>
              </button>

              {expanded && (
                <ul className="cal-rail-list">
                  {items.length === 0 && <li className="cal-empty">没有。</li>}
                  {items.map((order) => {
                    const terminal = isTerminal(order);
                    const span = orderSpan(order);
                    const focused = focusedOrderId === order.id;
                    return (
                      <li
                        key={order.id}
                        className={[
                          "cal-rail-card",
                          focused ? "is-focused" : "",
                          flashOrderId === order.id ? "is-flash" : "",
                          terminal ? "is-terminal" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        data-rail-order={order.id}
                      >
                        {!terminal && (
                          <span
                            className="cal-rail-grip"
                            role="button"
                            tabIndex={-1}
                            aria-label={`拖动 ${order.code}`}
                            onPointerDown={(event) => {
                              if (event.button !== 0) return;
                              event.preventDefault();
                              onDragStart(order, event);
                            }}
                          >
                            <GripIcon />
                          </span>
                        )}

                        <button
                          type="button"
                          className="cal-rail-body"
                          onClick={(event) => {
                            if (event.detail === 0) return;
                            onOpenOrder(order);
                          }}
                        >
                          <span className="mono cal-rail-code">{order.code}</span>
                          <strong className="cal-rail-name">{order.title}</strong>
                          <span className="cal-rail-sub">
                            {order.clientName ?? "未关联客户"}
                            {span === null
                              ? terminal
                                ? " · 未参与排期"
                                : " · 未排期"
                              : terminal
                                ? " · 历史日期"
                                : ` · ${order.plannedStartDate ?? "—"} → ${order.plannedDeliveryDate ?? "—"}`}
                          </span>
                        </button>

                        {!terminal && (
                          <button
                            type="button"
                            className="cal-rail-reschedule"
                            onClick={() => onReschedule(order)}
                            aria-label={`为 ${order.code} 改期`}
                          >
                            改期
                          </button>
                        )}

                        <button
                          type="button"
                          className="cal-rail-pin"
                          onClick={(event) => {
                            event.stopPropagation();
                            onLocate(order);
                          }}
                          title="定位到日历"
                          aria-label={`定位 ${order.code}`}
                          aria-pressed={focused}
                        >
                          <PinIcon />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </aside>
  );
}
