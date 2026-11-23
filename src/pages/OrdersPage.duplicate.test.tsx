import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 附件面板会把相对路径换成 asset URL；jsdom 里没有 Tauri 运行时，直接原样返回。
vi.mock("@tauri-apps/api/core", async () => {
  const actual = await vi.importActual<typeof import("@tauri-apps/api/core")>(
    "@tauri-apps/api/core",
  );
  return { ...actual, convertFileSrc: (path: string) => path };
});

import type { AttachmentView, OrderView } from "../bridge/commands";

function order(overrides: Partial<OrderView> = {}): OrderView {
  return {
    id: "o1",
    code: "AF-2026-0001",
    title: "半身立绘",
    clientId: "c1",
    clientName: "林小满",
    commissionType: "半身立绘",
    stageTemplateId: "tpl-a",
    source: "画加",
    amountCents: 80000,
    note: "背景要夜空",
    status: "active",
    workState: "inProgress",
    currentStageId: "color",
    currentStageTitle: "固有色",
    currentStageIndex: 2,
    stageCount: 5,
    stages: [
      { id: "draft", title: "草稿", position: 0, isCurrent: false },
      { id: "line", title: "线稿", position: 1, isCurrent: false },
      { id: "color", title: "固有色", position: 2, isCurrent: true },
      { id: "detail", title: "细化", position: 3, isCurrent: false },
      { id: "final", title: "完稿", position: 4, isCurrent: false },
    ],
    queuePosition: 0,
    plannedStartDate: "2026-11-10",
    plannedDeliveryDate: "2026-11-20",
    deadlineState: "scheduled",
    startedAt: "2026-11-10T00:00:00.000Z",
    completedAt: null,
    cancelledAt: null,
    revision: 2,
    createdAt: "2026-11-09T00:00:00.000Z",
    updatedAt: "2026-11-12T00:00:00.000Z",
    archivedAt: null,
    capabilities: {
      canStartWork: false,
      canUndoStartWork: true,
      undoBlockedReason: null,
      canAdvance: true,
      canRework: true,
      canSkip: true,
      canComplete: false,
      canCancel: true,
      canReopen: false,
      canEditWorkflow: true,
    },
    ...overrides,
  };
}

function attachment(id: string): AttachmentView {
  return {
    id,
    orderId: "o1",
    originalName: `${id}.png`,
    displayName: null,
    note: null,
    tag: "reference",
    role: "reference",
    galleryVisible: false,
    mimeType: "image/png",
    byteSize: 1024,
    sha256: "a".repeat(64),
    width: 40,
    height: 30,
    state: "ok",
    createdAt: "2026-11-09T00:00:00.000Z",
    originalPath: `/tmp/${id}.png`,
    thumbPath: `/tmp/${id}.thumb.webp`,
    fileExists: true,
    thumbExists: true,
  } as unknown as AttachmentView;
}

const SOURCE = order();
const COPY = order({
  id: "o2",
  code: "AF-2026-0002",
  currentStageId: "draft",
  currentStageTitle: "草稿",
  currentStageIndex: 0,
  workState: "queued",
  startedAt: null,
  plannedStartDate: null,
  plannedDeliveryDate: null,
  revision: 0,
  queuePosition: 1,
});

const listOrders = vi.fn(async () => [SOURCE]);
const getOrder = vi.fn(async (id: string) => (id === COPY.id ? COPY : SOURCE));
const createOrder = vi.fn();
const duplicateOrder = vi.fn(async (_input: Record<string, unknown>) => COPY);
const listAttachments = vi.fn(async () => [attachment("a1"), attachment("a2")]);
const updateOrderDetails = vi.fn();

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    api: {
      listOrders,
      listClients: async () => [
        {
          id: "c1",
          displayName: "林小满",
          contact: null,
          note: null,
          revision: 0,
          orderCount: 1,
          activeCount: 1,
          completedCount: 0,
          knownAmountCents: 80000,
          lastOrderAt: null,
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
          tags: [],
        },
      ],
      getOrder,
      listOrderEvents: async () => [],
      status: async () => ({
        appVersion: "0.1.0",
        firstRun: false,
        generation: "gen-test",
        schemaVersion: 9,
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
        attachments: 2,
        pendingCleanup: 0,
        highWater: [],
        integrity: "ok",
      }),
      updateOrderDetails,
      createOrder,
      duplicateOrder,
    },
    templateApi: {
      list: async () => [
        {
          id: "tpl-a",
          name: "默认流程",
          isDefault: true,
          revision: 1,
          steps: [],
          stepCount: 5,
          usageCount: 1,
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
        },
      ],
    },
    queueApi: {
      list: async () => ({ revision: 0, entries: [] }),
      move: async () => ({ revision: 1, entries: [] }),
    },
    preferenceApi: { get: async () => "comfortable", set: async () => null },
    attachmentApi: { list: listAttachments },
    statsApi: { exportOrders: vi.fn() },
    trashApi: { deleteOrder: vi.fn() },
  };
});

async function setup() {
  const { QaRefreshContext } = await import("../lib/qaRefresh");
  const { default: OrdersPage } = await import("./OrdersPage");
  const router = createMemoryRouter([{ path: "/orders", element: <OrdersPage /> }], {
    initialEntries: ["/orders"],
  });
  render(
    <QaRefreshContext.Provider value={() => {}}>
      <RouterProvider router={router} />
    </QaRefreshContext.Provider>,
  );
  await screen.findAllByText(/张 ·/);
  const detailEl = document.querySelector(".orders-detail");
  if (!detailEl) throw new Error("找不到订单详情");
  return { detail: within(detailEl as HTMLElement) };
}

beforeEach(() => {
  duplicateOrder.mockClear();
  createOrder.mockClear();
  getOrder.mockClear();
});

describe("ORDER-01 复制订单", () => {
  it("详情里有「复制订单」，点了打开预填好的表单而不是直接建单", async () => {
    const user = userEvent.setup();
    const { detail } = await setup();

    await user.click(detail.getByRole("button", { name: "复制订单" }));

    // 没有静默创建
    expect(duplicateOrder).not.toHaveBeenCalled();
    expect(createOrder).not.toHaveBeenCalled();

    expect(await screen.findByRole("heading", { name: "复制订单" })).toBeTruthy();
    expect(screen.getByText(/从 AF-2026-0001 复制资料/)).toBeTruthy();
    expect(screen.getByLabelText(/委托标题/)).toHaveValue("半身立绘");
    expect(screen.getByLabelText(/委托金额/)).toHaveValue("800");
    expect(screen.getByLabelText(/委托说明/)).toHaveValue("背景要夜空");
    expect(screen.getByLabelText(/委托类型/)).toHaveValue("半身立绘");
  });

  it("计划日期清空，流程沿用原订单快照", async () => {
    const user = userEvent.setup();
    const { detail } = await setup();
    await user.click(detail.getByRole("button", { name: "复制订单" }));

    await screen.findByRole("heading", { name: "复制订单" });
    expect(screen.getByLabelText("预计开始日期")).toHaveValue("");
    expect(screen.getByLabelText("预计交付日期")).toHaveValue("");
    expect(screen.getByTestId("copy-flow-note").textContent).toContain("5 个阶段");
    // 复制模式不再提供模板下拉
    expect(document.querySelector("#create-order-template")).toBeNull();
  });

  it("附件默认勾选并显示张数，保存时带 copyAttachments", async () => {
    const user = userEvent.setup();
    const { detail } = await setup();
    await user.click(detail.getByRole("button", { name: "复制订单" }));

    const checkbox = (await screen.findByLabelText(/同时复制附件/)) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(screen.getByText(/2 张/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "创建订单" }));

    await waitFor(() => expect(duplicateOrder).toHaveBeenCalledTimes(1));
    const payload = duplicateOrder.mock.calls[0]![0] as {
      sourceOrderId?: string;
      title?: string;
      clientId?: string | null;
      copyAttachments?: boolean;
      plannedStartDate?: string | null;
    };
    expect(payload.sourceOrderId).toBe("o1");
    expect(payload.title).toBe("半身立绘");
    expect(payload.clientId).toBe("c1");
    expect(payload.copyAttachments).toBe(true);
    // 复制不继承旧排期
    expect(payload.plannedStartDate ?? null).toBeNull();
  });

  it("取消勾选后仍可保存，只是不复制附件", async () => {
    const user = userEvent.setup();
    const { detail } = await setup();
    await user.click(detail.getByRole("button", { name: "复制订单" }));

    const checkbox = (await screen.findByLabelText(/同时复制附件/)) as HTMLInputElement;
    await user.click(checkbox);
    expect(checkbox.checked).toBe(false);

    await user.click(screen.getByRole("button", { name: "创建订单" }));
    await waitFor(() => expect(duplicateOrder).toHaveBeenCalledTimes(1));
    expect(duplicateOrder.mock.calls[0]![0].copyAttachments).toBe(false);
  });

  it("保存成功后进入新订单详情", async () => {
    const user = userEvent.setup();
    const { detail } = await setup();
    await user.click(detail.getByRole("button", { name: "复制订单" }));
    await user.click(await screen.findByRole("button", { name: "创建订单" }));

    await waitFor(() => expect(getOrder).toHaveBeenCalledWith("o2"));
    expect(await detail.findByText("AF-2026-0002")).toBeTruthy();
  });

  it("有未保存修改时先拦下，不直接开复制表单", async () => {
    const user = userEvent.setup();
    const { detail } = await setup();

    // 改一下标题，制造脏状态
    const titleInput = detail.getByLabelText(/委托标题/) as HTMLInputElement;
    await user.clear(titleInput);
    await user.type(titleInput, "改了一半");

    await user.click(detail.getByRole("button", { name: "复制订单" }));

    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "复制订单" })).toBeNull();
    expect(duplicateOrder).not.toHaveBeenCalled();
  });
});
