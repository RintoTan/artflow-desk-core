import { RouterProvider, createMemoryRouter } from "react-router-dom";
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
const createOrder = vi.fn(async () => order);

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
      updateOrderDetails: (...args: unknown[]) => updateOrderDetails(...(args as [])),
      createOrder: (...args: unknown[]) => createOrder(...(args as [])),
      status: async () => ({
        appVersion: "0.1.0",
        firstRun: false,
        generation: "gen-test",
        schemaVersion: 3,
        upgradedFrom: null,
        rootPath: "/tmp/test",
        qaMode: false,
        qaScenario: null,
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
        foreignKeys: true,
        attachmentIssues: 0,
        generationCount: 1,
        backupCount: 0,
      }),
    },
    templateApi: {
      list: async () => [
        { id: "tpl-default", name: "通用制作流程", stepCount: 5, isDefault: true, usageCount: 1 },
      ],
    },
    queueApi: { list: async () => ({ revision: 0, entries: [] }), move: vi.fn() },
    attachmentApi: { list: async () => [] },
    preferenceApi: { get: async () => null, set: async () => null },
    clientApi: { list: async () => [] },
  };
});

async function setup() {
  const { default: OrdersPage } = await import("./OrdersPage");
  const router = createMemoryRouter([{ path: "/orders", element: <OrdersPage /> }], {
    initialEntries: ["/orders"],
  });
  render(<RouterProvider router={router} />);
  await screen.findByDisplayValue("测试委托");
}

async function makeDirty(user: ReturnType<typeof userEvent.setup>) {
  const title = screen.getByDisplayValue("测试委托");
  await user.clear(title);
  await user.type(title, "改动过的标题");
}

describe("SAFE-01：订单详情 dirty 时打开新建面板", () => {
  beforeEach(() => {
    updateOrderDetails.mockClear();
    createOrder.mockClear();
    updateOrderDetails.mockImplementation(async () => order);
  });

  it("不直接打开新建面板，而是先弹离页保护", async () => {
    const user = userEvent.setup();
    await setup();
    await makeDirty(user);

    await user.click(screen.getByRole("button", { name: "新建" }));

    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "新建订单" })).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("改动过的标题")).toBeInTheDocument();
  });

  it("取消：留在订单详情，草稿完整保留，不打开新建面板", async () => {
    const user = userEvent.setup();
    await setup();
    await makeDirty(user);
    await user.click(screen.getByRole("button", { name: "新建" }));
    await screen.findByRole("alertdialog");

    await user.click(screen.getByRole("button", { name: "继续编辑" }));

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByDisplayValue("改动过的标题")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "新建订单" })).not.toBeInTheDocument();
    expect(updateOrderDetails).not.toHaveBeenCalled();
  });

  it("放弃：草稿被明确丢弃后才允许打开新建面板", async () => {
    const user = userEvent.setup();
    await setup();
    await makeDirty(user);
    await user.click(screen.getByRole("button", { name: "新建" }));
    await screen.findByRole("alertdialog");

    await user.click(screen.getByRole("button", { name: "放弃修改" }));

    expect(await screen.findByRole("heading", { name: "新建订单" })).toBeInTheDocument();
    expect(screen.queryByDisplayValue("改动过的标题")).not.toBeInTheDocument();
    expect(updateOrderDetails).not.toHaveBeenCalled();

    // 关掉新建面板、重新打开这张单：标题必须是已保存的原文，证明草稿被丢弃而不是被偷偷保存
    await user.click(screen.getByRole("button", { name: "取消" }));
    const row = document.querySelector<HTMLButtonElement>("button.order-row");
    expect(row).not.toBeNull();
    await user.click(row!);
    await waitFor(() => expect(screen.getByDisplayValue("测试委托")).toBeInTheDocument());
    expect(screen.queryByDisplayValue("改动过的标题")).not.toBeInTheDocument();
  });

  it("保存：先落库再打开新建面板", async () => {
    const user = userEvent.setup();
    await setup();
    await makeDirty(user);
    await user.click(screen.getByRole("button", { name: "新建" }));
    await screen.findByRole("alertdialog");

    await user.click(screen.getByRole("button", { name: "保存并离开" }));

    await waitFor(() => expect(updateOrderDetails).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("heading", { name: "新建订单" })).toBeInTheDocument();
  });

  it("保存失败：草稿保留，且不进入新建面板", async () => {
    updateOrderDetails.mockImplementationOnce(async () => {
      throw { code: "CONFLICT", message: "revision 不匹配" };
    });
    const user = userEvent.setup();
    await setup();
    await makeDirty(user);
    await user.click(screen.getByRole("button", { name: "新建" }));
    await screen.findByRole("alertdialog");

    await user.click(screen.getByRole("button", { name: "保存并离开" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("revision");
    expect(screen.queryByRole("heading", { name: "新建订单" })).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("改动过的标题")).toBeInTheDocument();
  });
});
