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

/** 与 QA 里的 AF-2025-0502 同形：委托类型与备注为空、有排期、没有附件。 */
const BARE = order({
  id: "o3",
  code: "AF-2025-0502",
  title: "封面 03-1",
  clientId: "c1",
  clientName: "林小满",
  commissionType: null,
  source: "米画师",
  amountCents: 60000,
  note: null,
  plannedStartDate: "2026-09-26",
  plannedDeliveryDate: "2026-11-30",
});

let orders: OrderView[] = [SOURCE];
const listOrders = vi.fn(async () => orders);
const getOrder = vi.fn(
  async (id: string) => orders.find((o) => o.id === id) ?? (id === COPY.id ? COPY : SOURCE),
);
const createOrder = vi.fn();
const duplicateOrder = vi.fn(async (_input: Record<string, unknown>) => COPY);
let attachmentCount = 2;
const listAttachments = vi.fn(async () =>
  Array.from({ length: attachmentCount }, (_, i) => attachment(`a${i + 1}`)),
);
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
  orders = [SOURCE];
  attachmentCount = 2;
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
    const start = screen.getByLabelText("预计开始日期") as HTMLInputElement;
    const end = screen.getByLabelText("预计交付日期") as HTMLInputElement;
    expect(start.value).toBe("");
    expect(end.value).toBe("");
    // 原生日期控件的占位格式不能当成"已填值"，用一句话说清
    expect(screen.getByTestId("copy-dates-note").textContent).toContain("都是空的");
    expect(screen.getByTestId("copy-flow-note").textContent).toContain("5 个阶段");
    // 复制模式不再提供模板下拉
    expect(document.querySelector("#create-order-template")).toBeNull();
  });

  it("附件默认勾选并显示张数，保存时带 copyAttachments", async () => {
    const user = userEvent.setup();
    const { detail } = await setup();
    await user.click(detail.getByRole("button", { name: "复制订单" }));

    const block = (await screen.findByTestId("copy-attachments")) as HTMLElement;
    const checkbox = within(block).getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(block.textContent).toContain("同时复制 2 张附件");
    // 复选框与文字必须在同一个选项行里，不能各占一列
    // 整块是表单里的一行，但**不是** .field——.field 的 input 规则会把复选框撑满一行
    expect(block.classList.contains("field-wide")).toBe(true);
    expect(block.classList.contains("field")).toBe(false);
    expect(block.parentElement?.classList.contains("form-grid")).toBe(true);
    const option = block.querySelector(".copy-attachment-option") as HTMLElement;
    expect(option.contains(checkbox)).toBe(true);
    expect(option.textContent).toContain("同时复制 2 张附件");
    // 说明文字与选项行是兄弟，都在同一个块里
    expect(block.querySelectorAll(":scope > .copy-attachment-option").length).toBe(1);
    expect(block.querySelectorAll(":scope > .hint").length).toBe(1);

    await user.click(screen.getByRole("button", { name: "创建副本" }));

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

    const checkbox = (await screen.findByRole("checkbox")) as HTMLInputElement;
    await user.click(checkbox);
    expect(checkbox.checked).toBe(false);

    await user.click(screen.getByRole("button", { name: "创建副本" }));
    await waitFor(() => expect(duplicateOrder).toHaveBeenCalledTimes(1));
    expect(duplicateOrder.mock.calls[0]![0].copyAttachments).toBe(false);
  });

  it("保存成功后进入新订单详情", async () => {
    const user = userEvent.setup();
    const { detail } = await setup();
    await user.click(detail.getByRole("button", { name: "复制订单" }));
    await user.click(await screen.findByRole("button", { name: "创建副本" }));

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

  it("来源没有附件：不显示复选框，只留一行中性提示", async () => {
    orders = [BARE];
    attachmentCount = 0;
    const user = userEvent.setup();
    const { detail } = await setup();

    await user.click(detail.getByRole("button", { name: "复制订单" }));
    const block = (await screen.findByTestId("copy-attachments")) as HTMLElement;

    expect(within(block).queryByRole("checkbox")).toBeNull();
    expect(block.querySelector(".copy-attachment-option")).toBeNull();
    expect(block.querySelector(".copy-attachment-empty")?.textContent).toContain(
      "来源订单没有附件",
    );
    // 没有附件就不该再留一条说明，避免占位空白
    expect(block.querySelector(".hint")).toBeNull();
    expect(block.textContent?.trim()).toBe("来源订单没有附件，无需复制");
  });

  it("来源字段为空就保持为空，不擅自补值", async () => {
    orders = [BARE];
    attachmentCount = 0;
    const user = userEvent.setup();
    const { detail } = await setup();

    await user.click(detail.getByRole("button", { name: "复制订单" }));
    await screen.findByRole("heading", { name: "复制订单" });

    expect(screen.getByLabelText(/委托类型/)).toHaveValue("");
    expect(screen.getByLabelText(/委托说明/)).toHaveValue("");
    expect(screen.getByLabelText(/^来源/)).toHaveValue("米画师");
    expect(screen.getByLabelText(/委托金额/)).toHaveValue("600");
    expect((screen.getByLabelText("已有客户") as HTMLSelectElement).value).toBe("c1");

    await user.click(screen.getByRole("button", { name: "创建副本" }));
    await waitFor(() => expect(duplicateOrder).toHaveBeenCalledTimes(1));
    const payload = duplicateOrder.mock.calls[0]![0] as {
      commissionType?: string | null;
      note?: string | null;
      source?: string | null;
      amountCents?: number | null;
      copyAttachments?: boolean;
    };
    expect(payload.commissionType).toBeNull();
    expect(payload.note).toBeNull();
    expect(payload.source).toBe("米画师");
    expect(payload.amountCents).toBe(60000);
    // 来源没有附件，勾选不成立
    expect(payload.copyAttachments).toBe(false);
  });

  it("普通新建面板不受复制模式影响", async () => {
    const user = userEvent.setup();
    await setup();

    await user.click(screen.getByRole("button", { name: "新建" }));

    expect(await screen.findByRole("heading", { name: "新建订单" })).toBeTruthy();
    expect(screen.queryByTestId("copy-attachments")).toBeNull();
    expect(screen.queryByTestId("copy-dates-note")).toBeNull();
    expect(screen.getByRole("button", { name: "创建订单" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "创建副本" })).toBeNull();
    // 普通新建仍然可以选模板
    expect(document.querySelector("#create-order-template")).not.toBeNull();
  });
});
