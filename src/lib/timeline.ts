import type { OrderView } from "../bridge/commands";
import {
  barModel,
  civilFromDays,
  daysFromCivil,
  parseDayKey,
  type DayIndex,
} from "./scheduleBar";

/**
 * 工作台跨订单时间线的共享坐标系。
 *
 * 这里只做「多订单共用同一个窗口」需要的东西：窗口、刻度、天→像素、单行几何。
 * 单条排期的日期语义（区间、反向区间、越界、四类标记、风险色）全部来自
 * `scheduleBar.barModel`，本文件不复制那套判断。
 */

/** WB-01 只有日 / 月 / 年三个视图；日历页的周视图是另一套坐标系，不在此列。 */
export type TimelineScale = "day" | "month" | "year";

/**
 * 周起始偏移：0 = 周一（ISO 8601，暂定）。
 * 产品若改为周日起算，只改这一个常量；窗口对齐、刻度、刻线都会跟着变。
 */
export const WEEK_START_OFFSET = 0;

export type ScaleConfig = {
  label: string;
  pxPerDay: number;
  /** 单日区间的最小可见宽度；位置仍由真实日期决定 */
  minBarPx: number;
  /** 日/周：今天前后各取几天 */
  beforeDays?: number;
  afterDays?: number;
  /** 月/年：今天所在自然月/年前后各取几个 */
  beforeMonths?: number;
  afterMonths?: number;
  /** 上一段/下一段移动多少天（月/年走自然单位，不用这个值） */
  shiftDays?: number;
};

export const SCALE_CONFIG: Record<TimelineScale, ScaleConfig> = {
  day: { label: "日", pxPerDay: 44, minBarPx: 22, beforeDays: 7, afterDays: 13, shiftDays: 7 },
  month: { label: "月", pxPerDay: 6, minBarPx: 7, beforeMonths: 2, afterMonths: 10 },
  // 年视图：3 年跨度下单日只有 1.8px，短条改为 6px 圆点，保证仍可点。
  year: { label: "年", pxPerDay: 1.8, minBarPx: 6, beforeMonths: 12, afterMonths: 48 },
};

/** 周一 = 0（偏移后）。1970-01-01 是周四 → 在周一制里是 3。 */
export function weekdayIndex(day: DayIndex): number {
  return (((day + 3 - WEEK_START_OFFSET) % 7) + 7) % 7;
}

export type TimelineWindow = { from: DayIndex; to: DayIndex };

/** 月份天数由天序号推出，避免再维护一张月份长度表（也自动处理闰年）。 */
function daysInMonth(year: number, month: number): number {
  const start = daysFromCivil(year, month, 1);
  const next = month === 12 ? daysFromCivil(year + 1, 1, 1) : daysFromCivil(year, month + 1, 1);
  return next - start;
}

function monthStart(day: DayIndex): DayIndex {
  const c = civilFromDays(day);
  return daysFromCivil(c.year, c.month, 1);
}

function monthEnd(day: DayIndex): DayIndex {
  const c = civilFromDays(day);
  return daysFromCivil(c.year, c.month, daysInMonth(c.year, c.month));
}

/** 加月份并对齐到目标月末，避免 1-31 + 1 月溢出到 3 月。 */
export function addMonthsClamped(day: DayIndex, delta: number): DayIndex {
  const c = civilFromDays(day);
  const total = c.year * 12 + (c.month - 1) + delta;
  const year = Math.floor(total / 12);
  const month = total - year * 12 + 1;
  return daysFromCivil(year, month, Math.min(c.day, daysInMonth(year, month)));
}

/**
 * 四尺度窗口。月/年按自然月、自然年对齐；周按完整自然周对齐（周一 → 周日）。
 * 窗口只由尺度与锚点决定，与筛选无关：所有行共享同一套坐标。
 */
export function timelineWindow(scale: TimelineScale, anchor: DayIndex): TimelineWindow {
  const cfg = SCALE_CONFIG[scale];

  if (scale === "day") {
    return { from: anchor - (cfg.beforeDays ?? 0), to: anchor + (cfg.afterDays ?? 0) };
  }

  if (scale === "month") {
    const start = monthStart(anchor);
    const from = monthStart(addMonthsClamped(start, -(cfg.beforeMonths ?? 0)));
    const to = monthEnd(addMonthsClamped(start, cfg.afterMonths ?? 0));
    return { from, to };
  }

  const year = civilFromDays(anchor).year;
  const beforeYears = Math.round((cfg.beforeMonths ?? 0) / 12);
  const afterYears = Math.round((cfg.afterMonths ?? 0) / 12);
  return {
    from: daysFromCivil(year - beforeYears, 1, 1),
    to: daysFromCivil(year + afterYears, 12, 31),
  };
}

/** 上一段/下一段：日 7 天、周 28 天、月 1 个自然月、年 12 个月。 */
export function shiftAnchor(scale: TimelineScale, anchor: DayIndex, direction: -1 | 1): DayIndex {
  const cfg = SCALE_CONFIG[scale];
  if (scale === "day") {
    return anchor + (cfg.shiftDays ?? 0) * direction;
  }
  return addMonthsClamped(anchor, (scale === "year" ? 12 : 1) * direction);
}

export function dayToX(day: DayIndex, win: TimelineWindow, scale: TimelineScale): number {
  return (day - win.from) * SCALE_CONFIG[scale].pxPerDay;
}

export function canvasWidth(win: TimelineWindow, scale: TimelineScale): number {
  return (win.to - win.from + 1) * SCALE_CONFIG[scale].pxPerDay;
}

export type Tick = {
  /** 该刻度覆盖的第一天 */
  day: DayIndex;
  left: number;
  width: number;
  label: string;
  sub?: string;
  /** 今天的所在格（日刻度的当天、周刻度的本周） */
  isToday: boolean;
};

export type TimelineTicks = {
  tier1: Tick[];
  tier2: Tick[];
  /** 第二层刻度的左边界，用于画竖线 */
  boundaries: number[];
};

const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

function pushMonthGroups(target: Tick[], win: TimelineWindow, scale: TimelineScale) {
  const px = SCALE_CONFIG[scale].pxPerDay;
  for (let day = win.from; day <= win.to; day += 1) {
    const c = civilFromDays(day);
    if (c.day !== 1 && day !== win.from) continue;
    const next =
      c.month === 12 ? daysFromCivil(c.year + 1, 1, 1) : daysFromCivil(c.year, c.month + 1, 1);
    target.push({
      day,
      left: dayToX(day, win, scale),
      width: (Math.min(next, win.to + 1) - day) * px,
      label: `${c.year} 年 ${c.month} 月`,
      isToday: false,
    });
  }
}

/** 双层刻度。第一层是更大的单位，第二层是当前尺度。 */
export function buildTicks(win: TimelineWindow, scale: TimelineScale, today: DayIndex): TimelineTicks {
  const px = SCALE_CONFIG[scale].pxPerDay;
  const tier1: Tick[] = [];
  const tier2: Tick[] = [];
  const firstYear = civilFromDays(win.from).year;
  const lastYear = civilFromDays(win.to).year;

  if (scale === "day") {
    pushMonthGroups(tier1, win, scale);
    for (let day = win.from; day <= win.to; day += 1) {
      const c = civilFromDays(day);
      tier2.push({
        day,
        left: dayToX(day, win, scale),
        width: px,
        label: String(c.day),
        sub: WEEKDAY_LABELS[weekdayIndex(day)] ?? "",
        isToday: day === today,
      });
    }
  } else if (scale === "month") {
    for (let year = firstYear; year <= lastYear; year += 1) {
      const start = Math.max(win.from, daysFromCivil(year, 1, 1));
      const end = Math.min(win.to + 1, daysFromCivil(year + 1, 1, 1));
      tier1.push({
        day: start,
        left: dayToX(start, win, scale),
        width: (end - start) * px,
        label: `${year} 年`,
        isToday: civilFromDays(today).year === year,
      });
    }
    for (let day = win.from; day <= win.to; day += 1) {
      const c = civilFromDays(day);
      if (c.day !== 1 && day !== win.from) continue;
      const next =
        c.month === 12 ? daysFromCivil(c.year + 1, 1, 1) : daysFromCivil(c.year, c.month + 1, 1);
      const end = Math.min(next, win.to + 1);
      tier2.push({
        day,
        left: dayToX(day, win, scale),
        width: (end - day) * px,
        label: `${c.month} 月`,
        isToday: c.year === civilFromDays(today).year && c.month === civilFromDays(today).month,
      });
    }
  } else {
    for (let year = firstYear; year <= lastYear; year += 1) {
      const start = Math.max(win.from, daysFromCivil(year, 1, 1));
      const end = Math.min(win.to + 1, daysFromCivil(year + 1, 1, 1));
      tier1.push({
        day: start,
        left: dayToX(start, win, scale),
        width: (end - start) * px,
        label: `${year} 年`,
        isToday: civilFromDays(today).year === year,
      });
      for (let quarter = 0; quarter < 4; quarter += 1) {
        const qStart = daysFromCivil(year, quarter * 3 + 1, 1);
        const qEnd = daysFromCivil(year, quarter * 3 + 3, daysInMonth(year, quarter * 3 + 3));
        if (qEnd < win.from || qStart > win.to) continue;
        const startClamped = Math.max(qStart, win.from);
        const endClamped = Math.min(qEnd + 1, win.to + 1);
        tier2.push({
          day: startClamped,
          left: dayToX(startClamped, win, scale),
          width: (endClamped - startClamped) * px,
          label: `Q${quarter + 1}`,
          isToday: today >= qStart && today <= qEnd,
        });
      }
    }
  }

  const boundaries: number[] = [];
  for (const tick of tier2) {
    if (boundaries.length === 0 || tick.left > boundaries[boundaries.length - 1]! + 0.01) {
      boundaries.push(tick.left);
    }
  }
  return { tier1, tier2, boundaries };
}

export type TimelineBand = {
  left: number;
  width: number;
  clippedLeft: boolean;
  clippedRight: boolean;
};

export type TimelineMarker = {
  kind: "planStart" | "delivery";
  x: number;
  day: DayIndex;
  overflow: "left" | "right" | null;
  tone: string;
};

export type TimelineRowGeometry = {
  band: TimelineBand | null;
  markers: TimelineMarker[];
  invalidRange: boolean;
  /** 起止都早于窗口，或都晚于窗口 */
  fullyOutside: boolean;
  terminal: boolean;
};

/**
 * 单行几何。
 *
 * 区间/越界/反向区间的判断全部来自 `barModel`；这里只做三件事：
 * 1) 百分比 → 像素；2) 区间宽度补上最后一天（设计规定含首尾两天）；
 * 3) 年尺度的单日订单退化成点，不把 1.8px 拉成一条横条。
 */
export function rowGeometry(
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
  win: TimelineWindow,
  today: DayIndex,
  timeZone: string | null | undefined,
  scale: TimelineScale,
): TimelineRowGeometry {
  const cfg = SCALE_CONFIG[scale];
  const span = win.to - win.from;
  const total = canvasWidth(win, scale);
  const model = barModel(order, win, today, timeZone);

  const start = parseDayKey(order.plannedStartDate);
  const delivery = parseDayKey(order.plannedDeliveryDate);
  const terminal = order.status !== "active";

  const pctToX = (pct: number) => (pct / 100) * span * cfg.pxPerDay;

  let band: TimelineBand | null = null;
  if (model.band) {
    const singleDay = start !== null && delivery !== null && start === delivery;
    const suppressForYear = scale === "year" && singleDay;
    if (!suppressForYear) {
      const rawLeft = pctToX(model.band.leftPct);
      const rawRight = pctToX(model.band.leftPct + model.band.widthPct) + cfg.pxPerDay;
      const left = Math.max(0, Math.min(total, rawLeft));
      const right = Math.max(0, Math.min(total, rawRight));
      band = {
        left,
        width: Math.max(cfg.minBarPx, right - left),
        clippedLeft: start !== null && start < win.from,
        clippedRight: delivery !== null && delivery > win.to,
      };
    }
  }

  const markers: TimelineMarker[] = model.markers
    .filter((marker) => marker.kind === "planStart" || marker.kind === "delivery")
    .map((marker) => ({
      kind: marker.kind as "planStart" | "delivery",
      x: pctToX(marker.pct),
      day: marker.day,
      overflow: marker.overflow,
      tone: marker.tone,
    }));

  const fullyOutside =
    start !== null && delivery !== null && (delivery < win.from || start > win.to);

  return { band, markers, invalidRange: model.invalidRange, fullyOutside, terminal };
}

export type TimelineSplit = {
  /** 参与轨道绘制的订单（至少有开始或交付日期） */
  scheduled: OrderView[];
  /** planned_start_date 与 planned_delivery_date 都为空 */
  unscheduled: OrderView[];
};

/** 终态默认隐藏；未排期只收「完全没有日期」的订单。 */
export function splitOrders(orders: OrderView[], showTerminal: boolean): TimelineSplit {
  const visible = showTerminal
    ? orders
    : orders.filter((order) => order.status === "active");

  const scheduled: OrderView[] = [];
  const unscheduled: OrderView[] = [];
  for (const order of visible) {
    if (!order.plannedStartDate && !order.plannedDeliveryDate) {
      unscheduled.push(order);
    } else {
      scheduled.push(order);
    }
  }

  scheduled.sort((a, b) => {
    const av = parseDayKey(a.plannedStartDate) ?? parseDayKey(a.plannedDeliveryDate) ?? 0;
    const bv = parseDayKey(b.plannedStartDate) ?? parseDayKey(b.plannedDeliveryDate) ?? 0;
    if (av !== bv) return av - bv;
    return a.code.localeCompare(b.code);
  });

  return { scheduled, unscheduled };
}

/** 按滚动位置算「当前可见的日期范围」，用于表头滚出后的补偿文案。 */
export function visibleRange(
  win: TimelineWindow,
  scale: TimelineScale,
  scrollLeft: number,
  viewportWidth: number,
): TimelineWindow {
  const px = SCALE_CONFIG[scale].pxPerDay;
  if (!viewportWidth) return { from: win.from, to: win.to };
  const from = Math.min(win.to, win.from + Math.floor(scrollLeft / px));
  const rawTo = win.from + Math.ceil((scrollLeft + viewportWidth) / px) - 1;
  return { from, to: Math.min(win.to, Math.max(from, rawTo)) };
}

// ---------------------------------------------------------------- 跨度（WB-01）

/**
 * 每个视图的可选跨度。`−` / `+` 只在同一视图内改变跨度，
 * 绝不跨视图切换——否则按两下就会从「日」跳到「年」，无法预期。
 */
export const VIEW_SPANS: Record<TimelineScale, number[]> = {
  day: [14, 30, 60],
  month: [6, 12, 24],
  year: [3, 5, 10],
};

export const DEFAULT_SPAN: Record<TimelineScale, number> = {
  day: 30,
  month: 12,
  year: 3,
};

/** 今天落在视口左侧的比例（点「今天」时使用）。 */
export const TODAY_ANCHOR_RATIO = 0.2;

export function clampSpanIndex(scale: TimelineScale, index: number): number {
  const list = VIEW_SPANS[scale];
  return Math.max(0, Math.min(list.length - 1, index));
}

export function spanAt(scale: TimelineScale, index: number): number {
  return VIEW_SPANS[scale][clampSpanIndex(scale, index)]!;
}

export function indexOfSpan(scale: TimelineScale, span: number): number {
  const list = VIEW_SPANS[scale];
  const hit = list.indexOf(span);
  if (hit >= 0) return hit;
  // 旧偏好里可能是任意值：取最接近的一档
  let best = 0;
  for (let i = 1; i < list.length; i += 1) {
    if (Math.abs(list[i]! - span) < Math.abs(list[best]! - span)) best = i;
  }
  return best;
}

export function hasSmallerSpan(scale: TimelineScale, span: number): boolean {
  return indexOfSpan(scale, span) > 0;
}

export function hasLargerSpan(scale: TimelineScale, span: number): boolean {
  return indexOfSpan(scale, span) < VIEW_SPANS[scale].length - 1;
}

export function stepSpan(scale: TimelineScale, span: number, direction: -1 | 1): number {
  const next = clampSpanIndex(scale, indexOfSpan(scale, span) + direction);
  return spanAt(scale, next);
}

type WindowOptions = {
  /** 让今天落在视口该比例处；不传则以锚点为中心 */
  todayRatio?: number;
};

/**
 * 以锚点为中心的窗口：切换视图与缩放时锚点保持在视口中心，
 * 因此这里不做任何「自动跳回今天」的修正——没有真实边界就不引入跳转规则。
 */
export function spanWindow(
  scale: TimelineScale,
  anchor: DayIndex,
  span: number,
  options: WindowOptions = {},
): TimelineWindow {
  const ratio = options.todayRatio;

  if (scale === "day") {
    const lead = ratio === undefined ? Math.floor(span / 2) : Math.round(span * ratio);
    return { from: anchor - lead, to: anchor - lead + span - 1 };
  }

  if (scale === "month") {
    const start = monthStart(anchor);
    const half = Math.floor(span / 2);
    const from = monthStart(addMonthsClamped(start, -half));
    const to = monthEnd(addMonthsClamped(start, span - 1 - half));
    return { from, to };
  }

  const year = civilFromDays(anchor).year;
  const half = Math.floor(span / 2);
  const fromYear = year - half;
  return {
    from: daysFromCivil(fromYear, 1, 1),
    to: daysFromCivil(fromYear + span - 1, 12, 31),
  };
}

/** 视口中心对应的日期：用于「切换视图 / 缩放时保持锚点」。 */
export function anchorFromViewport(
  scale: TimelineScale,
  win: TimelineWindow,
  scrollLeft: number,
  viewportWidth: number,
): DayIndex {
  const centerPx = scrollLeft + viewportWidth / 2;
  const day = win.from + Math.round(centerPx / SCALE_CONFIG[scale].pxPerDay);
  return Math.max(win.from, Math.min(win.to, day));
}

/** 点「今天」时的滚动位置：把今天放在左侧 20% 处。 */
export function scrollForToday(
  scale: TimelineScale,
  win: TimelineWindow,
  today: DayIndex,
  viewportWidth: number,
): number {
  const x = (today - win.from) * SCALE_CONFIG[scale].pxPerDay;
  return Math.max(0, Math.round(x - viewportWidth * TODAY_ANCHOR_RATIO));
}
