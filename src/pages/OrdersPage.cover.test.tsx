import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { OrderCover, OrderView, TemplateView } from "../bridge/commands";

const ORDER: OrderView = {
  id: "o-1",
  code: "AF-2026-0001",
  title: "林三 · 插画",
  clientId: "c-1",
  clientName: "林三",
  commissionType: "插画",
  stageTemplateId: "tpl-1",
  source: null,
  amountCents: 50000,
  note: null,
  status: "active",
  workState: "queued",
  currentStageId: "draft",
  currentStageTitle: "草稿",
  currentStageIndex: 0,
  stageCount: 1,
  stages: [{ id: "draft", title: "草稿", position: 0, isCurrent: true }],
  queuePosition: 0,
  plannedStartDate: null,
  plannedDeliveryDate: null,
  deadlineState: "unscheduled",
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  revision: 0,
  createdAt: "2026-11-26T00:00:00.000Z",
  updatedAt: "2026-11-26T00:00:00.000Z",
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
} as OrderView;

const TEMPLATE: TemplateView = {
  id: "tpl-1",
  name: "通用制作流程",
  isDefault: true,
  revision: 0,
  steps: [{ stepId: "draft", title: "草稿", position: 0 }],
  stepCount: 1,
  usageCount: 0,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

const COVER: OrderCover = {
  orderId: "o-1",
  attachmentId: "a-1",
  role: "final",
  thumbPath: "/gen/thumbs/a-1.webp",
  originalPath: "/gen/a-1.png",
  mimeType: "image/png",
};

const covers = vi.fn(async (_ids: string[]) => [COVER]);

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>("../bridge/commands");
  return {
    ...actual,
    api: {
      listOrders: async () => [ORDER],
      listClients: async () => [],
      getOrder: async () => ORDER,
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
        orders: 1,
        clients: 1,
        templates: 1,
        attachments: 1,
        pendingCleanup: 0,
        highWater: [],
        integrity: "ok",
      }),
      updateOrderDetails: vi.fn(),
    },
    queueApi: { list: async () => ({ revision: 0, entries: [] }), move: async () => ({ revision: 1, entries: [] }) },
    preferenceApi: { get: async () => "comfortable", set: async () => null },
    attachmentApi: { list: async () => [], covers },
    templateApi: { list: async () => [TEMPLATE] },
    statsApi: { exportOrders: vi.fn() },
  };
});

async function open() {
  const { default: OrdersPage } = await import("./OrdersPage");
  const router = createMemoryRouter([{ path: "/orders", element: <OrdersPage /> }], {
    initialEntries: ["/orders"],
  });
  render(<RouterProvider router={router} />);
  return userEvent.setup();
}

describe("订单列表的封面", () => {
  it("卡片视图按订单批量取封面并显示缩略图", async () => {
    await open();
    // 标题在列表与详情里各出现一次
    await screen.findAllByText("林三 · 插画");

    await waitFor(() => expect(covers).toHaveBeenCalled());
    // 一次请求把当前列表的 id 全带上，不是每张卡片各发一次
    expect(covers.mock.calls[0]?.[0]).toEqual(["o-1"]);

    // 缩略图是装饰图（alt 为空），所以按元素找而不是按角色找
    const thumb = document.querySelector(".order-thumb img") as HTMLImageElement | null;
    expect(thumb).not.toBeNull();
    expect(thumb!.getAttribute("src")).toBe(
      `asset://localhost/${encodeURIComponent("/gen/thumbs/a-1.webp")}`,
    );
  });

  it("表格视图不显示缩略图", async () => {
    const user = await open();
    // 标题在列表与详情里各出现一次
    await screen.findAllByText("林三 · 插画");
    await user.click(screen.getByRole("button", { name: "表格" }));

    await waitFor(() => expect(document.querySelector("table")).not.toBeNull());
    expect(document.querySelector(".order-thumb")).toBeNull();
  });

  it("没有封面的订单显示占位块", async () => {
    covers.mockResolvedValueOnce([]);
    await open();
    // 标题在列表与详情里各出现一次
    await screen.findAllByText("林三 · 插画");
    await waitFor(() => expect(document.querySelector(".order-thumb-empty")).not.toBeNull());
  });
});
