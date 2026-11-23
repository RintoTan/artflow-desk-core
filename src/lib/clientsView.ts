import type { ClientView } from "../bridge/commands";

export type ClientSort = "default" | "recent" | "orders";

export type ClientFilterOptions = {
  query?: string;
  /** "all" 表示不按标签筛选 */
  tagId?: string;
  sort?: ClientSort;
};

/**
 * 客户列表的过滤与排序。
 *
 * 抽成纯函数是为了能在 53 客户规模下直接验证口径——
 * 之前这段逻辑内联在页面里，只能靠肉眼数列表。
 * 排序在值相等时一律回落到名称比较，避免同样的输入两次渲染顺序不同。
 */
export function filterAndSortClients(
  clients: ClientView[],
  options: ClientFilterOptions = {},
): ClientView[] {
  const keyword = (options.query ?? "").trim().toLowerCase();
  const tagId = options.tagId ?? "all";
  const sort = options.sort ?? "default";

  const filtered = clients.filter((client) => {
    const byTag = tagId === "all" || client.tags.some((tag) => tag.id === tagId);
    const byName = keyword === "" || client.displayName.toLowerCase().includes(keyword);
    return byTag && byName;
  });

  if (sort === "default") return filtered;

  return [...filtered].sort((a, b) => {
    if (sort === "orders") {
      return b.orderCount - a.orderCount || a.displayName.localeCompare(b.displayName);
    }
    const at = a.lastOrderAt ?? "";
    const bt = b.lastOrderAt ?? "";
    if (at === bt) return a.displayName.localeCompare(b.displayName);
    return bt.localeCompare(at);
  });
}
