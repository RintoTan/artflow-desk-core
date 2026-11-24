import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OrderView } from "../bridge/commands";

function order(id: string, code: string, title: string): OrderView {
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
    queuePosition: 0,
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

const ORDERS = [order("o1", "AF-2026-0001", "甲")];
const listOrders = vi.fn(async () => ORDERS);
const deleteOrder = vi.fn(async () => ({ orderId: "o1", deletedAt: "2026-11-21T00:00:00+08:00" }));

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    // 财务面板一挂载就会拉一次 snapshot；这两个页面测试不关心财务，给个空视图即可，
    // 否则它会渲染自己的错误提示，和页面错误撞成两个 alert。
    paymentsApi: {
      ...actual.paymentsApi,
      snapshot: async () => ({
        orderId: "o0",
        orderAmountCents: null,
        planMode: "none",
        planItems: [],
        planTotalCents: 0,
        planMatchesOrder: false,
        records: [],
        voidedRecords: [],
        refunds: [],
        voidedRefunds: [],
        grossReceivedCents: 0,
        feeTotalCents: 0,
        netReceivedCents: 0,
        refundTotalCents: 0,
        netRetainedCents: 0,
        remainingCents: null,
        overReceivedCents: 0,
        unrecorded: true,
        hasRecordsWithoutPlan: false,
        cancelled: false,
      }),
      quoteFee: async () => ({ amountCents: 0, feeRateBp: null, suggestedFeeCents: null }),
    },
    financeApi: { ...actual.financeApi, platforms: async () => [] },
    api: {
      listOrders,
      listClients: async () => [],
      getOrder: async () => ORDERS[0]!,
      listOrderEvents: async () => [],
      status: async () => ({
        appVersion: "0.1.0",
        firstRun: false,
        generation: "gen-test",
        schemaVersion: 8,
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
      updateOrderDetails: vi.fn(),
    },
    templateApi: { list: async () => [] },
    queueApi: {
      list: async () => ({ revision: 0, entries: [] }),
      move: async () => ({ revision: 1, entries: [] }),
    },
    preferenceApi: { get: async () => "comfortable", set: async () => null },
    attachmentApi: { list: async () => [] },
    statsApi: { exportOrders: vi.fn() },
    trashApi: { deleteOrder },
  };
});

async function setup(refreshQa?: () => void) {
  const { QaRefreshContext } = await import("../lib/qaRefresh");
  const { default: OrdersPage } = await import("./OrdersPage");
  const router = createMemoryRouter([{ path: "/orders", element: <OrdersPage /> }], {
    initialEntries: ["/orders"],
  });
  render(
    <QaRefreshContext.Provider value={refreshQa ?? (() => {})}>
      <RouterProvider router={router} />
    </QaRefreshContext.Provider>,
  );
  const cells = await screen.findAllByText("AF-2026-0001");
  await userEvent.click(cells[0]!);
  // 归档卡片出现即代表抽屉已打开。
  await screen.findByText("数据归档");
}

beforeEach(() => {
  listOrders.mockClear();
  deleteOrder.mockReset();
  deleteOrder.mockResolvedValue({ orderId: "o1", deletedAt: "2026-11-21T00:00:00+08:00" });
});

describe("订单详情里的删除入口", () => {
  it("删除入口收在默认折叠的「数据归档」卡片里", async () => {
    await setup();
    const zone = screen.getByText("数据归档").closest("details");
    expect(zone).not.toBeNull();
    expect((zone as HTMLDetailsElement).open).toBe(false);
    expect(zone).toContainElement(screen.getByRole("button", { name: "移入回收站…" }));
    expect(zone).toHaveTextContent("可随时恢复");
  });

  it("展开后才看得到归档与移入回收站两个动作", async () => {
    const user = userEvent.setup();
    await setup();
    const zone = screen.getByText("数据归档").closest("details") as HTMLDetailsElement;
    await user.click(screen.getByText("数据归档"));
    expect(zone.open).toBe(true);
    expect(zone).toContainElement(screen.getByRole("button", { name: "移入回收站…" }));
  });

  it("取消确认不会调用删除 API，抽屉保持打开", async () => {
    const user = userEvent.setup();
    await setup();

    await user.click(screen.getByRole("button", { name: "移入回收站…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("移入回收站？");
    expect(dialog).toHaveTextContent("订单「甲」将被移入回收站");

    await user.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(deleteOrder).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "移入回收站…" })).toBeInTheDocument();
  });

  it("确认后关闭抽屉、刷新列表并提示成功", async () => {
    const user = userEvent.setup();
    await setup();
    const callsBefore = listOrders.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "移入回收站…" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "移入回收站" }));

    await waitFor(() => expect(deleteOrder).toHaveBeenCalledWith("o1"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "移入回收站…" })).not.toBeInTheDocument(),
    );
    expect(await screen.findByText("已移入回收站")).toBeInTheDocument();
    expect(listOrders.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("删除失败时展示错误，不关闭对话框、不提示成功", async () => {
    const user = userEvent.setup();
    deleteOrder.mockRejectedValueOnce(
      Object.assign(new Error("订单正在被占用"), { code: "CONFLICT" }),
    );
    await setup();

    await user.click(screen.getByRole("button", { name: "移入回收站…" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "移入回收站" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("订单正在被占用");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.queryByText("已移入回收站")).not.toBeInTheDocument();
  });

  it("成功后重新读取 QA 横幅数据", async () => {
    const user = userEvent.setup();
    const refreshQa = vi.fn();
    await setup(refreshQa);

    await user.click(screen.getByRole("button", { name: "移入回收站…" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "移入回收站" }));

    await waitFor(() => expect(refreshQa).toHaveBeenCalledTimes(1));
  });

  it("删除成功但列表刷新失败时，成功提示与错误同时保留", async () => {
    const user = userEvent.setup();
    await setup();
    listOrders.mockRejectedValueOnce(new Error("列表读取失败"));

    await user.click(screen.getByRole("button", { name: "移入回收站…" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "移入回收站" }));

    expect(await screen.findByText("已移入回收站")).toBeInTheDocument();
    expect(await screen.findByText(/列表读取失败/)).toBeInTheDocument();
    // 抽屉已关闭，确认框不再显示。
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
