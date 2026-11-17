import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OrderView } from "../bridge/commands";

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
      canComplete: false,
      canCancel: true,
      canReopen: false,
      canEditWorkflow: true,
    },
  };
}

const ORDERS = [
  order("o1", "AF-2026-0001", "甲", 0),
  order("o2", "AF-2026-0002", "乙", 1),
];

const exportOrders = vi.fn(async () => ({ path: "/tmp/o.csv", rows: 2, bytes: 200 }));
const saveDialog = vi.fn(async () => null as string | null);

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    api: {
      listOrders: async () => ORDERS,
      listClients: async () => [],
      getOrder: async (id: string) => ORDERS.find((o) => o.id === id) ?? ORDERS[0]!,
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
    statsApi: { exportOrders },
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => saveDialog(...(args as [])),
}));

async function setup() {
  const { default: OrdersPage } = await import("./OrdersPage");
  const router = createMemoryRouter([{ path: "/orders", element: <OrdersPage /> }], {
    initialEntries: ["/orders"],
  });
  render(<RouterProvider router={router} />);
  await screen.findByRole("button", { name: "拖动 AF-2026-0001 调整队列位置" });
}

describe("订单明细导出", () => {
  beforeEach(() => {
    exportOrders.mockClear();
    saveDialog.mockClear();
  });

  it("打开对话框时显示两种范围的预计条数", async () => {
    const user = userEvent.setup();
    await setup();
    await user.click(screen.getByRole("button", { name: "导出" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("导出订单明细 CSV");
    expect(screen.getByText("当前筛选结果（2 条）")).toBeInTheDocument();
    expect(screen.getByText("全部订单（2 条）")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("不包含客户联系方式");
  });

  it("取消保存时不导出、不提示成功", async () => {
    const user = userEvent.setup();
    saveDialog.mockResolvedValueOnce(null);
    await setup();
    await user.click(screen.getByRole("button", { name: "导出" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "选择保存位置" }));

    await waitFor(() => expect(saveDialog).toHaveBeenCalled());
    expect(exportOrders).not.toHaveBeenCalled();
    expect(screen.queryByText(/已导出/)).not.toBeInTheDocument();
  });

  it("默认导出当前筛选结果，并传入当前可见的订单 ID", async () => {
    const user = userEvent.setup();
    saveDialog.mockResolvedValueOnce("/tmp/o.csv");
    await setup();
    await user.click(screen.getByRole("button", { name: "导出" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "选择保存位置" }));

    await waitFor(() => expect(exportOrders).toHaveBeenCalledTimes(1));
    expect(exportOrders).toHaveBeenCalledWith({
      path: "/tmp/o.csv",
      scope: "filtered",
      orderIds: ["o1", "o2"],
    });
    expect(await screen.findByText(/已导出 2 条订单/)).toBeInTheDocument();
  });

  it("选择全部订单时不传 ID", async () => {
    const user = userEvent.setup();
    saveDialog.mockResolvedValueOnce("/tmp/all.csv");
    await setup();
    await user.click(screen.getByRole("button", { name: "导出" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("radio", { name: /全部订单/ }));
    await user.click(screen.getByRole("button", { name: "选择保存位置" }));

    await waitFor(() => expect(exportOrders).toHaveBeenCalledTimes(1));
    expect(exportOrders).toHaveBeenCalledWith({
      path: "/tmp/all.csv",
      scope: "all",
      orderIds: [],
    });
  });

  it("筛选后预计条数随之变化", async () => {
    const user = userEvent.setup();
    await setup();
    await user.type(screen.getByLabelText("搜索订单"), "甲");
    await user.click(screen.getByRole("button", { name: "导出" }));

    await screen.findByRole("alertdialog");
    expect(screen.getByText("当前筛选结果（1 条）")).toBeInTheDocument();
  });

  it("导出失败时显示错误且不提示成功", async () => {
    const user = userEvent.setup();
    saveDialog.mockResolvedValueOnce("/tmp/o.csv");
    exportOrders.mockRejectedValueOnce({ code: "IO", message: "磁盘只读" });
    await setup();
    await user.click(screen.getByRole("button", { name: "导出" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "选择保存位置" }));

    await waitFor(() => expect(screen.getByText(/磁盘只读/)).toBeInTheDocument());
    expect(screen.queryByText(/已导出/)).not.toBeInTheDocument();
  });
});
