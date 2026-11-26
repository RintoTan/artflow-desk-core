import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ClientView, OrderView, TemplateView } from "../bridge/commands";

const CLIENT: ClientView = {
  id: "c-1",
  displayName: "林三",
  contact: null,
  note: null,
  revision: 0,
  orderCount: 0,
  activeCount: 0,
  completedCount: 0,
  knownAmountCents: 0,
  lastOrderAt: null,
  tags: [],
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
} as ClientView;

const TEMPLATE: TemplateView = {
  id: "tpl-default",
  name: "通用制作流程",
  isDefault: true,
  revision: 0,
  steps: [{ stepId: "draft", title: "草稿", position: 0 }],
  stepCount: 1,
  usageCount: 0,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

const CREATED: OrderView = {
  id: "new-order",
  code: "AF-2026-0100",
  title: "林三 · 插画",
  clientId: "c-1",
  clientName: "林三",
  commissionType: "插画",
  stageTemplateId: "tpl-default",
  source: null,
  amountCents: null,
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
  deadlineState: "scheduled",
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

const createOrder = vi.fn(async (_input?: unknown) => CREATED);

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>("../bridge/commands");
  return {
    ...actual,
    api: {
      listOrders: async () => [],
      listClients: async () => [CLIENT],
      getOrder: async () => CREATED,
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
        orders: 0,
        clients: 1,
        templates: 1,
        attachments: 0,
        pendingCleanup: 0,
        highWater: [],
        integrity: "ok",
      }),
      createOrder,
      updateOrderDetails: vi.fn(),
    },
    queueApi: { list: async () => ({ revision: 0, entries: [] }), move: async () => ({ revision: 1, entries: [] }) },
    preferenceApi: { get: async () => "comfortable", set: async () => null },
    attachmentApi: { list: async () => [] },
    templateApi: { list: async () => [TEMPLATE] },
    statsApi: { exportOrders: vi.fn() },
  };
});

async function openCreateForm() {
  const { default: OrdersPage } = await import("./OrdersPage");
  const router = createMemoryRouter([{ path: "/orders", element: <OrdersPage /> }], {
    initialEntries: ["/orders"],
  });
  render(<RouterProvider router={router} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "新建" }));
  await screen.findByRole("heading", { name: "新建订单" });
  return user;
}

function titleInput() {
  return screen.getByLabelText(/委托标题/) as HTMLInputElement;
}

describe("委托类型与标题联动", () => {
  it("选客户 + 点预设类型，标题自动生成并随类型变化", async () => {
    const user = await openCreateForm();
    await user.click(screen.getByRole("combobox", { name: "客户" }));
    await user.click(await screen.findByRole("option", { name: "林三" }));
    const types = screen.getByRole("group", { name: "高频类型" });

    await user.click(within(types).getByRole("button", { name: "插画" }));
    expect(titleInput().value).toBe("林三 · 插画");
    expect(screen.getByLabelText("委托类型")).toHaveValue("插画");

    await user.click(within(types).getByRole("button", { name: "头像" }));
    expect(titleInput().value).toBe("林三 · 头像");
  });

  it("手改过标题之后，再换类型不覆盖用户的写法", async () => {
    const user = await openCreateForm();
    await user.click(screen.getByRole("combobox", { name: "客户" }));
    await user.click(await screen.findByRole("option", { name: "林三" }));
    const types = screen.getByRole("group", { name: "高频类型" });

    await user.click(within(types).getByRole("button", { name: "插画" }));
    await user.clear(titleInput());
    await user.type(titleInput(), "林三的加急稿");

    await user.click(within(types).getByRole("button", { name: "摸鱼" }));
    expect(titleInput().value).toBe("林三的加急稿");
    expect(screen.getByLabelText("委托类型")).toHaveValue("摸鱼");
  });

  it("自定义类型照样能提交", async () => {
    const user = await openCreateForm();
    await user.click(screen.getByRole("combobox", { name: "客户" }));
    await user.click(await screen.findByRole("option", { name: "林三" }));
    await user.type(screen.getByLabelText("委托类型"), "半身立绘");
    expect(titleInput().value).toBe("林三 · 半身立绘");

    await user.click(screen.getByRole("button", { name: "创建订单" }));
    await screen.findByRole("heading", { name: "新建订单" }).catch(() => null);
    expect(createOrder).toHaveBeenCalledTimes(1);
    const input = createOrder.mock.calls[0]?.[0] as { commissionType?: string | null; title?: string };
    expect(input.commissionType).toBe("半身立绘");
    expect(input.title).toBe("林三 · 半身立绘");
  });
});
