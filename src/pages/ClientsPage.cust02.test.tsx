import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ClientDetail, ClientView, OrderView } from "../bridge/commands";

function client(over: Partial<ClientView> & { id: string; displayName: string }): ClientView {
  return {
    contact: null,
    note: null,
    revision: 1,
    orderCount: 0,
    activeCount: 0,
    completedCount: 0,
    knownAmountCents: 0,
    lastOrderAt: null,
    tags: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

function order(over: Partial<OrderView> & { id: string; code: string }): OrderView {
  return {
    title: "委托",
    clientId: "c-lin",
    clientName: "林小满",
    commissionType: null,
    stageTemplateId: "tpl-a",
    source: null,
    amountCents: 100000,
    note: null,
    status: "active",
    workState: "inProgress",
    currentStageId: "s1",
    currentStageTitle: "线稿",
    currentStageIndex: 0,
    stageCount: 2,
    stages: [],
    queuePosition: 0,
    plannedStartDate: null,
    plannedDeliveryDate: null,
    deadlineState: "scheduled",
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    revision: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    archivedAt: null,
    capabilities: {
      canStartWork: false,
      canUndoStartWork: false,
      undoBlockedReason: null,
      canAdvance: false,
      canRework: false,
      canSkip: false,
      canComplete: false,
      canCancel: false,
      canReopen: false,
      canEditWorkflow: false,
    },
    ...over,
  };
}

const TAG_DESIGN = { id: "t-design", name: "长期合作", clientCount: 2, createdAt: "", updatedAt: "" };

const LIN = client({
  id: "c-lin",
  displayName: "林小满",
  orderCount: 3,
  activeCount: 1,
  completedCount: 2,
  lastOrderAt: "2026-11-20T00:00:00.000Z",
  tags: [TAG_DESIGN],
});
const ZHOU = client({
  id: "c-zhou",
  displayName: "周迟",
  orderCount: 5,
  lastOrderAt: "2026-08-01T00:00:00.000Z",
});
const AHE = client({ id: "c-ahe", displayName: "阿禾", orderCount: 1, lastOrderAt: null });

const ORDERS: OrderView[] = [
  order({ id: "o-a", code: "AF-2026-0001", status: "active", currentStageTitle: "线稿", plannedDeliveryDate: "2026-12-01" }),
  order({
    id: "o-b",
    code: "AF-2026-0002",
    status: "complete",
    workState: "completed",
    completedAt: "2026-10-10T00:00:00.000Z",
    archivedAt: "2026-11-20T00:00:00+08:00",
  }),
  order({
    id: "o-c",
    code: "AF-2026-0003",
    status: "complete",
    workState: "completed",
    completedAt: "2026-09-10T00:00:00.000Z",
  }),
  order({ id: "o-d", code: "AF-2026-0004", status: "cancelled", workState: "cancelled" }),
  order({ id: "o-e", code: "AF-2026-0005", clientId: "c-zhou", clientName: "周迟" }),
];

const listClients = vi.fn(async () => [LIN, ZHOU, AHE]);
const listOrders = vi.fn(async () => ORDERS);

const detailFor = (id: string): ClientDetail => {
  const base = [LIN, ZHOU, AHE].find((c) => c.id === id) ?? LIN;
  return {
    client: base,
    orders: ORDERS.filter((o) => o.clientId === id).map((o) => ({
      id: o.id,
      code: o.code,
      title: o.title,
      status: o.status,
      currentStageTitle: o.currentStageTitle,
      amountCents: o.amountCents,
      createdAt: o.createdAt,
    })),
  };
};

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>("../bridge/commands");
  return {
    ...actual,
    clientApi: {
      list: listClients,
      detail: vi.fn(async (id: string) => detailFor(id)),
      update: vi.fn(),
      create: vi.fn(),
    },
    clientTagApi: {
      list: async () => [TAG_DESIGN],
      create: vi.fn(),
      attach: vi.fn(),
      detach: vi.fn(),
      remove: vi.fn(),
    },
    trashApi: { clientDeleteImpact: vi.fn(), deleteClient: vi.fn() },
    api: {
      ...actual.api,
      listOrders,
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
        orders: 5,
        clients: 3,
        templates: 1,
        attachments: 0,
        pendingCleanup: 0,
        highWater: [],
        integrity: "ok",
      }),
    },
  };
});

async function setup() {
  const { QaRefreshContext } = await import("../lib/qaRefresh");
  const { default: ClientsPage } = await import("./ClientsPage");
  const router = createMemoryRouter(
    [
      { path: "/clients", element: <ClientsPage /> },
      { path: "/orders", element: <p>订单页</p> },
    ],
    { initialEntries: ["/clients"] },
  );
  render(
    <QaRefreshContext.Provider value={() => {}}>
      <RouterProvider router={router} />
    </QaRefreshContext.Provider>,
  );
  await screen.findByRole("button", { name: /林小满/ });
  const listEl = document.querySelector(".orders-list") as HTMLElement;
  const scope = within(listEl) as ReturnType<typeof within> & { rows: () => string[] };
  scope.rows = () =>
    Array.from(listEl.querySelectorAll("button.order-row")).map((b) => b.textContent ?? "");
  return scope;
}

describe("CUST-02 客户搜索", () => {
  it("按名称过滤，清空后恢复全部", async () => {
    const user = userEvent.setup();
    const list = await setup();

    await user.type(screen.getByLabelText("搜索客户名称"), "周");

    expect(list.getByRole("button", { name: /周迟/ })).toBeInTheDocument();
    expect(list.queryByRole("button", { name: /林小满/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: "清空客户搜索" }));
    expect(list.getByRole("button", { name: /林小满/ })).toBeInTheDocument();
  });

  it("搜索与标签筛选同时生效", async () => {
    const user = userEvent.setup();
    const list = await setup();

    await user.selectOptions(screen.getByLabelText("按标签筛选客户"), TAG_DESIGN.id);
    await user.type(screen.getByLabelText("搜索客户名称"), "周");

    // 周迟不带「长期合作」标签：两个条件取交集后为空
    expect(list.queryByRole("button", { name: /周迟/ })).toBeNull();
    expect(list.queryByRole("button", { name: /林小满/ })).toBeNull();
  });

  it("搜不到时给出明确空状态", async () => {
    const user = userEvent.setup();
    await setup();

    await user.type(screen.getByLabelText("搜索客户名称"), "查无此人");
    expect(await screen.findByText(/没有匹配的客户/)).toBeInTheDocument();
  });
});

describe("CUST-02 客户排序", () => {
  it("按订单数量降序", async () => {
    const user = userEvent.setup();
    const list = await setup();

    await user.selectOptions(screen.getByLabelText("客户排序"), "orders");
    const rows = list.rows();
    expect(rows[0]).toContain("周迟");
    expect(rows[rows.length - 1]).toContain("阿禾");
  });

  it("按最近委托时间降序，没有委托的排最后", async () => {
    const user = userEvent.setup();
    const list = await setup();

    await user.selectOptions(screen.getByLabelText("客户排序"), "recent");
    await waitFor(() => {
      const rows = list.rows();
      expect(rows[0]).toContain("林小满");
      expect(rows[rows.length - 1]).toContain("阿禾");
    });
  });
});

describe("CUST-02 客户详情订单分组", () => {
  it("按进行中 / 已完成 / 已取消分组并显示笔数", async () => {
    await setup();
    await screen.findByText("关联订单");

    const groups = Array.from(document.querySelectorAll(".client-order-group"));
    expect(groups).toHaveLength(3);
    expect(groups[0]).toHaveTextContent("进行中");
    expect(groups[0]).toHaveTextContent("1 笔");
    expect(groups[1]).toHaveTextContent("已完成");
    expect(groups[1]).toHaveTextContent("2 笔");
    expect(groups[2]).toHaveTextContent("已取消");
    expect(groups[2]).toHaveTextContent("1 笔");
  });

  it("进行中的订单显示当前阶段与计划交付日期", async () => {
    await setup();
    const group = (await screen.findByText("进行中")).closest(".client-order-group") as HTMLElement;
    expect(group).toHaveTextContent("当前阶段 线稿");
    expect(group).toHaveTextContent("交付 2026-12-01");
  });

  it("已归档的完成订单留在已完成组并标记「已归档」", async () => {
    await setup();
    const group = (await screen.findByText("已完成")).closest(".client-order-group") as HTMLElement;
    expect(within(group).getByText("已归档")).toBeInTheDocument();
    expect(within(group).getByText(/AF-2026-0002/)).toBeInTheDocument();
  });

  it("点击订单进入原有订单详情，而不是另开一套编辑逻辑", async () => {
    const user = userEvent.setup();
    await setup();

    const row = await screen.findByRole("button", { name: /AF-2026-0001/ });
    await user.click(row);
    expect(await screen.findByText("订单页")).toBeInTheDocument();
  });
});
