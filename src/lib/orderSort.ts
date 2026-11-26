import type { OrderView } from "../bridge/commands";

/** 四种展示排序。手动队列之外的三种都是「临时排序」。 */
export type SortMode = "manual" | "deadline" | "created" | "amount";

export const SORT_MODES: SortMode[] = ["manual", "deadline", "created", "amount"];

export const SORT_LABELS: Record<SortMode, string> = {
  manual: "手动队列",
  deadline: "交付日期",
  created: "创建时间",
  amount: "委托金额",
};

/** 手动模式下才允许拖拽与上下移。 */
export function canReorderIn(mode: SortMode): boolean {
  return mode === "manual";
}

function pinned(order: OrderView): boolean {
  return Boolean(order.pinnedAt);
}

/** 空值永远沉底：没排期、没填金额的订单不该霸占列表顶部。 */
function compareNullable<T>(
  a: T | null,
  b: T | null,
  cmp: (x: T, y: T) => number,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return cmp(a, b);
}

function compareByMode(a: OrderView, b: OrderView, mode: SortMode): number {
  switch (mode) {
    case "manual":
      return a.queuePosition - b.queuePosition;
    case "deadline":
      // 近到远
      return compareNullable(a.plannedDeliveryDate, b.plannedDeliveryDate, (x, y) => x.localeCompare(y));
    case "created":
      // 新到旧
      return b.createdAt.localeCompare(a.createdAt);
    case "amount":
      // 金额大到小
      return compareNullable(a.amountCents, b.amountCents, (x, y) => y - x);
  }
}

/**
 * 展示用排序：只决定这一次看到的顺序，**绝不写回 queue_position**。
 *
 * 置顶订单始终排在普通订单前面，两组各自按当前模式排序——
 * 这条对所有视图都成立，所以放在最外层，而不是各视图自己实现一遍。
 */
export function sortOrders(orders: OrderView[], mode: SortMode): OrderView[] {
  return [...orders].sort((a, b) => {
    const pin = Number(pinned(b)) - Number(pinned(a));
    if (pin !== 0) return pin;
    const byMode = compareByMode(a, b, mode);
    if (byMode !== 0) return byMode;
    // 同键时按编号兜底，避免同一份数据两次渲染顺序不同
    return a.code.localeCompare(b.code);
  });
}
