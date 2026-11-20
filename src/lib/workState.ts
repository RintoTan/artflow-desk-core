/**
 * 订单「制作进度」的中文文案。
 *
 * 与 `orderStatus` 是两件事，不要合并：
 * - `orderStatus` 回答「这单还成不成立」：活动 / 已完成 / 已取消；
 * - `workState` 回答「这单做到哪一步」：排队中 / 制作中 / 已完成 / 已取消。
 *
 * 两者都有「已完成 / 已取消」，但来源不同：前者是 `orders.status`（存储事实），
 * 后者由后端根据 `status` + 开工记录推导。回收站展示删除前的进度，用的是后者。
 *
 * 未知值原样返回，避免后端新增枚举时界面出现空白。
 */

/** 与 Rust `WorkState` 的 `camelCase` 序列化一一对应。 */
export type WorkStateKey = "queued" | "inProgress" | "completed" | "cancelled";

const WORK_STATE_LABEL: Record<WorkStateKey, string> = {
  queued: "排队中",
  inProgress: "制作中",
  completed: "已完成",
  cancelled: "已取消",
};

export function workStateLabel(state: string | null | undefined): string {
  if (!state) {
    return "—";
  }
  return WORK_STATE_LABEL[state as WorkStateKey] ?? state;
}
