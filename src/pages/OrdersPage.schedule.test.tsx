import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { render, screen, within } from "@testing-library/react";
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
    source: null,
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

function listItems() {
  return document.querySelectorAll(".order-row");
}

describe("订单列表：不携带排期轨道", () => {
  it("有日期的订单也不会在列表里画轨道", async () => {
    await setup([
      makeOrder({ plannedStartDate: "2026-11-10", plannedDeliveryDate: "2026-11-20" }),
    ]);
    expect(listItems().length).toBeGreaterThan(0);
    expect(document.querySelector(".order-list .schedule-track")).toBeNull();
    expect(document.querySelector(".sched")).toBeNull();
    // 元信息回到 DEV-06B 的层级：没有额外包裹层
    expect(document.querySelector(".order-row-meta-text")).toBeNull();
  });
});

describe("订单详情：排期概览", () => {
  it("双日期：文字给出两端，轨道给出区间", async () => {
    await setup([
      makeOrder({ plannedStartDate: "2026-11-10", plannedDeliveryDate: "2026-11-20" }),
    ]);
    const panel = screen.getByRole("region", { name: "排期概览" });
    expect(within(panel).getByText("2026-11-10")).toBeInTheDocument();
    expect(within(panel).getByText("2026-11-20")).toBeInTheDocument();
    expect(panel.querySelector(".schedule-band")).not.toBeNull();
    expect(panel.querySelector(".schedule-today")).not.toBeNull();
  });

  it("没有计划日期：中性空态，不画空轨道", async () => {
    await setup([makeOrder({})]);
    const panel = screen.getByRole("region", { name: "排期概览" });
    expect(within(panel).getByText(/尚未设置计划排期/)).toBeInTheDocument();
    expect(panel.querySelector(".schedule-track")).toBeNull();
  });

  it("只有交付日：开始写未设置，不虚构另一端", async () => {
    await setup([makeOrder({ plannedDeliveryDate: "2026-11-20" })]);
    const panel = screen.getByRole("region", { name: "排期概览" });
    expect(within(panel).getByText("未设置")).toBeInTheDocument();
    expect(panel.querySelector(".schedule-band")).toBeNull();
    expect(panel.querySelector('[data-kind="delivery"]')).not.toBeNull();
  });

  it("只有计划开始：没有交付标记", async () => {
    await setup([makeOrder({ plannedStartDate: "2026-11-10" })]);
    const panel = screen.getByRole("region", { name: "排期概览" });
    expect(panel.querySelector('[data-kind="planStart"]')).not.toBeNull();
    expect(panel.querySelector('[data-kind="delivery"]')).toBeNull();
  });

  it("实际开工与计划开始形状不同，两者并存", async () => {
    await setup([
      makeOrder({
        plannedStartDate: "2026-11-05",
        plannedDeliveryDate: "2026-11-25",
        startedAt: "2026-11-09T02:00:00.000Z",
      }),
    ]);
    const panel = screen.getByRole("region", { name: "排期概览" });
    expect(panel.querySelector('[data-kind="started"]')).not.toBeNull();
    expect(within(panel).getByText("实际开工", { selector: "dt" })).toBeInTheDocument();
  });

  it("终态订单：交付标记中性 + 显示完成日期", async () => {
    await setup([
      makeOrder({
        status: "complete",
        deadlineState: "scheduled",
        plannedDeliveryDate: "2026-11-20",
        completedAt: "2026-11-18T02:00:00.000Z",
      }),
    ]);
    const panel = screen.getByRole("region", { name: "排期概览" });
    expect(panel.querySelector('[data-kind="delivery"]')!.getAttribute("data-tone")).toBe("neutral");
    expect(panel.querySelector('[data-kind="completed"]')).not.toBeNull();
    expect(within(panel).getByText(/完成于/)).toBeInTheDocument();
  });

  it("风险提示直接引用后端 deadlineState", async () => {
    await setup([
      makeOrder({ plannedDeliveryDate: "2026-11-10", deadlineState: "overdue" }),
    ]);
    const panel = screen.getByRole("region", { name: "排期概览" });
    expect(within(panel).getByText("已逾期")).toBeInTheDocument();
    expect(panel.querySelector('[data-kind="delivery"]')!.getAttribute("data-tone")).toBe("overdue");
  });

  it("轨道是纯装饰，精确日期在文字里", async () => {
    await setup([
      makeOrder({ plannedStartDate: "2026-11-10", plannedDeliveryDate: "2026-11-20" }),
    ]);
    const track = document.querySelector(".schedule-track")!;
    expect(track.getAttribute("aria-hidden")).toBe("true");
    expect(track.querySelector("button, a, [tabindex]")).toBeNull();
  });
});
