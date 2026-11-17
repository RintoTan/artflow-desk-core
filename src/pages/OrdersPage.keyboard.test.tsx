import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { popModal, pushModal, resetModalStack } from "../lib/modalStack";

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
}

const ORDERS = [
  order("order-a", "AF-2026-0001", "第一张订单", 0),
  order("order-b", "AF-2026-0002", "第二张订单", 1),
  order("order-c", "AF-2026-0003", "第三张订单", 2),
];

const getOrder = vi.fn(async (id: string) => ORDERS.find((o) => o.id === id) ?? ORDERS[0]!);
const queueMove = vi.fn(async () => ({
  revision: 0,
  orders: ORDERS.map((o) => ({ id: o.id, code: o.code, title: o.title })),
}));

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    api: {
      listOrders: async () => ORDERS,
      listClients: async () => [],
      getOrder: (id: string) => getOrder(id),
      listOrderEvents: async () => [],
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
        orders: 3,
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
    templateApi: { list: async () => [] },
    queueApi: {
      list: async () => ({ revision: 0, entries: [] }),
      move: queueMove,
    },
    attachmentApi: { list: async () => [] },
    preferenceApi: { get: async () => null, set: async () => null },
    clientApi: { list: async () => [] },
  };
});

async function renderOrders() {
  const { default: OrdersPage } = await import("./OrdersPage");
  const router = createMemoryRouter([{ path: "/orders", element: <OrdersPage /> }], {
    initialEntries: ["/orders"],
  });
  render(<RouterProvider router={router} />);
  // 标题同时出现在列表行与详情 h1，按行按钮定位更稳。
  await screen.findAllByRole("button", { name: /AF-2026-0001/ });
}

// 用 class 定位订单行：队列上/下移按钮的 aria-label 也含编号，按名字会重复命中。
function rows() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button.order-row"));
}

describe("订单列表键盘操作", () => {
  beforeEach(() => {
    getOrder.mockClear();
    queueMove.mockClear();
  });

  it("方向键只移动光标，不打开详情、不改队列", async () => {
    await renderOrders();
    await waitFor(() => expect(getOrder).toHaveBeenCalledTimes(1)); // 挂载时默认打开第一张

    const first = rows()[0]!;
    first.focus();
    await userEvent.keyboard("{ArrowDown}");

    expect(rows()[1]).toHaveClass("order-row-cursor");
    expect(getOrder).toHaveBeenCalledTimes(1);
    expect(queueMove).not.toHaveBeenCalled();

    await userEvent.keyboard("{ArrowDown}");
    expect(rows()[2]).toHaveClass("order-row-cursor");

    // 到末尾不越界
    await userEvent.keyboard("{ArrowDown}");
    expect(rows()[2]).toHaveClass("order-row-cursor");
  });

  it("Enter 打开光标所在的订单", async () => {
    await renderOrders();
    await waitFor(() => expect(getOrder).toHaveBeenCalledTimes(1));

    rows()[0]!.focus();
    await userEvent.keyboard("{ArrowDown}{Enter}");

    await waitFor(() => expect(getOrder).toHaveBeenLastCalledWith("order-b"));
    expect(queueMove).not.toHaveBeenCalled();
  });

  it("在搜索框里按方向键不会切换订单", async () => {
    await renderOrders();
    await waitFor(() => expect(getOrder).toHaveBeenCalledTimes(1));

    const search = screen.getByLabelText("搜索订单");
    await userEvent.click(search);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    await userEvent.keyboard("第二");

    expect(getOrder).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("第二张订单");
  });

  it("Cmd+N 打开新建面板，重复按不会叠出第二个", async () => {
    await renderOrders();
    await userEvent.keyboard("{Meta>}n{/Meta}");
    await screen.findByRole("heading", { name: "新建订单" });

    await waitFor(() => expect(screen.getAllByRole("heading", { name: "新建订单" })).toHaveLength(1));
    await userEvent.keyboard("{Meta>}n{/Meta}");
    expect(screen.getAllByRole("heading", { name: "新建订单" })).toHaveLength(1);
  });

  it("Cmd+F 聚焦搜索框", async () => {
    await renderOrders();
    await userEvent.keyboard("{Meta>}f{/Meta}");
    expect(screen.getByLabelText("搜索订单")).toHaveFocus();
  });
});

describe("键盘光标自动滚动（KEY-01）", () => {
  const scrolled: { text: string; options: ScrollIntoViewOptions | boolean | undefined }[] = [];
  let original: typeof Element.prototype.scrollIntoView;

  beforeEach(() => {
    getOrder.mockClear();
    queueMove.mockClear();
    scrolled.length = 0;
    original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = vi.fn(function (
      this: Element,
      options?: ScrollIntoViewOptions | boolean,
    ) {
      scrolled.push({ text: this.textContent ?? "", options });
    }) as unknown as typeof Element.prototype.scrollIntoView;
    resetModalStack();
  });

  afterEach(() => {
    Element.prototype.scrollIntoView = original;
    resetModalStack();
  });

  it("光标移动时把该行滚进可视区，用的是 nearest（已可见就不动）", async () => {
    await renderOrders();
    rows()[0]!.focus();

    await userEvent.keyboard("{ArrowDown}");

    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]!.text).toContain("第二张订单");
    expect(scrolled[0]!.options).toEqual({ block: "nearest" });
  });

  it("连续移动只在光标变化时滚动，且目标始终是光标那一行", async () => {
    await renderOrders();
    rows()[0]!.focus();

    await userEvent.keyboard("{ArrowDown}{ArrowDown}");

    expect(scrolled.map((item) => item.text)).toEqual([
      expect.stringContaining("第二张订单"),
      expect.stringContaining("第三张订单"),
    ]);
    // 停留不产生额外滚动
    await userEvent.keyboard("{ArrowDown}");
    expect(scrolled).toHaveLength(2);
  });

  it("滚动不会改变右侧详情，也不会改队列", async () => {
    await renderOrders();
    await waitFor(() => expect(getOrder).toHaveBeenCalledTimes(1));
    rows()[0]!.focus();

    await userEvent.keyboard("{ArrowDown}{ArrowDown}");

    expect(getOrder).toHaveBeenCalledTimes(1);
    expect(queueMove).not.toHaveBeenCalled();
  });

  it("搜索把光标所在行过滤掉后，光标被安全清除", async () => {
    await renderOrders();
    rows()[0]!.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(rows()[1]).toHaveClass("order-row-cursor");

    await userEvent.click(screen.getByLabelText("搜索订单"));
    await userEvent.keyboard("第三");

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).not.toHaveClass("order-row-cursor");
  });

  it("模态打开时方向键既不动光标也不滚动", async () => {
    await renderOrders();
    rows()[0]!.focus();
    pushModal("some-modal");

    await userEvent.keyboard("{ArrowDown}");

    expect(scrolled).toHaveLength(0);
    expect(rows()[0]).not.toHaveClass("order-row-cursor");

    popModal("some-modal");
  });
});
