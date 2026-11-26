import { describe, expect, it } from "vitest";

import type { OrderView } from "../bridge/commands";
import { canReorderIn, sortOrders } from "./orderSort";

function order(partial: Partial<OrderView>): OrderView {
  return {
    id: partial.id ?? "o",
    code: partial.code ?? "AF-0001",
    title: "t",
    clientId: null,
    clientName: null,
    stageTemplateId: "tpl",
    currentStageId: "s1",
    currentStageTitle: "草稿",
    queuePosition: 0,
    plannedDeliveryDate: null,
    amountCents: null,
    status: "active",
    createdAt: "2026-11-01T00:00:00.000Z",
    pinnedAt: null,
    ...partial,
  } as OrderView;
}

const codes = (list: OrderView[]) => list.map((o) => o.code);

describe("sortOrders", () => {
  it("手动模式按真实队列位置", () => {
    const list = [order({ code: "B", queuePosition: 2 }), order({ code: "A", queuePosition: 1 })];
    expect(codes(sortOrders(list, "manual"))).toEqual(["A", "B"]);
  });

  it("交付日期近到远，没有排期的沉底", () => {
    const list = [
      order({ code: "none", plannedDeliveryDate: null }),
      order({ code: "late", plannedDeliveryDate: "2026-12-01" }),
      order({ code: "early", plannedDeliveryDate: "2026-11-01" }),
    ];
    expect(codes(sortOrders(list, "deadline"))).toEqual(["early", "late", "none"]);
  });

  it("创建时间新到旧", () => {
    const list = [
      order({ code: "old", createdAt: "2026-01-01T00:00:00.000Z" }),
      order({ code: "new", createdAt: "2026-11-01T00:00:00.000Z" }),
    ];
    expect(codes(sortOrders(list, "created"))).toEqual(["new", "old"]);
  });

  it("金额大到小，未知金额沉底", () => {
    const list = [
      order({ code: "unknown", amountCents: null }),
      order({ code: "small", amountCents: 100 }),
      order({ code: "big", amountCents: 900 }),
    ];
    expect(codes(sortOrders(list, "amount"))).toEqual(["big", "small", "unknown"]);
  });

  it("置顶组始终在前，且组内各自按当前模式排", () => {
    const list = [
      order({ code: "n-early", amountCents: 500, plannedDeliveryDate: "2026-11-01" }),
      order({ code: "p-late", amountCents: 100, plannedDeliveryDate: "2026-12-01", pinnedAt: "2026-11-20T00:00:00Z" }),
      order({ code: "n-big", amountCents: 900, plannedDeliveryDate: "2026-12-05" }),
    ];
    const sorted = sortOrders(list, "deadline");
    expect(sorted[0]?.code).toBe("p-late");
    expect(codes(sorted)).toEqual(["p-late", "n-early", "n-big"]);
  });

  it("不修改传入数组，也不碰 queuePosition", () => {
    const list = [order({ code: "B", queuePosition: 2 }), order({ code: "A", queuePosition: 1 })];
    const snapshot = codes(list);
    sortOrders(list, "amount");
    expect(codes(list)).toEqual(snapshot);
    expect(list[0]?.queuePosition).toBe(2);
  });

  it("只有手动模式允许重排", () => {
    expect(canReorderIn("manual")).toBe(true);
    expect(canReorderIn("deadline")).toBe(false);
    expect(canReorderIn("created")).toBe(false);
    expect(canReorderIn("amount")).toBe(false);
  });
});
