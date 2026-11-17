import type { DeadlineState, ListDensity, OrderStatus, OrderView } from "../bridge/commands";

export type StatusFilter = "all" | OrderStatus;
export type RiskFilter = "all" | "overdue" | "today" | "dueSoon" | "unscheduled";
export type WorkFilter = "all" | "queued" | "inProgress";

/** 搜索匹配标题、编号、客户名；大小写与前后空白都不敏感。 */
export function matchesQuery(order: OrderView, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const haystack = [order.title, order.code, order.clientName ?? ""]
    .join("\n")
    .toLowerCase();
  return haystack.includes(q);
}

export function matchesStatus(order: OrderView, filter: StatusFilter): boolean {
  return filter === "all" || order.status === filter;
}

/**
 * 过滤 + 排序。活动订单按队列位置在前，终态订单按更新时间倒序在后。
 * 这只影响展示，绝不修改队列。
 */
export function matchesRisk(order: OrderView, filter: RiskFilter): boolean {
  return filter === "all" || order.deadlineState === filter;
}

export function matchesWork(order: OrderView, filter: WorkFilter): boolean {
  if (filter === "all") return true;
  if (order.status !== "active") return false;
  return order.workState === filter;
}

export function filterOrders(
  orders: OrderView[],
  options: {
    query?: string;
    status?: StatusFilter;
    risk?: RiskFilter;
    work?: WorkFilter;
  } = {},
): OrderView[] {
  const query = options.query ?? "";
  const status = options.status ?? "all";
  const risk = options.risk ?? "all";
  const work = options.work ?? "all";
  const filtered = orders.filter(
    (order) =>
      matchesStatus(order, status) &&
      matchesQuery(order, query) &&
      matchesRisk(order, risk) &&
      matchesWork(order, work),
  );
  return [...filtered].sort((a, b) => {
    const aActive = a.status === "active";
    const bActive = b.status === "active";
    if (aActive !== bActive) return aActive ? -1 : 1;
    if (aActive && bActive) return a.queuePosition - b.queuePosition;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export const RISK_LABEL: Record<DeadlineState, string> = {
  overdue: "已逾期",
  today: "今天到期",
  dueSoon: "三日内到期",
  unscheduled: "未排期",
  scheduled: "",
};

export function riskBadge(order: OrderView): string | null {
  if (order.status !== "active") return null;
  const label = RISK_LABEL[order.deadlineState];
  return label === "" ? null : label;
}

export function densityClass(density: ListDensity): string {
  return density === "compact" ? "density-compact" : "density-comfortable";
}

/** 拖拽目标位置；与当前位置相同或越界时返回 null。 */
export function dropIndex(from: number, to: number, length: number): number | null {
  if (from === to) return null;
  if (from < 0 || to < 0 || from >= length || to >= length) return null;
  return to;
}
