import { describe, expect, it } from "vitest";

import type { OrderView } from "../bridge/commands";
import { densityClass, dropIndex, filterOrders, matchesQuery } from "./ordersView";

function order(partial: Partial<OrderView> & { id: string }): OrderView {
  return {
    code: "AF-2026-0001",
    title: "默认标题",
    clientId: null,
    clientName: null,
    commissionType: null,
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
