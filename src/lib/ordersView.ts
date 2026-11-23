import type { DeadlineState, ListDensity, OrderStatus, OrderView } from "../bridge/commands";

export type StatusFilter = "all" | OrderStatus;
export type RiskFilter = "all" | "overdue" | "today" | "dueSoon" | "unscheduled";
export type WorkFilter = "all" | "queued" | "inProgress";
/** "all" 或某个来源文本；来源是自由文本，不做枚举。 */
export type SourceFilter = "all" | string;
/** 归档归属：普通列表不显示已归档，归档空间只显示已归档。 */
export type ArchiveScope = "live" | "archived";

/** 搜索匹配标题、编号、客户名；大小写与前后空白都不敏感。 */
export function matchesQuery(order: OrderView, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const haystack = [order.title, order.code, order.clientName ?? "", order.source ?? ""]
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
/**
 * 来源筛选。`""` 专指"未设置"，`"all"` 才是不筛。
 * 这两个值必须分开：否则"未设置"的订单永远无法被单独找出来。
 */
export function matchesSource(order: OrderView, filter: SourceFilter): boolean {
  if (filter === "all") return true;
  return (order.source ?? "") === filter;
}

export function matchesRisk(order: OrderView, filter: RiskFilter): boolean {
  return filter === "all" || order.deadlineState === filter;
}

export function isArchived(order: OrderView): boolean {
  return (order.archivedAt ?? null) !== null;
}

export function matchesArchive(order: OrderView, scope: ArchiveScope): boolean {
  return scope === "archived" ? isArchived(order) : !isArchived(order);
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
    source?: SourceFilter;
    archive?: ArchiveScope;
  } = {},
): OrderView[] {
  const query = options.query ?? "";
  const status = options.status ?? "all";
  const risk = options.risk ?? "all";
  const work = options.work ?? "all";
  const source = options.source ?? "all";
  const archive = options.archive ?? "live";
  const filtered = orders.filter(
    (order) =>
      matchesArchive(order, archive) &&
      matchesStatus(order, status) &&
      matchesQuery(order, query) &&
      matchesRisk(order, risk) &&
      matchesWork(order, work) &&
      matchesSource(order, source),
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
