import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { OrderView } from "../bridge/commands";

const LONG_TITLE =
  "封面主视觉重绘与全彩上色第二版修订稿第三轮细化和背景补画IllustrationWithoutSpaces请勿删改";

const order: OrderView = {
  id: "order-long",
  code: "AF-2026-0042",
  title: LONG_TITLE,
  clientId: null,
  clientName: null,
  commissionType: null,
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
    undoBlockedReason: null,
    canAdvance: false,
    canRework: false,
    canComplete: false,
    canCancel: true,
    canReopen: false,
    canEditWorkflow: true,
  },
};

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
      updateOrderDetails: vi.fn(),
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
    templateApi: { list: async () => [] },
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
  await screen.findByDisplayValue(LONG_TITLE);
}

describe("UI-05 长标题", () => {
  it("列表行标题仍保留完整文本，且不再依赖原生 title 属性", async () => {
    await setup();
    const rowTitle = document.querySelector(".order-row-title");
    expect(rowTitle).not.toBeNull();
    expect(rowTitle?.textContent).toBe(LONG_TITLE);
    // 原生 title 在 line-clamp 盒子里不可靠，已由应用内气泡替代
    expect(rowTitle?.hasAttribute("title")).toBe(false);
  });

  it("详情区继续显示完整标题，不受列表截断影响", async () => {
    await setup();
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(LONG_TITLE),
    );
    expect(screen.getByDisplayValue(LONG_TITLE)).toBeInTheDocument();
  });

  it("订单页根节点带 orders-page 标记，窄屏高度规则只作用于订单页", async () => {
    await setup();
    expect(document.querySelector(".orders-layout.orders-page")).not.toBeNull();
  });
});
