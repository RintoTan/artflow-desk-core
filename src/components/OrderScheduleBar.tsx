import type { OrderView } from "../bridge/commands";
import {
  barModel,
  deliveryLabel,
  type BarMarker,
  type DayIndex,
} from "../lib/scheduleBar";

const MARK_TITLE: Record<BarMarker["kind"], string> = {
  planStart: "计划开始",
  delivery: "计划交付",
  started: "实际开工",
  completed: "完成",
  cancelled: "取消",
};

type Props = {
  order: OrderView;
  window: { from: DayIndex; to: DayIndex };
  today: DayIndex;
  timeZone: string | null;
};

/**
 * 订单行里的只读排期轨道。
 *
 * - 纯展示：`aria-hidden`，不含按钮、不接指针事件，不能点也不能拖；
 * - 语义上区分"计划"与"实际"：区间是计划，圆点是实际事件；
 * - 未排期时不画轨道（不虚构区间）；
 * - 窄窗口由 CSS 隐藏轨道、显示 `.sched-text` 的日期文字，行高不变。
 */
export function OrderScheduleBar({ order, window, today, timeZone }: Props) {
  const model = barModel(order, window, today, timeZone);
  const label = deliveryLabel(order);
  const hasAnything = model.band !== null || model.markers.length > 0;

  return (
    <>
      {hasAnything && (
        <span
          className="sched"
          aria-hidden="true"
          data-empty="false"
          data-invalid-range={model.invalidRange ? "true" : undefined}
        >
          <span className="sched-track" />
          {model.band && (
            <span
              className="sched-band"
              style={{ left: `${model.band.leftPct}%`, width: `${model.band.widthPct}%` }}
            />
          )}
          <span className="sched-today" style={{ left: `${model.todayPct}%` }} />
          {model.markers.map((marker, index) => (
            <span
              key={`${marker.kind}-${index}`}
              className={`sched-mark sched-mark-${marker.kind} tone-${marker.tone}`}
              style={{ left: `${marker.pct}%` }}
              data-kind={marker.kind}
              data-tone={marker.tone}
              data-overflow={marker.overflow ?? undefined}
              data-label={MARK_TITLE[marker.kind]}
            />
          ))}
        </span>
      )}
      {label && <span className="sched-text">{label}</span>}
    </>
  );
}
