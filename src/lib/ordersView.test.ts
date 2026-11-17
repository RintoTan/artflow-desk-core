import { describe, expect, it } from "vitest";

import type { OrderView } from "../bridge/commands";
import {
  densityClass,
  dropIndex,
  filterOrders,
  matchesQuery,
  matchesSource,
  riskBadge,
} from "./ordersView";

function order(partial: Partial<OrderView> & { id: string }): OrderView {
  return {
    code: "AF-2026-0001",
    title: "默认标题",
    clientId: null,
    clientName: null,
    commissionType: null,
    source: null,
    amountCents: null,
    note: null,
    status: "active",
    workState: "queued",
    currentStageId: "draft",
    currentStageTitle: "草稿",
    currentStageIndex: 0,
    stageCount: 5,
    stages: [],
    queuePosition: 0,
    plannedStartDate: null,
    plannedDeliveryDate: null,
    deadlineState: "scheduled",
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    revision: 0,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    capabilities: {
      canStartWork: true,
      canUndoStartWork: false,
      undoBlockedReason: null,
      canAdvance: false,
      canRework: false,
      canComplete: false,
      canCancel: true,
      canRevert: false,
      canReopen: false,
      canEditWorkflow: true,
    } as OrderView["capabilities"],
    ...partial,
  };
}

describe("订单搜索", () => {
  it("匹配标题、编号与客户名，忽略大小写和空白", () => {
    const o = order({ id: "1", title: "半身立绘", code: "AF-2026-0007", clientName: "阿岚" });
    expect(matchesQuery(o, "")).toBe(true);
    expect(matchesQuery(o, "   ")).toBe(true);
    expect(matchesQuery(o, "立绘")).toBe(true);
    expect(matchesQuery(o, "af-2026")).toBe(true);
    expect(matchesQuery(o, "阿岚")).toBe(true);
    expect(matchesQuery(o, "不存在的关键词")).toBe(false);
  });

  it("空关键词等价于不过滤", () => {
    const list = [order({ id: "1" }), order({ id: "2", title: "另一张" })];
    expect(filterOrders(list, { query: "" })).toHaveLength(2);
  });
});

describe("订单筛选与排序", () => {
  const active1 = order({ id: "a1", title: "活动一", queuePosition: 0 });
  const active2 = order({ id: "a2", title: "活动二", queuePosition: 1 });
  const done = order({
    id: "c1",
    title: "已完成",
    status: "complete",
    workState: "completed",
    queuePosition: 0,
    updatedAt: "2026-11-10T00:00:00.000Z",
  });
  const cancelled = order({
    id: "x1",
    title: "已取消",
    status: "cancelled",
    workState: "cancelled",
    queuePosition: 0,
    updatedAt: "2026-11-12T00:00:00.000Z",
  });

  it("活动订单按队列位置排在前，终态按更新时间倒序在后", () => {
    const result = filterOrders([done, active2, cancelled, active1]);
    expect(result.map((o) => o.id)).toEqual(["a1", "a2", "x1", "c1"]);
  });

  it("状态筛选只保留对应状态", () => {
    expect(filterOrders([active1, done], { status: "active" }).map((o) => o.id)).toEqual(["a1"]);
    expect(filterOrders([active1, done], { status: "complete" }).map((o) => o.id)).toEqual(["c1"]);
    expect(filterOrders([active1, done], { status: "all" })).toHaveLength(2);
  });

  it("搜索与状态筛选同时生效", () => {
    const result = filterOrders([active1, active2, done], {
      query: "活动",
      status: "active",
    });
    expect(result.map((o) => o.id)).toEqual(["a1", "a2"]);
  });

  it("不修改传入数组（视图排序不得改数据）", () => {
    const input = [done, active1];
    const snapshot = [...input];
    filterOrders(input);
    expect(input).toEqual(snapshot);
  });
});

describe("列表密度与拖拽位置", () => {
  it("密度映射到固定 class", () => {
    expect(densityClass("comfortable")).toBe("density-comfortable");
    expect(densityClass("compact")).toBe("density-compact");
  });

  it("拖拽到自身或越界时返回 null", () => {
    expect(dropIndex(1, 1, 3)).toBeNull();
    expect(dropIndex(0, 5, 3)).toBeNull();
    expect(dropIndex(-1, 0, 3)).toBeNull();
    expect(dropIndex(0, 2, 3)).toBe(2);
  });
});

describe("风险与工作状态筛选", () => {
  it("按交付风险筛选", () => {
    const overdue = order({ id: "o1", deadlineState: "overdue" });
    const today = order({ id: "o2", deadlineState: "today" });
    const soon = order({ id: "o3", deadlineState: "dueSoon" });
    const none = order({ id: "o4", deadlineState: "scheduled" });

    expect(filterOrders([overdue, today, soon, none], { risk: "overdue" }).map((o) => o.id)).toEqual([
      "o1",
    ]);
    expect(filterOrders([overdue, today, soon, none], { risk: "dueSoon" }).map((o) => o.id)).toEqual([
      "o3",
    ]);
    expect(filterOrders([overdue, today, soon, none], { risk: "all" })).toHaveLength(4);
  });

  it("按排队中/制作中筛选，且终态订单不命中", () => {
    const queued = order({ id: "q1", workState: "queued" });
    const working = order({ id: "w1", workState: "inProgress" });
    const done = order({ id: "d1", status: "complete", workState: "completed" });

    expect(filterOrders([queued, working, done], { work: "queued" }).map((o) => o.id)).toEqual(["q1"]);
    expect(filterOrders([queued, working, done], { work: "inProgress" }).map((o) => o.id)).toEqual([
      "w1",
    ]);
  });

  it("风险徽标只对活动订单显示，且 scheduled 不显示", () => {
    expect(riskBadge(order({ id: "a", deadlineState: "overdue" }))).toBe("已逾期");
    expect(riskBadge(order({ id: "b", deadlineState: "unscheduled" }))).toBe("未排期");
    expect(riskBadge(order({ id: "c", deadlineState: "scheduled" }))).toBeNull();
    expect(
      riskBadge(order({ id: "d", status: "complete", workState: "completed", deadlineState: "overdue" })),
    ).toBeNull();
  });

  it("来源筛选是精确匹配，未设置只能靠 all 命中", () => {
    const a = order({ id: "a", source: "米画师" });
    const b = order({ id: "b", source: "画加" });
    const c = order({ id: "c", source: null });

    expect(matchesSource(a, "all")).toBe(true);
    expect(matchesSource(a, "米画师")).toBe(true);
    expect(matchesSource(a, "米")).toBe(false);
    // "" 专指"未设置"：能筛出未填来源的订单，但不会连带命中别的来源。
    expect(matchesSource(c, "")).toBe(true);
    expect(matchesSource(a, "")).toBe(false);
    expect(filterOrders([a, b, c], { source: "画加" }).map((o) => o.id)).toEqual(["b"]);
    expect(filterOrders([a, b, c], { source: "all" })).toHaveLength(3);
  });

  it("搜索也会匹配来源", () => {
    const a = order({ id: "a", title: "双人插画", source: "B站工坊" });
    expect(matchesQuery(a, "b站")).toBe(true);
  });
});
