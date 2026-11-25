import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OrderView } from "../bridge/commands";

function order(overrides: Partial<OrderView> = {}): OrderView {
  return {
    id: "o1",
    code: "AF-2026-0001",
    title: "第一张",
    clientId: null,
    clientName: "林小满",
    commissionType: null,
    stageTemplateId: "tpl-a",
    source: "米画师",
    amountCents: 88000,
    note: null,
    status: "active",
    workState: "queued",
    currentStageId: "s1",
    currentStageTitle: "草稿",
    currentStageIndex: 0,
    stageCount: 2,
    stages: [],
    queuePosition: 0,
    plannedStartDate: null,
    plannedDeliveryDate: null,
    deadlineState: "scheduled",
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    revision: 1,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    archivedAt: null,
    pinnedAt: null,
    capabilities: {
      canStartWork: false,
      canUndoStartWork: false,
      undoBlockedReason: null,
      canAdvance: true,
      canRework: true,
      canSkip: false,
      canComplete: false,
      canCancel: true,
      canReopen: false,
      canEditWorkflow: true,
    },
    ...overrides,
  };
}

let stored: Record<string, string | null>;
let rows: OrderView[];

const hoisted = vi.hoisted(() => ({
  listOrders: vi.fn(),
  getOrder: vi.fn(),
  pinOrder: vi.fn(),
  unpinOrder: vi.fn(),
}));

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>("../bridge/commands");
  return {
    ...actual,
    preferenceApi: {
      get: async (key: string) => (key in stored ? (stored[key] ?? null) : null),
      set: async (key: string, value: string) => {
        stored[key] = value;
        return value;
      },
    },
    api: {
      ...actual.api,
      listOrders: hoisted.listOrders,
      getOrder: hoisted.getOrder,
      pinOrder: hoisted.pinOrder,
      unpinOrder: hoisted.unpinOrder,
      listClients: async () => [],
      listOrderEvents: async () => [],
      status: async () => ({
        appVersion: "0.1.2",
        firstRun: false,
        generation: "gen-test",
        schemaVersion: 13,
        upgradedFrom: null,
        rootPath: "/tmp/test",
        sqliteVersion: "3.54.1",
        journalMode: "wal",
        workingTimezone: "Asia/Shanghai",
        systemTimezone: "Asia/Shanghai",
        lockHeld: true,
        qaScenario: null,
      }),
    },
    templateApi: { ...actual.templateApi, list: async () => [] },
    queueApi: { ...actual.queueApi, list: async () => ({ revision: 0, items: [] }) },
  };
});

const { default: OrdersPage } = await import("./OrdersPage");

function renderPage() {
  const router = createMemoryRouter([{ path: "/orders", element: <OrdersPage /> }], {
    initialEntries: ["/orders"],
  });
  return render(<RouterProvider router={router} />);
}

beforeEach(() => {
  stored = {};
  rows = [order()];
  hoisted.listOrders.mockReset();
  hoisted.getOrder.mockReset();
  hoisted.pinOrder.mockReset();
  hoisted.unpinOrder.mockReset();
  hoisted.listOrders.mockImplementation(async () => rows.map((row) => ({ ...row })));
  hoisted.getOrder.mockImplementation(async (id: string) => {
    const found = rows.find((row) => row.id === id);
    if (!found) throw new Error("not found");
    return { ...found };
  });
});

describe("订单置顶的界面表达", () => {
  it("卡片视图给有效置顶的订单打标记", async () => {
    rows = [order({ pinnedAt: "2026-11-20T10:00:00+08:00" })];
    renderPage();
    await screen.findAllByText("AF-2026-0001");
    expect(screen.getAllByLabelText("已置顶").length).toBeGreaterThan(0);
  });

  it("未置顶的订单没有标记", async () => {
    renderPage();
    await screen.findAllByText("AF-2026-0001");
    expect(screen.queryByLabelText("已置顶")).toBeNull();
  });

  it("表格视图同样显示标记", async () => {
    stored.orders_view_mode = "table";
    rows = [order({ pinnedAt: "2026-11-20T10:00:00+08:00" })];
    renderPage();
    await screen.findAllByRole("row");
    expect(screen.getAllByLabelText("已置顶").length).toBeGreaterThan(0);
  });

  it("看板视图同样显示标记", async () => {
    stored.orders_view_mode = "board";
    rows = [order({ pinnedAt: "2026-11-20T10:00:00+08:00" })];
    renderPage();
    await screen.findAllByRole("listitem");
    expect(screen.getAllByLabelText("已置顶").length).toBeGreaterThan(0);
  });

  it("pinnedAt 非空但订单已完成：不显示标记（清理漏写的旧数据不该冒出来）", async () => {
    rows = [order({ status: "complete", completedAt: "2026-11-20T10:00:00+08:00", pinnedAt: "2026-11-20T10:00:00+08:00" })];
    renderPage();
    await screen.findAllByText("AF-2026-0001");
    expect(screen.queryByLabelText("已置顶")).toBeNull();
  });
});

describe("订单置顶的右键操作", () => {
  it("菜单里点置顶：调用后端，并在刷新后出现标记", async () => {
    renderPage();
    const row = await screen.findByRole("button", { name: /第一张/ });
    fireEvent.contextMenu(row);
    await screen.findByRole("menu", { name: "订单操作" });

    hoisted.pinOrder.mockImplementation(async () => {
      rows = [order({ pinnedAt: "2026-11-25T10:00:00+08:00" })];
      return rows[0]!;
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "置顶" }));

    await waitFor(() => expect(hoisted.pinOrder).toHaveBeenCalledWith("o1"));
    await waitFor(() => expect(screen.getAllByLabelText("已置顶").length).toBeGreaterThan(0));
  });

  it("已置顶的订单菜单里是「取消置顶」，调用对应命令", async () => {
    rows = [order({ pinnedAt: "2026-11-20T10:00:00+08:00" })];
    renderPage();
    const row = await screen.findByRole("button", { name: /第一张/ });
    fireEvent.contextMenu(row);
    await screen.findByRole("menu", { name: "订单操作" });

    expect(screen.queryByRole("menuitem", { name: "置顶" })).toBeNull();
    hoisted.unpinOrder.mockImplementation(async () => {
      rows = [order()];
      return rows[0]!;
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "取消置顶" }));

    await waitFor(() => expect(hoisted.unpinOrder).toHaveBeenCalledWith("o1"));
  });

  it("达到五个上限时把后端原文显示给用户", async () => {
    renderPage();
    const row = await screen.findByRole("button", { name: /第一张/ });
    fireEvent.contextMenu(row);
    await screen.findByRole("menu", { name: "订单操作" });

    hoisted.pinOrder.mockRejectedValue({
      code: "INVALID",
      message: "最多只能置顶 5 个订单，请先取消其他订单的置顶。",
    });

    fireEvent.click(screen.getByRole("menuitem", { name: "置顶" }));

    // describeError 会在原文后面补上错误码，所以按片段匹配
    await waitFor(() => expect(screen.getByText(/最多只能置顶 5 个订单/)).toBeTruthy());
    // 失败后不该冒出置顶标记
    expect(screen.queryByLabelText("已置顶")).toBeNull();
  });

  it("置顶不改变列表顺序：仍在原来的队列位置", async () => {
    rows = [order(), order({ id: "o2", code: "AF-2026-0002", title: "第二张", queuePosition: 1 })];
    renderPage();
    await screen.findByText("AF-2026-0002");

    const before = screen.getAllByRole("button", { name: /第一张|第二张/ }).map((el) => el.textContent);
    const row = screen.getByRole("button", { name: /第一张/ });
    fireEvent.contextMenu(row);
    await screen.findByRole("menu", { name: "订单操作" });

    hoisted.pinOrder.mockImplementation(async () => {
      rows = [
        order({ pinnedAt: "2026-11-25T10:00:00+08:00" }),
        order({ id: "o2", code: "AF-2026-0002", title: "第二张", queuePosition: 1 }),
      ];
      return rows[0]!;
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "置顶" }));
    await waitFor(() => expect(hoisted.pinOrder).toHaveBeenCalled());

    // 置顶只是把它提到最前，队列位置本身没被改写
    await waitFor(() => {
      const after = screen
        .getAllByRole("button", { name: /第一张|第二张/ })
        .map((el) => el.textContent);
      expect(after[0]).toBe(before[0]);
    });
  });
});
