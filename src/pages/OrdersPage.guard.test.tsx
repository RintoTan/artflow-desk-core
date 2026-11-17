import { Link, Outlet, RouterProvider, createMemoryRouter } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OrderView } from "../bridge/commands";

const order: OrderView = {
  id: "order-1",
  code: "AF-2026-0001",
  title: "测试委托",
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
    undoBlockedReason: "订单尚未开工",
    canAdvance: false,
    canRework: false,
    canComplete: false,
    canCancel: true,
    canReopen: false,
    canEditWorkflow: true,
  },
};

const updateOrderDetails = vi.fn(async () => order);

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    api: {
      listOrders: async () => [order],
      listClients: async () => [],
      getOrder: async () => order,
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
        orders: 1,
        clients: 0,
        templates: 1,
        attachments: 0,
        pendingCleanup: 0,
        highWater: [],
        integrity: "ok",
      }),
      updateOrderDetails,
    },
    templateApi: { list: async () => [] },
    queueApi: {
      list: async () => ({ revision: 0, entries: [] }),
      move: async () => ({ revision: 1, entries: [] }),
    },
    attachmentApi: {
      list: async () => [],
    },
    preferenceApi: {
      get: async () => null,
      set: async () => null,
    },
    clientApi: {
      list: async () => [],
    },
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
  await screen.findByDisplayValue("测试委托");
}

async function makeDirty(user: ReturnType<typeof userEvent.setup>) {
  const title = screen.getByDisplayValue("测试委托");
  await user.clear(title);
  await user.type(title, "改动过的标题");
}

describe("订单页离页保护", () => {
  beforeEach(() => {
    updateOrderDetails.mockClear();
  });

  it("有未保存修改时导航会弹出模态确认，而不是直接离开", async () => {
    const user = userEvent.setup();
    await setup();
    await makeDirty(user);

    await user.click(screen.getByRole("link", { name: "去客户页" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("有尚未保存的修改");
    expect(screen.getByRole("button", { name: "保存并离开" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "放弃修改" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "继续编辑" })).toHaveFocus(),
    );

    // 仍在订单页，草稿未被清空
    expect(screen.queryByText("客户页内容")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("改动过的标题")).toBeInTheDocument();
  });

  it("「继续编辑」关闭对话框并留在原地，草稿仍在", async () => {
    const user = userEvent.setup();
    await setup();
    await makeDirty(user);

    await user.click(screen.getByRole("link", { name: "去客户页" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "继续编辑" }));

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByDisplayValue("改动过的标题")).toBeInTheDocument();
    expect(screen.queryByText("客户页内容")).not.toBeInTheDocument();
  });

  it("Esc 不会离开页面，也不会丢草稿", async () => {
    const user = userEvent.setup();
    await setup();
    await makeDirty(user);

    await user.click(screen.getByRole("link", { name: "去客户页" }));
    await screen.findByRole("alertdialog");
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByDisplayValue("改动过的标题")).toBeInTheDocument();
    expect(screen.queryByText("客户页内容")).not.toBeInTheDocument();
  });

  it("「放弃修改」才真正离开", async () => {
    const user = userEvent.setup();
    await setup();
    await makeDirty(user);

    await user.click(screen.getByRole("link", { name: "去客户页" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "放弃修改" }));

    expect(await screen.findByText("客户页内容")).toBeInTheDocument();
  });

  it("「保存并离开」先保存再跳转", async () => {
    const user = userEvent.setup();
    await setup();
    await makeDirty(user);

    await user.click(screen.getByRole("link", { name: "去客户页" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "保存并离开" }));

    await waitFor(() => expect(updateOrderDetails).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("客户页内容")).toBeInTheDocument();
  });

  it("没有修改时导航不弹对话框", async () => {
    const user = userEvent.setup();
    await setup();

    await user.click(screen.getByRole("link", { name: "去客户页" }));

    expect(await screen.findByText("客户页内容")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
