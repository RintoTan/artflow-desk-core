import type { OrderView, UpdateDetailsInput } from "../bridge/commands";
import {
  civilFromDays,
  daysFromCivil,
  formatDayKey,
  parseDayKey,
  type DayIndex,
} from "./scheduleBar";
import { WEEK_START_OFFSET, weekdayIndex } from "./timeline";

/**
 * 日历的纯逻辑：网格、区间切片、轨道分配、折叠、拖放计划。
 *
 * 只操作整数 `DayIndex`，日期解析一律走 `scheduleBar` 的原语，
 * 不引入第二套日期算法。这里没有任何 React 与 IPC 调用。
 */

export type CalendarView = "month" | "week";

export const MONTH_ROWS = 6;
export const MONTH_CELLS = MONTH_ROWS * 7;
/** 月视图每周 3 条轨道，周视图每周 6 条。 */
export const LANES: Record<CalendarView, number> = { month: 3, week: 6 };

/**
 * 网格行度量（单位 px）。
 *
 * 每个月行都由三段固定组成：日期数字行 + N 条订单轨道 + 折叠行。
 * 订单条与 +N 只在自己的轨道里排布，永远不会改变格子的高度。
 */
export type GridMetrics = {
  /** 日期数字行高。 */
  numH: number;
  /** 单条订单轨道高。 */
  laneH: number;
  /** 折叠行高（+N）。 */
  moreH: number;
  /** 整行高度 = numH + laneH × 轨道数 + moreH。 */
  rowH: number;
};

/** 日期数字行：27px 的今天圆环 + 上下留白。 */
export const NUM_ROW_H = 32;
/** 折叠行：容得下 18px 的 +N 胶囊。 */
export const MORE_ROW_H = 20;
/** 单条订单轨道的最小高度（19px 的订单条 + 呼吸）。 */
export const LANE_MIN_H = 22;
/** 行高上限：再高只会拉长空白，不会让内容更好读。 */
export const ROW_MAX_H = 168;

function metricsFor(lanes: number, numH: number, moreH: number, rowH: number): GridMetrics {
  const laneH = Math.max(LANE_MIN_H, Math.floor((rowH - numH - moreH) / lanes));
  return { numH, laneH, moreH, rowH: numH + laneH * lanes + moreH };
}

/**
 * 月视图行高：按日历可视高度分配，预算按 6 周计 ——
 * 任何一个月（4 / 5 / 6 周）都能在同一个行高下完整放下，
 * 所以连续滚动跨月时行高恒定，视口不会跳动。
 */
export function monthGridMetrics(available: number): GridMetrics {
  const lanes = LANES.month;
  const base = NUM_ROW_H + MORE_ROW_H + lanes * LANE_MIN_H;
  const target = available > 0 ? Math.floor(available / MONTH_ROWS) : base;
  return metricsFor(lanes, NUM_ROW_H, MORE_ROW_H, Math.max(base, Math.min(ROW_MAX_H, target)));
}

/** 周视图保持自己的独立密度：6 条轨道、不加高。 */
export function weekGridMetrics(): GridMetrics {
  const lanes = LANES.week;
  return metricsFor(lanes, NUM_ROW_H, MORE_ROW_H, NUM_ROW_H + MORE_ROW_H + lanes * LANE_MIN_H);
}

/** 该天所属月份的序号（年 × 12 + 月），用于月份归属比较。 */
export function monthKeyOf(day: DayIndex): number {
  const c = civilFromDays(day);
  return c.year * 12 + (c.month - 1);
}

/**
 * 视口内月份归属：**每一行投一票**，投给该行 7 天里占多数的那个月，
 * 得票最多的月份胜出（平票取更早出现的那一行），返回它的第一个可见日。
 *
 * 为什么按行而不按格：跨月那一周是 6 天新月 + 1 天旧月，
 * 按格投票时，小窗口下只要它露出来就会把整屏的月份抢过去；
 * 按行投票等于问"屏幕上主体是几个星期几月"，和眼睛看到的一致。
 */
export function dominantMonthDay(rows: DayIndex[][]): DayIndex | null {
  const rowVotes = new Map<number, { votes: number; first: DayIndex }>();
  for (const row of rows) {
    if (row.length === 0) continue;
    const perMonth = new Map<number, number>();
    for (const day of row) {
      const key = monthKeyOf(day);
      perMonth.set(key, (perMonth.get(key) ?? 0) + 1);
    }
    let winnerKey: number | null = null;
    let winnerCount = -1;
    for (const [key, count] of perMonth) {
      if (count > winnerCount) {
        winnerKey = key;
        winnerCount = count;
      }
    }
    if (winnerKey === null) continue;
    const first = row.find((day) => monthKeyOf(day) === winnerKey) ?? row[0]!;
    const entry = rowVotes.get(winnerKey);
    if (entry === undefined) rowVotes.set(winnerKey, { votes: 1, first });
    else entry.votes += 1;
  }
  let best: { votes: number; first: DayIndex } | null = null;
  for (const entry of rowVotes.values()) {
    if (best === null || entry.votes > best.votes) best = entry;
  }
  return best === null ? null : best.first;
}

/** 该天所在周的周一（与时间线共用 `WEEK_START_OFFSET`）。 */
export function weekStartOf(day: DayIndex): DayIndex {
  const offset = (weekdayIndex(day) - WEEK_START_OFFSET + 7) % 7;
  return day - offset;
}

export function weekDays(anchor: DayIndex): DayIndex[] {
  const start = weekStartOf(anchor);
  return Array.from({ length: 7 }, (_, i) => start + i);
}

/** 月视图的 42 个格子：从当月 1 号所在周的周一开始，固定 6 行。 */
export function monthMatrix(anchor: DayIndex): DayIndex[] {
  const { year, month } = civilFromDays(anchor);
  const first = daysFromCivil(year, month, 1);
  const start = weekStartOf(first);
  return Array.from({ length: MONTH_CELLS }, (_, i) => start + i);
}

/** 该格子是否属于 anchor 所在月（用于弱化相邻月份）。 */
export function isSameMonth(day: DayIndex, anchor: DayIndex): boolean {
  const a = civilFromDays(day);
  const b = civilFromDays(anchor);
  return a.year === b.year && a.month === b.month;
}

export function shiftMonth(anchor: DayIndex, delta: number): DayIndex {
  const { year, month, day } = civilFromDays(anchor);
  const total = (year * 12 + (month - 1)) + delta;
  const y = Math.floor(total / 12);
  const m = total % 12 + 1;
  const last = daysFromCivil(y, m + 1, 1) - 1;
  return Math.min(daysFromCivil(y, m, 1) + (day - 1), last);
}

export function shiftWeek(anchor: DayIndex, delta: number): DayIndex {
  return anchor + delta * 7;
}

// ---------------------------------------------------------------- 订单区间

export type SpanKind = "range" | "single" | "startOnly" | "deliveryOnly";

export type OrderSpan = { from: DayIndex; to: DayIndex; kind: SpanKind };

/** 两个日期都为空时返回 null（这类订单只进未排期池）。 */
export function orderSpan(order: OrderView): OrderSpan | null {
  const start = order.plannedStartDate === null ? null : parseDayKey(order.plannedStartDate);
  const delivery =
    order.plannedDeliveryDate === null ? null : parseDayKey(order.plannedDeliveryDate);
  if (start !== null && delivery !== null) {
    const kind: SpanKind = start === delivery ? "single" : "range";
    return { from: Math.min(start, delivery), to: Math.max(start, delivery), kind };
  }
  if (start !== null) return { from: start, to: start, kind: "startOnly" };
  if (delivery !== null) return { from: delivery, to: delivery, kind: "deliveryOnly" };
  return null;
}

export function isTerminal(order: OrderView): boolean {
  return order.status !== "active";
}

/** 终态订单不能改期；后端也会拒绝，这里只负责不给入口。 */
export function canReschedule(order: OrderView): boolean {
  return !isTerminal(order);
}

/** 排序用的"关键日期"：有交付用交付，否则用开始。 */
function sortDay(order: OrderView): number {
  const span = orderSpan(order);
  if (span === null) return Number.MAX_SAFE_INTEGER;
  const delivery = order.plannedDeliveryDate === null ? null : parseDayKey(order.plannedDeliveryDate);
  return delivery ?? span.to;
}

/** 活动优先 → 关键日期早的优先 → 编号。终态永远排在活动之后。 */
export function compareForLanes(a: OrderView, b: OrderView): number {
  const ta = isTerminal(a) ? 1 : 0;
  const tb = isTerminal(b) ? 1 : 0;
  if (ta !== tb) return ta - tb;
  const da = sortDay(a);
  const db = sortDay(b);
  if (da !== db) return da - db;
  return a.code.localeCompare(b.code);
}

// ---------------------------------------------------------------- 轨道分配

export type Segment = {
  order: OrderView;
  /** 0 起的轨道序号。 */
  lane: number;
  /** 本周内的列范围，含首尾。 */
  colStart: number;
  colEnd: number;
  clippedLeft: boolean;
  clippedRight: boolean;
  kind: SpanKind;
};

export type WeekLayout = {
  weekStart: DayIndex;
  segments: Segment[];
  /** 当天被折叠的订单（同一订单同一天只出现一次）。 */
  hidden: Map<DayIndex, OrderView[]>;
  lanesUsed: number;
};

/**
 * 把一周内的订单分配到轨道。同一订单在同一周只占一条轨道；
 * 跨周订单在下一周可以重新分配。超出 `maxLanes` 的进入折叠。
 */
export function layoutWeek(
  orders: OrderView[],
  weekStart: DayIndex,
  maxLanes: number,
): WeekLayout {
  const weekEnd = weekStart + 6;
  const candidates = orders
    .map((order) => ({ order, span: orderSpan(order) }))
    .filter((item): item is { order: OrderView; span: OrderSpan } => item.span !== null)
    .filter((item) => item.span.to >= weekStart && item.span.from <= weekEnd)
    .sort((a, b) => compareForLanes(a.order, b.order));

  const lanes: boolean[][] = [];
  const segments: Segment[] = [];
  const hidden = new Map<DayIndex, OrderView[]>();

  for (const { order, span } of candidates) {
    const colStart = Math.max(0, span.from - weekStart);
    const colEnd = Math.min(6, span.to - weekStart);
    let lane = -1;
    for (let i = 0; i < maxLanes; i += 1) {
      const row = lanes[i] ?? (lanes[i] = Array.from({ length: 7 }, () => false));
      let free = true;
      for (let c = colStart; c <= colEnd; c += 1) {
        if (row[c]) {
          free = false;
          break;
        }
      }
      if (free) {
        lane = i;
        for (let c = colStart; c <= colEnd; c += 1) row[c] = true;
        break;
      }
    }

    if (lane === -1) {
      for (let c = colStart; c <= colEnd; c += 1) {
        const day = weekStart + c;
        const list = hidden.get(day) ?? [];
        list.push(order);
        hidden.set(day, list);
      }
      continue;
    }

    segments.push({
      order,
      lane,
      colStart,
      colEnd,
      // 端点落在本周内才是真正的端点；否则是跨周延续段。
      clippedLeft: span.from < weekStart,
      clippedRight: span.to > weekEnd,
      kind: span.kind,
    });
  }

  return { weekStart, segments, hidden, lanesUsed: Math.min(maxLanes, lanes.filter(Boolean).length) };
}

/** 一个跨日区间在某一周的延续段没有真实端点（不能拖端点/不能当单日）。 */
export function segmentHasStart(segment: Segment): boolean {
  return !segment.clippedLeft;
}

export function segmentHasEnd(segment: Segment): boolean {
  return !segment.clippedRight;
}

// ---------------------------------------------------------------- 拖放计划

export type DropMode = "start" | "delivery" | "move" | "single" | "unscheduled";

export type DropPlan =
  | { ok: true; start: string | null; delivery: string | null; unchanged: boolean }
  | { ok: false; reason: string };

function key(day: DayIndex | null): string | null {
  return day === null ? null : formatDayKey(day);
}

/**
 * 把"拖到某一天"翻译成新的计划日期。纯函数，不写库。
 *
 * - `start` / `delivery`：只改对应端点（单端订单只能走这两个）。
 * - `move`：整体平移，保留原始区间长度。
 * - `single`：同日订单，两端一起移动到目标日。
 * - `unscheduled`：从未排期池拖入，`field` 决定写哪一端。
 */
export function dropPlan(
  order: OrderView,
  target: DayIndex,
  mode: DropMode,
  field?: "start" | "delivery",
): DropPlan {
  const span = orderSpan(order);
  const oldStart = order.plannedStartDate === null ? null : parseDayKey(order.plannedStartDate);
  const oldDelivery =
    order.plannedDeliveryDate === null ? null : parseDayKey(order.plannedDeliveryDate);

  if (!canReschedule(order)) {
    return { ok: false, reason: "已结束的订单不能改期" };
  }

  let nextStart: DayIndex | null = oldStart;
  let nextDelivery: DayIndex | null = oldDelivery;

  if (mode === "unscheduled") {
    if (span !== null) return { ok: false, reason: "该订单已经有计划日期" };
    if (field === "start") nextStart = target;
    else if (field === "delivery") nextDelivery = target;
    else return { ok: false, reason: "请选择写入计划开始日期还是计划交付日期" };
  } else if (mode === "single") {
    nextStart = target;
    nextDelivery = target;
  } else if (mode === "move") {
    if (span === null) return { ok: false, reason: "该订单没有可移动的计划日期" };
    const length = span.to - span.from;
    if (oldStart !== null && oldDelivery !== null) {
      nextStart = target;
      nextDelivery = target + length;
    } else if (oldStart !== null) {
      nextStart = target;
    } else {
      nextDelivery = target;
    }
  } else if (mode === "start") {
    if (oldStart === null) return { ok: false, reason: "该订单没有计划开始日期" };
    nextStart = target;
  } else {
    if (oldDelivery === null) return { ok: false, reason: "该订单没有计划交付日期" };
    nextDelivery = target;
  }

  if (nextStart !== null && nextDelivery !== null && nextDelivery < nextStart) {
    return { ok: false, reason: "计划交付日期不能早于计划开始日期" };
  }

  const start = key(nextStart);
  const delivery = key(nextDelivery);
  return {
    ok: true,
    start,
    delivery,
    unchanged: start === order.plannedStartDate && delivery === order.plannedDeliveryDate,
  };
}

/**
 * 生成整单回填的入参。
 *
 * `update_order_details` 是整单覆盖，只改日期也必须把其余字段原样带上，
 * 否则金额/客户/来源/备注会被清空。
 */
export function rescheduleInput(
  order: OrderView,
  plan: { start: string | null; delivery: string | null },
  changeSource: "calendar" | "order_details",
  reason: string | null,
): UpdateDetailsInput {
  return {
    orderId: order.id,
    expectedRevision: order.revision,
    title: order.title,
    clientId: order.clientId,
    commissionType: order.commissionType,
    source: order.source,
    amountCents: order.amountCents,
    plannedStartDate: plan.start,
    plannedDeliveryDate: plan.delivery,
    note: order.note,
    changeSource,
    reason: reason === null || reason.trim() === "" ? null : reason.trim(),
  };
}

// ---------------------------------------------------------------- 视图标题

export function monthTitle(anchor: DayIndex): string {
  const { year, month } = civilFromDays(anchor);
  return `${year} 年 ${month} 月`;
}

export function weekTitle(anchor: DayIndex): string {
  const start = weekStartOf(anchor);
  const end = start + 6;
  return `${formatDayKey(start)} ~ ${formatDayKey(end)}`;
}

/** 未排期池排序：创建时间早的在前，相同时间按编号。 */
export function compareUnscheduled(a: OrderView, b: OrderView): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.code.localeCompare(b.code);
}
