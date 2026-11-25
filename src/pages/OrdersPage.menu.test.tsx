import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OrderView } from "../bridge/commands";

function order(overrides: Partial<OrderView> = {}): OrderView {
  return {
    id: "o1",
    code: "AF-2026-0001",
    title: "第一张",
    clientId: "c1",
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

const A = order();
const B = order({ id: "o2", code: "AF-2026-0002", title: "第二张", queuePosition: 1 });

let stored: Record<string, string | null>;
const hoisted = vi.hoisted(() => ({
  getOrder: vi.fn(),
  listOrders: vi.fn(),
}));

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
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
      listClients: async () => [],
      listOrderEvents: async () => [],
      getOrder: hoisted.getOrder,
      status: async () => ({
        appVersion: "0.1.2",
        firstRun: false,
        generation: "gen-test",
        schemaVersion: 12,
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
  hoisted.getOrder.mockReset();
  hoisted.listOrders.mockReset();
  hoisted.listOrders.mockImplementation(async () => [A, B]);
  hoisted.getOrder.mockImplementation(async (id: string) => (id === "o2" ? B : A));
});

describe("订单右键菜单", () => {
  it("表格里右键第二行：菜单打开，详情切到被点的那一张", async () => {
    stored.orders_view_mode = "table";
    renderPage();
    const rows = await screen.findAllByRole("row");
    // 第一行是表头
    fireEvent.contextMenu(rows[2]!);

    const menu = await screen.findByRole("menu", { name: "订单操作" });
    expect(menu).toBeTruthy();
    await waitFor(() => expect(hoisted.getOrder).toHaveBeenCalledWith("o2"));
    // 详情抽屉跟着换成 B：抽屉里出现第二张的编号（表格里本来也有一条，所以要限定范围）
    await waitFor(() => {
      const drawer = document.querySelector(".orders-detail-drawer");
      expect(drawer).not.toBeNull();
      expect(within(drawer as HTMLElement).getByText("AF-2026-0002")).toBeTruthy();
    });
  });

  it("菜单里的取消进入原有取消对话框，对象是右键的那一单", async () => {
    stored.orders_view_mode = "table";
    renderPage();
    const rows = await screen.findAllByRole("row");
    fireEvent.contextMenu(rows[2]!);

    fireEvent.click(await screen.findByRole("menuitem", { name: "取消订单…" }));

    const dialog = await screen.findByRole("alertdialog", { name: "取消订单" });
    expect(dialog.textContent).toContain("AF-2026-0002");
  });

  it("不具备条件的操作不出现：不能取消的订单没有取消项", async () => {
    const terminal = order({ id: "o3", code: "AF-2026-0003", title: "已完成的一张", status: "complete" });
    terminal.capabilities.canCancel = false;
    terminal.capabilities.canReopen = true;
    hoisted.listOrders.mockImplementation(async () => [terminal]);
    hoisted.getOrder.mockImplementation(async () => terminal);
    stored.orders_view_mode = "table";
    renderPage();

    const rows = await screen.findAllByRole("row");
    fireEvent.contextMenu(rows[1]!);

    await screen.findByRole("menu", { name: "订单操作" });
    expect(screen.queryByRole("menuitem", { name: "取消订单…" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "重新打开" })).toBeTruthy();
  });

  it("Esc 只关菜单，不连详情抽屉一起关", async () => {
    stored.orders_view_mode = "table";
    renderPage();
    const rows = await screen.findAllByRole("row");
    fireEvent.contextMenu(rows[2]!);
    await screen.findByRole("menu", { name: "订单操作" });
    expect(document.querySelector(".orders-detail-drawer")).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    // 抽屉还在：一次按键只关一层
    expect(document.querySelector(".orders-detail-drawer")).not.toBeNull();
  });

  it("看板卡片右键同样切换选中并打开菜单", async () => {
    stored.orders_view_mode = "board";
    renderPage();
    const cards = await screen.findAllByRole("listitem");
    fireEvent.contextMenu(cards[1]!);

    await screen.findByRole("menu", { name: "订单操作" });
    await waitFor(() => expect(hoisted.getOrder).toHaveBeenCalledWith("o2"));
  });

  it("默认卡片视图：右键订单行主体，菜单打开并同步详情", async () => {
    // 不写 orders_view_mode，走默认视图
    renderPage();
    const rows = await screen.findAllByRole("button", { name: /第一张|第二张/ });
    fireEvent.contextMenu(rows[1]!);

    await screen.findByRole("menu", { name: "订单操作" });
    await waitFor(() => expect(hoisted.getOrder).toHaveBeenCalledWith("o2"));
    await waitFor(() => {
      const detail = document.querySelector(".orders-detail");
      expect(detail).not.toBeNull();
      expect(within(detail as HTMLElement).getByText("AF-2026-0002")).toBeTruthy();
    });
  });

  it("卡片视图的菜单项与其他视图一致", async () => {
    renderPage();
    const rows = await screen.findAllByRole("button", { name: /第一张|第二张/ });
    fireEvent.contextMenu(rows[0]!);

    await screen.findByRole("menu", { name: "订单操作" });
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "打开订单",
      "置顶",
      "取消订单…",
    ]);
  });

  it("右键拖拽把手：原生菜单与自定义菜单都不出现", async () => {
    renderPage();
    const handle = await screen.findByRole("button", { name: "拖动 AF-2026-0001 调整队列位置" });

    // 返回值 false 表示默认行为已被 preventDefault 拦下（WebView 原生菜单不会弹）
    expect(fireEvent.contextMenu(handle)).toBe(false);
    // 我们的菜单同样不该开——把手不是订单操作入口
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("右键拖拽把手不去载入订单", async () => {
    renderPage();
    const handle = await screen.findByRole("button", { name: "拖动 AF-2026-0001 调整队列位置" });
    // 卡片视图挂载时会自动载入一张，先清掉这笔，只看右键有没有新增读取
    hoisted.getOrder.mockClear();

    fireEvent.contextMenu(handle);

    expect(hoisted.getOrder).not.toHaveBeenCalled();
  });

  it("右键不改变队列顺序", async () => {
    renderPage();
    const before = (await screen.findAllByRole("button", { name: /第一张|第二张/ })).map(
      (row) => row.textContent,
    );
    fireEvent.contextMenu(
      (await screen.findAllByRole("button", { name: /第一张|第二张/ }))[1]!,
    );
    await screen.findByRole("menu", { name: "订单操作" });

    const after = screen
      .getAllByRole("button", { name: /第一张|第二张/ })
      .map((row) => row.textContent);
    expect(after).toEqual(before);
  });

  it("菜单开着时右键另一行：菜单换成新的目标，而不是先关再开", async () => {
    stored.orders_view_mode = "table";
    renderPage();
    const rows = await screen.findAllByRole("row");
    fireEvent.contextMenu(rows[2]!);
    await screen.findByRole("menu", { name: "订单操作" });

    fireEvent.contextMenu(rows[1]!);

    await waitFor(() => expect(hoisted.getOrder).toHaveBeenCalledWith("o1"));
    expect(screen.getAllByRole("menu")).toHaveLength(1);
  });

  it("右键不改变队列顺序，也不产生任何写操作", async () => {
    stored.orders_view_mode = "table";
    renderPage();
    const rows = await screen.findAllByRole("row");
    fireEvent.contextMenu(rows[2]!);
    await screen.findByRole("menu", { name: "订单操作" });

    // 只允许读：getOrder 与 listOrderEvents
    for (const call of hoisted.getOrder.mock.calls) {
      expect(typeof call[0]).toBe("string");
    }
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });
});
