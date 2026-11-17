import type { OrderView } from "../bridge/commands";
import {
  barModel,
  civilFromDays,
  localDayIndex,
  parseDayKey,
  scheduleWindowFor,
  type DayIndex,
} from "../lib/scheduleBar";
import { ScheduleTrack } from "./ScheduleTrack";

type Props = {
  order: OrderView;
  today: DayIndex;
  timeZone: string | null;
};

const RISK_LABEL: Record<string, string> = {
  overdue: "已逾期",
  today: "今天到期",
  dueSoon: "三日内到期",
  scheduled: "按排期",
  unscheduled: "未排期",
};

/** 小时级时间戳只显示到分钟，日期部分用工作时区。 */
function instantLabel(iso: string | null, timeZone: string | null): string | null {
  if (!iso) return null;
  const day = localDayIndex(iso, timeZone);
  if (day === null) return null;
  const { year, month, day: date } = civilFromDays(day);
  const time = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timeZone ?? "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
  return `${year}-${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")} ${time}`;
}

/**
 * 订单详情里的「排期概览」。
 *
 * 两层：上层是能被复制的确切日期，下层是一条位置图。
 * 日期缺失写"未设置"，绝不编一个出来；终态用中性色，不沿用风险色。
 */
export function ScheduleOverview({ order, today, timeZone }: Props) {
  const window = scheduleWindowFor(order, today, timeZone);
  const hasPlan = parseDayKey(order.plannedStartDate) !== null || parseDayKey(order.plannedDeliveryDate) !== null;
  const started = instantLabel(order.startedAt, timeZone);
  const completed = order.status === "complete" ? instantLabel(order.completedAt, timeZone) : null;
  const cancelled = order.status === "cancelled" ? instantLabel(order.cancelledAt, timeZone) : null;
  const risk = order.status === "active" ? RISK_LABEL[order.deadlineState] ?? "按排期" : null;

  return (
    <section className="panel" aria-labelledby="schedule-heading">
      <header className="panel-head compact">
        <div>
          <h2 id="schedule-heading">排期概览</h2>
          <p className="muted">
            {hasPlan || started
              ? "计划日期是人工排期，与制作进度无关；实际开工来自生命周期事件。"
              : "这张订单还没有填写计划日期。"}
          </p>
        </div>
        {risk && <span className={`chip chip-risk-${order.deadlineState}`}>{risk}</span>}
      </header>

      {!hasPlan && !started && !completed && !cancelled ? (
        <p className="empty-inline">尚未设置计划排期。可以在下方「资料」里填写计划开始与交付日期。</p>
      ) : (
        <>
          <dl className="schedule-dates">
            <div>
              <dt>计划开始</dt>
              <dd>{order.plannedStartDate ?? <span className="muted">未设置</span>}</dd>
            </div>
            <div>
              <dt>计划交付</dt>
              <dd>{order.plannedDeliveryDate ?? <span className="muted">未设置</span>}</dd>
            </div>
            <div>
              <dt>实际开工</dt>
              <dd>{started ?? <span className="muted">尚未开工</span>}</dd>
            </div>
            {completed && (
              <div>
                <dt>完成于</dt>
                <dd>{completed}</dd>
              </div>
            )}
            {cancelled && (
              <div>
                <dt>取消于</dt>
                <dd>{cancelled}</dd>
              </div>
            )}
          </dl>

          {window ? (
            <ScheduleTrack model={barModel(order, window, today, timeZone)} />
          ) : null}

          <p className="hint schedule-hint">
            轨道只表示日期位置，不表示完成度。今天的位置按工作时区计算。
          </p>
        </>
      )}
    </section>
  );
}
