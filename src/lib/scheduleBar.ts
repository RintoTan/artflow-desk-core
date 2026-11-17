import type { DeadlineState, OrderView } from "../bridge/commands";

/**
 * 订单排期条的数据模型（纯函数，无 DOM、无时间副作用）。
 *
 * 三条硬规则：
 *   1. 日期一律按**工作日历日**计算，用整数天序号做差，绝不拿毫秒除以 86400000；
 *   2. UTC 瞬时转工作时区日期用 `Intl.DateTimeFormat.formatToParts()` 取值，
 *      不解析本地化字符串（`en-US` 的 `03/04/2026` 到底谁是月谁是日，不该靠约定）；
 *   3. 风险分类**只读**后端给的 `deadlineState`，这里不重新判定逾期/今天/三日内。
 */

/** 1970-01-01 起的天序号（按日历日，不是时间戳）。 */
export type DayIndex = number;

export const WINDOW_HALF_DAYS = 45;

/** 公历日期 → 天序号（Howard Hinnant 的 days_from_civil，纯整数运算）。 */
export function daysFromCivil(year: number, month: number, day: number): DayIndex {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** 天序号 → 公历日期（civil_from_days）。 */
export function civilFromDays(index: DayIndex): { year: number; month: number; day: number } {
  const z = index + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return { year: y + (month <= 2 ? 1 : 0), month, day };
}

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` → 天序号；格式或日期本身非法（2 月 30 日）时返回 null。 */
export function parseDayKey(value: string | null | undefined): DayIndex | null {
  if (!value) return null;
  const match = DAY_KEY.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const index = daysFromCivil(year, month, day);
  const round = civilFromDays(index);
  // 2 月 30 日会滚到 3 月，回读不一致即视为非法
  if (round.year !== year || round.month !== month || round.day !== day) return null;
  return index;
}

export function formatDayKey(index: DayIndex): string {
  const { year, month, day } = civilFromDays(index);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** `MM-DD`，给窄窗口的降级文字用。 */
export function shortDate(index: DayIndex): string {
  const { month, day } = civilFromDays(index);
  return `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * UTC 瞬时 → 工作时区的日历日。时区名非法时返回 null（调用方按"没有日期"处理），
 * 绝不让一个坏时区把整页渲染炸掉。
 */
export function localDayKey(
  instantIso: string | null | undefined,
  timeZone: string | null | undefined,
): string | null {
  if (!instantIso || !timeZone) return null;
  const date = new Date(instantIso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const pick = (type: "year" | "month" | "day") =>
      parts.find((part) => part.type === type)?.value ?? "";
    const year = pick("year");
    const month = pick("month");
    const day = pick("day");
    if (!year || !month || !day) return null;
    return `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  } catch {
    return null;
  }
}

export function localDayIndex(
  instantIso: string | null | undefined,
  timeZone: string | null | undefined,
): DayIndex | null {
  return parseDayKey(localDayKey(instantIso, timeZone));
}

/** 固定窗口：今天前后各 45 天。所有行共用，不随筛选/排序变化。 */
export function buildWindow(today: DayIndex, half = WINDOW_HALF_DAYS): {
  from: DayIndex;
  to: DayIndex;
} {
  return { from: today - half, to: today + half };
}

/** planStart 是"计划开始"，started 是"实际开工"，两者形状与含义都不同。 */
/**
 * 详情页用的自适应窗口：把这张订单的全部日期与"今天"包进去，
 * 两侧留 8% 余量。跨度超过 `maxSpan`（默认两年）时以今天为中心截断，
 * 超出的日期仍会以越界箭头标出，不会被悄悄挪到边界上冒充当天。
 */
export function scheduleWindowFor(
  order: Pick<
    OrderView,
    | "status"
    | "plannedStartDate"
    | "plannedDeliveryDate"
    | "startedAt"
    | "completedAt"
    | "cancelledAt"
  >,
  today: DayIndex,
  timeZone: string | null | undefined,
  maxSpan = 730,
): { from: DayIndex; to: DayIndex } | null {
  const days = [
    parseDayKey(order.plannedStartDate),
    parseDayKey(order.plannedDeliveryDate),
    localDayIndex(order.startedAt, timeZone),
    order.status === "complete" ? localDayIndex(order.completedAt, timeZone) : null,
    order.status === "cancelled" ? localDayIndex(order.cancelledAt, timeZone) : null,
  ].filter((day): day is DayIndex => day !== null);

  if (!days.length) return null;

  const withToday = [...days, today];
  let min = Math.min(...withToday);
  let max = Math.max(...withToday);
  const span = max - min;
  const pad = Math.max(2, Math.round(span * 0.08));
  min -= pad;
  max += pad;

  if (max - min > maxSpan) {
    const half = Math.floor(maxSpan / 2);
    min = today - half;
    max = today + half;
  }
  return { from: min, to: max };
}

export type MarkerKind = "planStart" | "delivery" | "started" | "completed" | "cancelled";

export type BarMarker = {
  kind: MarkerKind;
  /** 0–100，已钳在窗口内 */
  pct: number;
  /** 风险色类名；非交付标记一律 neutral */
  tone: string;
  /** 真实日期在窗口外时标记方向，用于画越界箭头 */
  overflow: "left" | "right" | null;
  day: DayIndex;
};

export type BarModel = {
  band: { leftPct: number; widthPct: number } | null;
  markers: BarMarker[];
  todayPct: number;
  /** 计划开始晚于计划交付：不画区间，只留两个点，界面照常可用 */
  invalidRange: boolean;
};

const TONE_BY_STATE: Record<DeadlineState, string> = {
  overdue: "overdue",
  today: "today",
  dueSoon: "dueSoon",
  scheduled: "scheduled",
  unscheduled: "unscheduled",
};

function pctOf(day: DayIndex, from: DayIndex, to: DayIndex): number {
  const span = to - from || 1;
  return ((day - from) / span) * 100;
}

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function overflowOf(day: DayIndex, from: DayIndex, to: DayIndex): "left" | "right" | null {
  if (day < from) return "left";
  if (day > to) return "right";
  return null;
}

export function barModel(
  order: Pick<
    OrderView,
    | "status"
    | "deadlineState"
    | "plannedStartDate"
    | "plannedDeliveryDate"
    | "startedAt"
    | "completedAt"
    | "cancelledAt"
  >,
  window: { from: DayIndex; to: DayIndex },
  today: DayIndex,
  timeZone: string | null | undefined,
): BarModel {
  const { from, to } = window;
  const start = parseDayKey(order.plannedStartDate);
  const delivery = parseDayKey(order.plannedDeliveryDate);
  const terminal = order.status !== "active";

  // 终态订单不参与风险判定（后端已把 deadlineState 归为 scheduled），轨道转中性
  const deliveryTone = terminal ? "neutral" : TONE_BY_STATE[order.deadlineState] ?? "neutral";

  let band: BarModel["band"] = null;
  let invalidRange = false;
  if (start !== null && delivery !== null) {
    if (delivery < start) {
      // 反向区间：只画点，不画会误导人的"很长一段"
      invalidRange = true;
    } else {
      const left = Math.max(from, start);
      const right = Math.min(to, delivery);
      if (right >= left) {
        band = {
          leftPct: clampPct(pctOf(left, from, to)),
          widthPct: clampPct(pctOf(right, from, to)) - clampPct(pctOf(left, from, to)),
        };
      }
    }
  }

  const markers: BarMarker[] = [];
  const push = (kind: MarkerKind, day: DayIndex | null, tone: string) => {
    if (day === null) return;
    markers.push({
      kind,
      day,
      tone,
      pct: clampPct(pctOf(day, from, to)),
      overflow: overflowOf(day, from, to),
    });
  };

  // 有计划开始但没有区间（缺交付日 / 反向区间）时，单独给一个计划开始点；
  // 有区间时左端就是它，不必重复画。
  if (start !== null && band === null) {
    push("planStart", start, terminal ? "neutral" : "scheduled");
  }
  push("delivery", delivery, deliveryTone);
  push("started", localDayIndex(order.startedAt, timeZone), "neutral");
  // 终态标记只看当前有效状态，不从历史事件反推
  if (order.status === "complete") {
    push("completed", localDayIndex(order.completedAt, timeZone), "neutral");
  } else if (order.status === "cancelled") {
    push("cancelled", localDayIndex(order.cancelledAt, timeZone), "neutral");
  }

  return {
    band,
    markers,
    todayPct: clampPct(pctOf(today, from, to)),
    invalidRange,
  };
}

/** 窄窗口降级文字用：只报计划交付，没有就不报（不虚构）。 */
export function deliveryLabel(order: Pick<OrderView, "plannedDeliveryDate">): string | null {
  const day = parseDayKey(order.plannedDeliveryDate);
  return day === null ? null : `交付 ${shortDate(day)}`;
}
