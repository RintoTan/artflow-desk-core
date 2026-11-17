import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { OrderView } from "../bridge/commands";

function makeOrder(over: Partial<OrderView>): OrderView {
  return {
    id: "o1",
    code: "AF-2026-0001",
    title: "排期轨道测试单",
    clientId: null,
    clientName: "林小满",
    commissionType: null,
    amountCents: null,
    note: null,
    status: "active",
    workState: "inProgress",
    currentStageId: "line",
    currentStageTitle: "线稿",
    currentStageIndex: 1,
    stageCount: 3,
    stages: [
      { id: "draft", title: "草稿", position: 0, isCurrent: false },
      { id: "line", title: "线稿", position: 1, isCurrent: true },
      { id: "done", title: "完成", position: 2, isCurrent: false },
    ],
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
      canAdvance: true,
      canRework: true,
      canComplete: false,
      canCancel: true,
      canReopen: false,
      canEditWorkflow: true,
    },
    ...over,
  };
}

let ORDERS: OrderView[] = [];

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    api: {
      listOrders: async () => ORDERS,
      listClients: async () => [],
      getOrder: async (id: string) => ORDERS.find((o) => o.id === id) ?? ORDERS[0],
      listOrderEvents: async () => [],
      updateOrderDetails: vi.fn(),
      status: async () => ({
        appVersion: "0.1.0",
        firstRun: false,
        generation: "gen-test",
        schemaVersion: 3,
        upgradedFrom: null,
        rootPath: "/tmp/test",
        sqliteVersion: "3.54.1",
        journalMode: "wal",
        workingTimezone: "Asia/Shanghai",
        systemTimezone: "Asia/Shanghai",
        lockHeld: true,
        orders: ORDERS.length,
        clients: 0,
        templates: 0,
        attachments: 0,
        pendingCleanup: 0,
        highWater: [],
        integrity: "ok",
      }),
    },
    templateApi: { list: async () => [] },
    queueApi: { list: async () => ({ revision: 0, entries: [] }), move: vi.fn() },
    preferenceApi: { get: async () => null, set: async () => null },
    attachmentApi: { list: async () => [] },
  };
});

async function setup(orders: OrderView[]) {
  ORDERS = orders;
  const { default: OrdersPage } = await import("./OrdersPage");
  const router = createMemoryRouter([{ path: "/orders", element: <OrdersPage /> }], {
    initialEntries: ["/orders"],
  });
  render(<RouterProvider router={router} />);
  await screen.findAllByRole("button", { name: /AF-2026-/ });
}

function bar() {
  return document.querySelector(".sched");
}

describe("订单行排期轨道", () => {
  it("有计划日期时渲染轨道，且轨道里没有任何可交互元素", async () => {
    await setup([
      makeOrder({ plannedStartDate: "2026-11-10", plannedDeliveryDate: "2026-11-20" }),
    ]);
    const node = bar()!;
    expect(node).not.toBeNull();
    expect(node.querySelector("button, a, input, [tabindex]")).toBeNull();
    // 纯装饰：可访问性由行文字与详情承担
    expect(node.getAttribute("aria-hidden")).toBe("true");
    expect(node.querySelector(".sched-band")).not.toBeNull();
    expect(node.querySelectorAll(".sched-mark").length).toBeGreaterThan(0);
  });

  it("完全没有日期时不画轨道，也不留空壳", async () => {
    await setup([makeOrder({})]);
    expect(bar()).toBeNull();
    expect(document.querySelector(".sched-text")).toBeNull();
  });

  it("只有交付日：画点不画区间，并给出窄屏文字", async () => {
    await setup([makeOrder({ plannedDeliveryDate: "2026-11-20" })]);
    expect(bar()!.querySelector(".sched-band")).toBeNull();
    expect(bar()!.querySelector('[data-kind="delivery"]')).not.toBeNull();
    expect(document.querySelector(".sched-text")?.textContent).toBe("交付 11-20");
  });

  it("终态订单的交付标记是中性的，不沿用逾期色", async () => {
    await setup([
      makeOrder({
        status: "complete",
        deadlineState: "scheduled",
        plannedDeliveryDate: "2026-11-20",
        completedAt: "2026-11-18T02:00:00.000Z",
      }),
    ]);
    const delivery = bar()!.querySelector('[data-kind="delivery"]')!;
    expect(delivery.getAttribute("data-tone")).toBe("neutral");
    expect(bar()!.querySelector('[data-kind="completed"]')).not.toBeNull();
  });

  it("风险色直接来自后端 deadlineState", async () => {
    await setup([
      makeOrder({ plannedDeliveryDate: "2026-11-10", deadlineState: "overdue" }),
    ]);
    expect(bar()!.querySelector('[data-kind="delivery"]')!.getAttribute("data-tone")).toBe(
      "overdue",
    );
  });

  it("越界日期带方向标记", async () => {
    await setup([makeOrder({ plannedDeliveryDate: "2025-01-01" })]);
    expect(
      bar()!.querySelector('[data-kind="delivery"]')!.getAttribute("data-overflow"),
    ).toBe("left");
  });
});
