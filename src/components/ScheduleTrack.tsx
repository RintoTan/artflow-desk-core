import type { BarMarker, BarModel } from "../lib/scheduleBar";

const MARK_TITLE: Record<BarMarker["kind"], string> = {
  planStart: "计划开始",
  delivery: "计划交付",
  started: "实际开工",
  completed: "完成",
  cancelled: "取消",
};

/**
 * 排期轨道（详情页用，宽版）。
 *
 * 只做"位置"表达：计划区间、今天、四类事件标记。
 * 不表达"完成度"——时间过去了多少和画到哪一步没有业务关系。
 * 精确日期由旁边的文字表提供，这条轨道 `aria-hidden`，不是唯一信息源。
 */
export function ScheduleTrack({ model }: { model: BarModel }) {
  return (
    <div className="schedule-track" aria-hidden="true" data-invalid-range={model.invalidRange ? "true" : undefined}>
      <span className="schedule-rail" />
      {model.band && (
        <span
          className="schedule-band"
          style={{ left: `${model.band.leftPct}%`, width: `${model.band.widthPct}%` }}
        />
      )}
      <span className="schedule-today" style={{ left: `${model.todayPct}%` }}>
        <span className="schedule-today-label">今天</span>
      </span>
      {model.markers.map((marker, index) => (
        <span
          key={`${marker.kind}-${index}`}
          className={`schedule-mark schedule-mark-${marker.kind} tone-${marker.tone}`}
          style={{ left: `${marker.pct}%` }}
          data-kind={marker.kind}
          data-tone={marker.tone}
          data-overflow={marker.overflow ?? undefined}
          data-label={MARK_TITLE[marker.kind]}
        />
      ))}
    </div>
  );
}
