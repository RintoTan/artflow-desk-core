import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OrderView, TemplateView } from "../bridge/commands";

const DEFAULT_TPL: TemplateView = {
  id: "tpl-default",
  name: "通用制作流程",
  isDefault: true,
  revision: 0,
  steps: [
    { stepId: "draft", title: "草稿", position: 0 },
    { stepId: "line", title: "线稿", position: 1 },
  ],
  stepCount: 2,
  usageCount: 0,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

const SIMPLE_TPL: TemplateView = {
  ...DEFAULT_TPL,
  id: "tpl-simple",
  name: "单阶段流程",
  isDefault: false,
  steps: [{ stepId: "only", title: "一次完成", position: 0 }],
  stepCount: 1,
};

// 单独的订单夹具：getOrder 不能复用 createOrder 的 mock，
// 否则创建后加载详情会再多算一次 createOrder 调用次数。
const CREATED_ORDER: OrderView = {
  id: "new-order",
  code: "AF-2026-0099",
  title: "新建的委托",
  clientId: null,
  clientName: null,
  commissionType: null,
  stageTemplateId: "tpl-a",
    source: null,
  amountCents: null,
  note: null,
  status: "active" as const,
  workState: "queued" as const,
  currentStageId: "only",
  currentStageTitle: "一次完成",
  currentStageIndex: 0,
  stageCount: 1,
  stages: [{ id: "only", title: "一次完成", position: 0, isCurrent: true }],
  queuePosition: 0,
  plannedStartDate: null,
  plannedDeliveryDate: null,
  deadlineState: "scheduled" as const,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  revision: 0,
  createdAt: "2026-11-17T00:00:00.000Z",
  updatedAt: "2026-11-17T00:00:00.000Z",
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

const createOrder = vi.fn(async (_input?: unknown) => CREATED_ORDER);

// 指向模板列表的可变夹具：空列表分支要求「不传模板 ID，由后端使用默认模板」。
let templateList: TemplateView[] = [DEFAULT_TPL, SIMPLE_TPL];

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    api: {
      listOrders: async () => [],
      listClients: async () => [],
      getOrder: async () => CREATED_ORDER,
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
        orders: 0,
        clients: 0,
        templates: 2,
        attachments: 0,
        pendingCleanup: 0,
        highWater: [],
        integrity: "ok",
      }),
      createOrder,
      updateOrderDetails: vi.fn(),
    },
    queueApi: {
      list: async () => ({ revision: 0, entries: [] }),
      move: async () => ({ revision: 1, entries: [] }),
    },
    preferenceApi: { get: async () => "comfortable", set: async () => null },
    attachmentApi: { list: async () => [] },
    templateApi: { list: async () => templateList },
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
  const newButton = await screen.findByRole("button", { name: "新建" });
  await user.click(newButton);
  await screen.findByText("新建订单");
  return user;
}

describe("新建订单的流程模板", () => {
  beforeEach(() => {
    createOrder.mockClear();
    templateList = [DEFAULT_TPL, SIMPLE_TPL];
  });

  it("默认选中当前默认模板", async () => {
    await openCreateForm();
    const select = screen.getByLabelText("制作流程") as HTMLSelectElement;
    expect(select.value).toBe("tpl-default");
    expect(select.selectedOptions[0]?.textContent).toContain("通用制作流程");
    expect(select.selectedOptions[0]?.textContent).toContain("默认");
  });

  it("可以选择另一个模板，并把模板 ID 传给后端", async () => {
    const user = await openCreateForm();
    await user.type(screen.getByLabelText(/委托标题/), "用单阶段流程建单");
    await user.selectOptions(screen.getByLabelText("制作流程"), "tpl-simple");
    await user.click(screen.getByRole("button", { name: "创建订单" }));

    await waitFor(() => expect(createOrder).toHaveBeenCalledTimes(1));
    const input = createOrder.mock.calls[0]?.[0] as { templateId?: string | null };
    expect(input.templateId).toBe("tpl-simple");
  });

  it("不改动选择时沿用默认模板", async () => {
    const user = await openCreateForm();
    await user.type(screen.getByLabelText(/委托标题/), "用默认流程建单");
    await user.click(screen.getByRole("button", { name: "创建订单" }));

    await waitFor(() => expect(createOrder).toHaveBeenCalledTimes(1));
    const input = createOrder.mock.calls[0]?.[0] as { templateId?: string | null };
    expect(input.templateId).toBe("tpl-default");
  });

  it("模板列表为空时不传模板 ID，交由后端使用默认模板", async () => {
    templateList = [];
    const user = await openCreateForm();
    await user.type(screen.getByLabelText(/委托标题/), "无模板列表时建单");
    await user.click(screen.getByRole("button", { name: "创建订单" }));

    await waitFor(() => expect(createOrder).toHaveBeenCalledTimes(1));
    const input = createOrder.mock.calls[0]?.[0] as { templateId?: string | null };
    expect(input.templateId).toBeNull();
  });

  it("说明文字提示会复制阶段成订单独立流程", async () => {
    await openCreateForm();
    expect(
      screen.getByText(/会把该流程的阶段复制成这张订单的独立流程/),
    ).toBeInTheDocument();
  });
});
