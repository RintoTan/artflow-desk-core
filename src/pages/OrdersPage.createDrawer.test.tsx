import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OrderView } from "../bridge/commands";

function stages(titles: string[], current: number) {
  return titles.map((title, i) => ({
    id: `s-${title}`,
    title,
    position: i,
    isCurrent: i === current,
  }));
}

const ORDER: OrderView = {
  id: "o1",
  code: "AF-2026-0001",
  title: "双人插画",
  clientId: "c1",
  clientName: "林小满",
  commissionType: null,
  stageTemplateId: "tpl-a",
  source: "米画师",
  amountCents: 88000,
  note: null,
  status: "active",
  workState: "inProgress",
  currentStageId: "s-草稿",
  currentStageTitle: "草稿",
  currentStageIndex: 0,
  stageCount: 2,
  stages: stages(["草稿", "线稿"], 0),
  queuePosition: 0,
  plannedStartDate: null,
  plannedDeliveryDate: "2026-11-20",
  deadlineState: "scheduled",
  startedAt: "2026-11-01T00:00:00Z",
  completedAt: null,
  cancelledAt: null,
  revision: 1,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  capabilities: {
    canStartWork: false,
    canUndoStartWork: false,
    undoBlockedReason: null,
    canAdvance: true,
    canRework: true,
    canSkip: false,
    canComplete: false,
    canCancel: true,
    canReopen: false,
    canEditWorkflow: true,
  },
};

let stored: Record<string, string | null>;

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    preferenceApi: {
      get: async (key: string) => (key in stored ? (stored[key] ?? null) : null),
      set: async (key: string, value: string) => {
        stored[key] = value;
        return null;
      },
    },
    api: {
      ...actual.api,
      listOrders: async () => [ORDER],
      listClients: async () => [],
      listOrderEvents: async () => [],
      getOrder: async () => ORDER,
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
        qaScenario: null,
      }),
    },
    templateApi: { ...actual.templateApi, list: async () => [] },
    queueApi: { ...actual.queueApi, list: async () => ({ revision: 0, items: [] }) },
  };
});

const { default: OrdersPage } = await import("./OrdersPage");

function renderPage() {
  const router = createMemoryRouter([{ path: "/orders", element: <OrdersPage /> }], {
    initialEntries: ["/orders"],
  });
  return render(<RouterProvider router={router} />);
}

function detailPane(): HTMLElement {
  const pane = document.querySelector(".orders-detail");
  if (!(pane instanceof HTMLElement)) throw new Error("找不到 .orders-detail");
  return pane;
}

/** 看板/表格的详情抽屉是否可见（等价于没有 is-hidden）。 */
function paneVisible(): boolean {
  return !detailPane().classList.contains("is-hidden");
}

async function renderInView(viewMode: "cards" | "board" | "table") {
  stored = { orders_view_mode: viewMode };
  renderPage();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: viewName(viewMode) })).toHaveAttribute(
      "aria-pressed",
      "true",
    ),
  );
  await screen.findByRole("button", { name: "新建" });
}

function viewName(viewMode: "cards" | "board" | "table"): string {
  return viewMode === "cards" ? "卡片" : viewMode === "board" ? "看板" : "表格";
}

beforeEach(() => {
  stored = {};
});

describe("看板/表格下新建订单的抽屉行为（D-06）", () => {
  it("看板 + 抽屉关闭 + 点新建：表单可见，且不显示「订单详情」标题栏", async () => {
    const user = userEvent.setup();
    await renderInView("board");
    expect(paneVisible()).toBe(false);

    await user.click(screen.getByRole("button", { name: "新建" }));

    await screen.findByText("新建订单");
    expect(paneVisible()).toBe(true);
    // 标题与内容不符的旧标题栏必须让位给新建表单自己的标题。
    expect(screen.queryByText("订单详情")).toBeNull();
  });

  it("表格视图同样能打开新建表单", async () => {
    const user = userEvent.setup();
    await renderInView("table");

    await user.click(screen.getByRole("button", { name: "新建" }));

    await screen.findByText("新建订单");
    expect(paneVisible()).toBe(true);
    expect(screen.queryByText("订单详情")).toBeNull();
  });

  it("新建前抽屉关闭：取消后恢复关闭，不停留在新建态", async () => {
    const user = userEvent.setup();
    await renderInView("board");

    await user.click(screen.getByRole("button", { name: "新建" }));
    await screen.findByText("新建订单");
    await user.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() => expect(screen.queryByText("新建订单")).toBeNull());
    expect(paneVisible()).toBe(false);
  });

  it("新建前抽屉已打开：取消后恢复原来的订单详情", async () => {
    const user = userEvent.setup();
    await renderInView("board");

    // 先点开订单，让抽屉显示详情。
    await user.click(screen.getByRole("button", { name: "打开 AF-2026-0001 双人插画" }));
    await screen.findByText("订单详情");

    await user.click(screen.getByRole("button", { name: "新建" }));
    await screen.findByText("新建订单");
    expect(screen.queryByText("订单详情")).toBeNull();

    await user.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() => expect(screen.queryByText("新建订单")).toBeNull());
    expect(paneVisible()).toBe(true);
    // 详情回来了：标题栏与详情里的操作入口都在，不是空面板。
    expect(screen.getByText("订单详情")).toBeTruthy();
    expect(screen.getByRole("button", { name: "保存资料" })).toBeTruthy();
  });

  it("新建态按 Esc 退出新建，并恢复新建前的抽屉状态", async () => {
    const user = userEvent.setup();
    await renderInView("board");

    await user.click(screen.getByRole("button", { name: "新建" }));
    await screen.findByText("新建订单");

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByText("新建订单")).toBeNull());
    expect(paneVisible()).toBe(false);
  });

  it("新建前抽屉已打开：Esc 退出新建后恢复原订单详情", async () => {
    const user = userEvent.setup();
    await renderInView("board");

    // 先打开订单详情，记录当前详情内容，用于 Esc 之后逐项比对。
    await user.click(screen.getByRole("button", { name: "打开 AF-2026-0001 双人插画" }));
    await screen.findByText("订单详情");
    const titleBefore = (await screen.findByLabelText(/委托标题/)) as HTMLInputElement;
    expect(titleBefore.value).toBe("双人插画");

    await user.click(screen.getByRole("button", { name: "新建" }));
    await screen.findByText("新建订单");
    // 新建态：抽屉仍然打开，但标题栏让位给新建表单自己的标题。
    expect(paneVisible()).toBe(true);
    expect(screen.queryByText("订单详情")).toBeNull();

    await user.keyboard("{Escape}");

    // 退出新建：抽屉保持打开，标题栏与原先那张订单的详情都要回来。
    await waitFor(() => expect(screen.queryByText("新建订单")).toBeNull());
    expect(paneVisible()).toBe(true);
    expect(screen.getByText("订单详情")).toBeTruthy();
    const titleAfter = screen.getByLabelText(/委托标题/) as HTMLInputElement;
    expect(titleAfter.value).toBe("双人插画");
    expect(screen.getByRole("button", { name: "保存资料" })).toBeTruthy();
  });

  it("有未保存修改时仍先弹守卫对话框，不直接进入新建", async () => {
    const user = userEvent.setup();
    await renderInView("board");

    await user.click(screen.getByRole("button", { name: "打开 AF-2026-0001 双人插画" }));
    const title = await screen.findByLabelText(/委托标题/);
    await user.type(title, "改一下");
    await user.click(screen.getByRole("button", { name: "新建" }));

    await screen.findByText(/尚未保存的资料修改将丢失/);
    expect(screen.queryByText("新建订单")).toBeNull();
  });
});

describe("卡片视图的新建行为保持不变", () => {
  it("详情区常驻，点新建直接出现表单，取消后回到空态", async () => {
    const user = userEvent.setup();
    await renderInView("cards");
    expect(document.querySelector(".orders-detail-drawer")).toBeNull();

    await user.click(screen.getByRole("button", { name: "新建" }));
    await screen.findByText("新建订单");

    await user.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByText("新建订单")).toBeNull());
    expect(document.querySelector(".orders-detail-drawer")).toBeNull();
    expect(paneVisible()).toBe(true);
  });
});
