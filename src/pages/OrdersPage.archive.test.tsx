import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { OrderView } from "../bridge/commands";

function order(overrides: Partial<OrderView> = {}): OrderView {
  return {
    id: "o1",
    code: "AF-2026-0001",
    title: "已交付的委托",
    clientId: null,
    clientName: null,
    commissionType: null,
    stageTemplateId: "tpl-a",
    source: null,
    amountCents: 120000,
    note: null,
    status: "complete",
    workState: "completed",
    currentStageId: "line",
    currentStageTitle: "线稿",
    currentStageIndex: 1,
    stageCount: 2,
    stages: [
      { id: "draft", title: "草稿", position: 0, isCurrent: false },
      { id: "line", title: "线稿", position: 1, isCurrent: true },
    ],
    queuePosition: 0,
    plannedStartDate: null,
    plannedDeliveryDate: null,
    deadlineState: "scheduled",
    startedAt: "2026-11-01T00:00:00.000Z",
    completedAt: "2026-11-10T00:00:00.000Z",
    cancelledAt: null,
    revision: 3,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-10T00:00:00.000Z",
    archivedAt: null,
    capabilities: {
      canStartWork: false,
      canUndoStartWork: false,
      undoBlockedReason: null,
      canAdvance: false,
      canRework: false,
      canSkip: false,
      canComplete: false,
      canCancel: false,
      canReopen: true,
      canEditWorkflow: false,
    },
    ...overrides,
  };
}

const LIVE = order();
const ARCHIVED = order({
  id: "o2",
  code: "AF-2026-0002",
  title: "去年的委托",
  archivedAt: "2026-11-20T00:00:00+08:00",
});
const ACTIVE = order({
  id: "o3",
  code: "AF-2026-0003",
  title: "还在做的委托",
  status: "active",
  workState: "inProgress",
  completedAt: null,
  archivedAt: null,
});

let orders: OrderView[] = [LIVE, ARCHIVED, ACTIVE];
const listOrders = vi.fn(async () => orders);
const getOrder = vi.fn(async (id: string) => orders.find((o) => o.id === id) ?? LIVE);
const archiveOrder = vi.fn(async (id: string) => {
  const target = orders.find((o) => o.id === id)!;
  const next = { ...target, archivedAt: "2026-11-23T00:00:00+08:00" };
  orders = orders.map((o) => (o.id === id ? next : o));
  return next;
});
const unarchiveOrder = vi.fn(async (id: string) => {
  const target = orders.find((o) => o.id === id)!;
  const next = { ...target, archivedAt: null };
  orders = orders.map((o) => (o.id === id ? next : o));
  return next;
});

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    api: {
      listOrders,
      listClients: async () => [],
      getOrder,
      listOrderEvents: async () => [],
      status: async () => ({
        appVersion: "0.1.0",
        firstRun: false,
        generation: "gen-test",
        schemaVersion: 9,
        upgradedFrom: null,
        rootPath: "/tmp/test",
        sqliteVersion: "3.54.1",
        journalMode: "wal",
        workingTimezone: "Asia/Shanghai",
        systemTimezone: "Asia/Shanghai",
        lockHeld: true,
        orders: 3,
        clients: 0,
        templates: 1,
        attachments: 0,
        pendingCleanup: 0,
        highWater: [],
        integrity: "ok",
      }),
      updateOrderDetails: vi.fn(),
      archiveOrder,
      unarchiveOrder,
    },
    templateApi: { list: async () => [] },
    queueApi: {
      list: async () => ({ revision: 0, entries: [] }),
      move: async () => ({ revision: 1, entries: [] }),
    },
    preferenceApi: { get: async () => "comfortable", set: async () => null },
    attachmentApi: { list: async () => [] },
    statsApi: { exportOrders: vi.fn() },
    trashApi: { deleteOrder: vi.fn() },
  };
});

async function setup() {
  const { QaRefreshContext } = await import("../lib/qaRefresh");
  const { default: OrdersPage } = await import("./OrdersPage");
  const router = createMemoryRouter([{ path: "/orders", element: <OrdersPage /> }], {
    initialEntries: ["/orders"],
  });
  render(
    <QaRefreshContext.Provider value={() => {}}>
      <RouterProvider router={router} />
    </QaRefreshContext.Provider>,
  );
  await screen.findAllByText(/张 ·/);
  const list = document.querySelector(".orders-list");
  if (!list) throw new Error("找不到订单列表");
  const scope = within(list as HTMLElement);
  const row = (code: string) =>
    Array.from((list as HTMLElement).querySelectorAll("button.order-row")).find((b) =>
      (b.textContent ?? "").includes(code),
    ) as HTMLButtonElement | undefined;
  const detailEl = document.querySelector(".orders-detail");
  const detail = () => {
    if (!detailEl) throw new Error("找不到订单详情");
    return within(detailEl as HTMLElement);
  };
  return { ...scope, row, detail };
}

describe("订单归档", () => {
  it("普通列表默认只显示未归档订单", async () => {
    orders = [LIVE, ARCHIVED, ACTIVE];
    const list = await setup();
    expect(list.row("AF-2026-0002")).toBeUndefined();
    expect(list.row("AF-2026-0001")).toBeTruthy();
    expect(screen.getByRole("button", { name: "普通" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("归档空间只显示已归档订单，并带「已归档」标记", async () => {
    const user = userEvent.setup();
    orders = [LIVE, ARCHIVED, ACTIVE];
    const list = await setup();

    await user.click(screen.getByRole("group", { name: "订单归属" }).querySelectorAll("button")[1]!);

    await waitFor(() => expect(list.row("AF-2026-0002")).toBeTruthy());
    expect(list.row("AF-2026-0001")).toBeUndefined();
    expect(list.getByText("已归档")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新建" })).not.toBeInTheDocument();
  });

  it("只有已完成订单能归档；未完成时按钮禁用并说明原因", async () => {
    const user = userEvent.setup();
    orders = [ACTIVE];
    const list = await setup();

    const target = list.row("AF-2026-0003");
    expect(target).toBeTruthy();
    await user.click(target!);

    const summary = await list.detail().findByText("数据归档");
    const zone = summary.closest("details") as HTMLDetailsElement;
    expect(zone.open).toBe(false);
    await user.click(summary);
    expect(zone.open).toBe(true);

    const archiveBtn = list.detail().getByRole("button", { name: "归档" });
    expect(archiveBtn).toBeDisabled();
    expect(archiveBtn).toHaveAttribute("title", "只有已完成的订单可以归档");
  });

  it("归档后从普通列表消失，取消归档后回到普通列表", async () => {
    const user = userEvent.setup();
    orders = [LIVE, ARCHIVED, ACTIVE];
    const list = await setup();

    await user.click(list.row("AF-2026-0001")!);
    await user.click(await list.detail().findByText("数据归档"));

    await user.click(list.detail().getByRole("button", { name: "归档" }));
    await waitFor(() => expect(archiveOrder).toHaveBeenCalledWith("o1"));
    await waitFor(() =>
      expect(list.row("AF-2026-0001")).toBeUndefined(),
    );

    await user.click(screen.getByRole("group", { name: "订单归属" }).querySelectorAll("button")[1]!);
    await waitFor(() => expect(list.row("AF-2026-0002")).toBeTruthy());
    await user.click(list.row("AF-2026-0002")!);
    await list.detail().findByText("数据归档");
    await user.click(list.detail().getByRole("button", { name: "取消归档" }));
    await waitFor(() => expect(unarchiveOrder).toHaveBeenCalledWith("o2"));
  });
});
