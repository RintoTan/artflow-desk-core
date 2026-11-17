import { Link, Outlet, RouterProvider, createMemoryRouter } from "react-router-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OrderView } from "../bridge/commands";

function order(id: string, code: string, title: string, queuePosition: number): OrderView {
  return {
    id,
    code,
    title,
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
    stageCount: 2,
    stages: [
      { id: "draft", title: "草稿", position: 0, isCurrent: true },
      { id: "line", title: "线稿", position: 1, isCurrent: false },
    ],
    queuePosition,
    plannedStartDate: null,
    plannedDeliveryDate: null,
    deadlineState: "scheduled",
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    revision: 3,
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
      canReopen: false,
      canEditWorkflow: true,
    },
  };
}

const ORDERS = [
  order("o1", "AF-2026-0001", "第一张", 0),
  order("o2", "AF-2026-0002", "第二张", 1),
  order("o3", "AF-2026-0003", "第三张", 2),
];

const listOrders = vi.fn(async () => ORDERS);
type MoveInput = { orderId: string; expectedQueueRevision: number; toIndex: number };
const queueMove = vi.fn(async (_input: MoveInput) => ({ revision: 6, entries: [] as never[] }));
const queueList = vi.fn(async () => ({ revision: 5, entries: [] }));

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    api: {
      listOrders,
      listClients: async () => [],
      getOrder: async (id: string) => ORDERS.find((o) => o.id === id) ?? ORDERS[0]!,
      listOrderEvents: async () => [],
      status: async () => ({
        appVersion: "0.1.0",
        firstRun: false,
        generation: "gen-test",
        schemaVersion: 2,
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
    },
    templateApi: { list: async () => [] },
    queueApi: { list: queueList, move: queueMove },
    attachmentApi: {
      list: async () => [],
    },
    preferenceApi: { get: async () => "comfortable", set: async () => null },
  };
});

async function setup() {
  const { default: OrdersPage } = await import("./OrdersPage");
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: (
          <div>
            <Link to="/clients">去客户页</Link>
            <Outlet />
          </div>
        ),
        children: [
          { path: "orders", element: <OrdersPage /> },
          { path: "clients", element: <div>客户页内容</div> },
        ],
      },
    ],
    { initialEntries: ["/orders"] },
  );
  render(<RouterProvider router={router} />);
  // 用拖拽手柄作为列表已渲染的锚点：详情区也会显示标题，按文本找会撞车。
  await screen.findByRole("button", { name: "拖动 AF-2026-0001 调整队列位置" });
}

function rowOf(title: string): HTMLElement {
  const region = document.querySelector(".order-rows");
  if (!region) throw new Error("订单列表尚未渲染");
  const li = within(region as HTMLElement).getByText(title).closest("li");
  if (!li) throw new Error(`找不到 ${title} 所在行`);
  return li as HTMLElement;
}

describe("订单队列拖拽", () => {
  beforeEach(() => {
    queueMove.mockClear();
    queueMove.mockImplementation(async (_input: MoveInput) => ({
      revision: 6,
      entries: [] as never[],
    }));
    listOrders.mockClear();
  });

  it("每个活动订单都有明确的拖拽手柄", async () => {
    await setup();
    expect(screen.getByRole("button", { name: "拖动 AF-2026-0001 调整队列位置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "拖动 AF-2026-0003 调整队列位置" })).toBeInTheDocument();
  });

  it("拖动手柄经过另一行后松开，会按目标位置调用 queue_move 并刷新列表", async () => {
    await setup();
    const before = listOrders.mock.calls.length;

    const handle = screen.getByRole("button", { name: "拖动 AF-2026-0001 调整队列位置" });
    fireEvent.pointerDown(handle);
    // 拖动中应有目标反馈
    expect(await screen.findByText(/松开后放到第 1 位/)).toBeInTheDocument();

    fireEvent.pointerEnter(rowOf("第三张"));
    expect(await screen.findByText(/松开后放到第 3 位/)).toBeInTheDocument();

    window.dispatchEvent(new Event("pointerup"));

    await waitFor(() => expect(queueMove).toHaveBeenCalledTimes(1));
    expect(queueMove).toHaveBeenCalledWith({
      orderId: "o1",
      expectedQueueRevision: 5,
      toIndex: 2,
    });
    await waitFor(() => expect(listOrders.mock.calls.length).toBeGreaterThan(before));
  });

  it("放回原位不会调用 queue_move", async () => {
    await setup();
    const handle = screen.getByRole("button", { name: "拖动 AF-2026-0002 调整队列位置" });
    fireEvent.pointerDown(handle);
    fireEvent.pointerEnter(rowOf("第二张"));
    window.dispatchEvent(new Event("pointerup"));

    await waitFor(() => expect(screen.queryByText(/松开后放到/)).not.toBeInTheDocument());
    expect(queueMove).not.toHaveBeenCalled();
  });

  it("拖到边界之外时按夹取后的位置提交（不会越界）", async () => {
    await setup();
    const handle = screen.getByRole("button", { name: "拖动 AF-2026-0003 调整队列位置" });
    fireEvent.pointerDown(handle);
    fireEvent.pointerEnter(rowOf("第一张"));
    window.dispatchEvent(new Event("pointerup"));

    await waitFor(() => expect(queueMove).toHaveBeenCalledTimes(1));
    expect(queueMove.mock.calls[0]?.[0]).toMatchObject({ orderId: "o3", toIndex: 0 });
  });

  it("↑ / ↓ 仍然可用，并与拖拽走同一条命令", async () => {
    const user = userEvent.setup();
    await setup();
    await user.click(screen.getByRole("button", { name: "把 AF-2026-0002 上移" }));

    await waitFor(() => expect(queueMove).toHaveBeenCalledTimes(1));
    expect(queueMove.mock.calls[0]?.[0]).toMatchObject({ orderId: "o2", toIndex: 0 });
  });

  it("筛选到终态时不给拖拽手柄，并说明原因", async () => {
    const user = userEvent.setup();
    await setup();
    await user.click(screen.getByRole("button", { name: "已完成" }));

    expect(screen.queryByRole("button", { name: /拖动 AF-2026-0001/ })).not.toBeInTheDocument();
    expect(screen.getByText(/当前筛选下不显示活动队列/)).toBeInTheDocument();
  });
});
