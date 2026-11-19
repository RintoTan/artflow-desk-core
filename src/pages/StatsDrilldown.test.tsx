import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CompletedEventRow, OrderView, StatsReport } from "../bridge/commands";

function order(id: string, code: string, title: string, position: number): OrderView {
  return {
    id,
    code,
    title,
    clientId: null,
    clientName: null,
    commissionType: null,
    stageTemplateId: "tpl-a",
    source: null,
    amountCents: null,
    note: null,
    status: "active",
    workState: "queued",
    currentStageId: "draft",
    currentStageTitle: "草稿",
    currentStageIndex: 0,
    stageCount: 2,
    stages: [
      { id: "draft", title: "草稿", position: 0, isCurrent: true },
      { id: "line", title: "线稿", position: 1, isCurrent: false },
    ],
    queuePosition: position,
    plannedStartDate: null,
    plannedDeliveryDate: null,
    deadlineState: "scheduled",
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    revision: 1,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    capabilities: {
      canStartWork: true,
      canUndoStartWork: false,
      undoBlockedReason: null,
      canAdvance: false,
      canRework: false,
      canSkip: false,
      canComplete: false,
      canCancel: true,
      canReopen: false,
      canEditWorkflow: true,
    },
  };
}

const FIRST = order("order-a", "AF-2026-0001", "第一张订单", 0);
const TARGET = order("order-b", "AF-2026-0002", "被完成两次的订单", 1);
const ALL = [FIRST, TARGET];

const report: StatsReport = {
  range: "thisMonth",
  timezone: "Asia/Shanghai",
  fromMonth: "2026-11",
  toMonth: "2026-11",
  months: [
    {
      month: "2026-11",
      created: 2,
      completed: 2,
      cancelled: 0,
      amountCents: 0,
      knownOrders: 0,
      unknownOrders: 2,
    },
  ],
  totals: {
    month: "2026-11~2026-11",
    created: 2,
    completed: 2,
    cancelled: 0,
    amountCents: 0,
    knownOrders: 0,
    unknownOrders: 2,
  },
  basis: [],
};

const EVENTS: CompletedEventRow[] = [
  {
    eventId: 21,
    orderId: "order-b",
    code: "AF-2026-0002",
    title: "被完成两次的订单",
    occurredAt: "2026-11-12T02:00:00.000Z",
    localTime: "2026-11-12 10:00",
    stageTitle: "最终调整",
  },
  {
    eventId: 20,
    orderId: "order-b",
    code: "AF-2026-0002",
    title: "被完成两次的订单",
    occurredAt: "2026-11-05T02:00:00.000Z",
    localTime: "2026-11-05 10:00",
    stageTitle: "最终调整",
  },
];

const getOrder = vi.fn(async (id: string) => {
  const found = ALL.find((o) => o.id === id);
  if (!found) throw { code: "NOT_FOUND", message: "订单不存在" };
  return found;
});

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    api: {
      listOrders: async () => ALL,
      listClients: async () => [],
      getOrder,
      listOrderEvents: async () => [],
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
        orders: 2,
        clients: 0,
        templates: 1,
        attachments: 0,
        pendingCleanup: 0,
        highWater: [],
        integrity: "ok",
      }),
      updateOrderDetails: vi.fn(),
    },
    templateApi: { list: async () => [] },
    queueApi: {
      list: async () => ({ revision: 0, entries: [] }),
      move: async () => ({ revision: 1, entries: [] }),
    },
    preferenceApi: { get: async () => "comfortable", set: async () => null },
    attachmentApi: { list: async () => [] },
    statsApi: {
      report: async () => report,
      completedEvents: async () => EVENTS,
      dashboard: vi.fn(),
      exportSummary: vi.fn(),
      exportOrders: vi.fn(),
    },
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: async () => null,
  open: async () => null,
}));

async function setup(path = "/stats?range=thisMonth&focus=completed") {
  const [{ default: StatsPage }, { default: OrdersPage }] = await Promise.all([
    import("./StatsPage"),
    import("./OrdersPage"),
  ]);
  const router = createMemoryRouter(
    [
      { path: "/stats", element: <StatsPage /> },
      { path: "/orders", element: <OrdersPage /> },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("完成事件下钻", () => {
  beforeEach(() => {
    getOrder.mockClear();
  });

  it("点击完成事件会真正打开该订单详情，而不只是改变 URL", async () => {
    const user = userEvent.setup();
    const router = await setup();

    const links = await screen.findAllByRole("link", { name: "查看订单" });
    expect(links.length).toBe(2);

    await user.click(links[0]!);

    // 详情区标题必须换成目标订单
    await waitFor(() => {
      const heading = screen.getByRole("heading", { level: 1 });
      expect(heading).toHaveTextContent("被完成两次的订单");
    });
    expect(router.state.location.pathname).toBe("/orders");
    expect(getOrder).toHaveBeenCalledWith("order-b");
  });

  it("同一订单的两条完成事件都能打开同一张订单", async () => {
    const user = userEvent.setup();
    await setup();

    const links = await screen.findAllByRole("link", { name: "查看订单" });
    await user.click(links[1]!);

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("被完成两次的订单"),
    );
  });

  it("目标订单不在列表首项时也不会退回第一张订单", async () => {
    const user = userEvent.setup();
    await setup();

    const links = await screen.findAllByRole("link", { name: "查看订单" });
    await user.click(links[0]!);

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("被完成两次的订单"),
    );
    // 第一张订单仍在左栏列表里，但不应成为详情
    expect(screen.getByRole("heading", { level: 1 })).not.toHaveTextContent("第一张订单");
  });

  it("订单不存在时显示明确错误而不是假装打开", async () => {
    await setup("/orders?orderId=ghost");
    await waitFor(() => expect(getOrder).toHaveBeenCalledWith("ghost"));
    expect(await screen.findByText(/订单不存在/)).toBeInTheDocument();
  });
});
