import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientDetail, ClientTag, ClientView } from "../bridge/commands";

const CLIENT_A: ClientView = {
  id: "c-a",
  displayName: "林小满",
  contact: "wx: lin",
  note: "沟通顺畅",
  revision: 3,
  orderCount: 3,
  activeCount: 1,
  completedCount: 1,
  knownAmountCents: 150000,
  lastOrderAt: "2026-11-02T03:04:05.000Z",
  tags: [{ id: "t-long", name: "长期客户", clientCount: 1 }],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const CLIENT_B: ClientView = {
  ...CLIENT_A,
  id: "c-b",
  displayName: "陈叙",
  revision: 0,
  orderCount: 0,
  activeCount: 0,
  completedCount: 0,
  knownAmountCents: 0,
  lastOrderAt: null,
  tags: [],
};

const TAGS: ClientTag[] = [
  { id: "t-long", name: "长期客户", clientCount: 1 },
  { id: "t-biz", name: "商业委托", clientCount: 0 },
];

let clients: ClientView[];
let tags: ClientTag[];

const clientApi = {
  list: vi.fn(async () => clients),
  create: vi.fn(async (input: { displayName: string }) => ({
    ...CLIENT_B,
    id: "c-new",
    displayName: input.displayName,
  })),
  update: vi.fn(async () => ({ ...CLIENT_A, revision: CLIENT_A.revision + 1 })),
  detail: vi.fn(
    async (clientId: string): Promise<ClientDetail> => ({
      client: clients.find((c) => c.id === clientId) ?? CLIENT_A,
      orders: [
        {
          id: "o1",
          code: "AF-2026-0001",
          title: "双人插画",
          status: "active",
          currentStageTitle: "线稿",
          amountCents: 150000,
          createdAt: "2026-11-02T03:04:05.000Z",
        },
      ],
    }),
  ),
};

const clientTagApi = {
  list: vi.fn(async () => tags),
  create: vi.fn(async (name: string) => {
    const tag = { id: `t-${name}`, name, clientCount: 0 };
    tags = [...tags, tag];
    return tag;
  }),
  remove: vi.fn(async (tagId: string) => {
    const used = tags.find((t) => t.id === tagId);
    if (used && used.clientCount > 0) throw new Error("该标签仍被 1 位客户使用");
    tags = tags.filter((t) => t.id !== tagId);
    return null;
  }),
  link: vi.fn(async (clientId: string, tagId: string) => {
    const tag = tags.find((t) => t.id === tagId)!;
    clients = clients.map((c) =>
      c.id === clientId ? { ...c, tags: [...c.tags, tag] } : c,
    );
    return clients.find((c) => c.id === clientId)!.tags;
  }),
  unlink: vi.fn(async (clientId: string, tagId: string) => {
    clients = clients.map((c) =>
      c.id === clientId ? { ...c, tags: c.tags.filter((t) => t.id !== tagId) } : c,
    );
    return clients.find((c) => c.id === clientId)!.tags;
  }),
};

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    financeStatsApi: {
      ...actual.financeStatsApi,
      clientSummary: async () => ({
        clientId: "c0",
        displayName: "客户",
        orders: 0,
        orderAmountCents: 0,
        unknownAmountOrders: 0,
        grossReceivedCents: 0,
        feeTotalCents: 0,
        netReceivedCents: 0,
        refundTotalCents: 0,
        netRetainedCents: 0,
        remainingCents: 0,
        overReceivedCents: 0,
        unrecordedOrders: 0,
      }),
    },

    api: {
      ...actual.api,
      // CUST-02 起客户页要读完整订单来分组，这里给空集合即可。
      listOrders: async () => [],
      status: async () => ({
        appVersion: "0.1.0",
        firstRun: false,
        generation: "gen-test",
        schemaVersion: 5,
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
    clientApi,
    clientTagApi,
  };
});

const { default: ClientsPage } = await import("./ClientsPage");

function renderPage() {
  const router = createMemoryRouter(
    [
      { path: "/clients", element: <ClientsPage /> },
      { path: "/orders", element: <p>订单页</p> },
    ],
    { initialEntries: ["/clients"] },
  );
  return render(<RouterProvider router={router} />);
}

beforeEach(() => {
  clients = [CLIENT_A, CLIENT_B];
  tags = [...TAGS];
  vi.clearAllMocks();
  clientApi.list.mockImplementation(async () => clients);
  clientTagApi.list.mockImplementation(async () => tags);
});

describe("客户页：标签与动态统计", () => {
  it("加载列表与标签筛选下拉，并显示关联订单数", async () => {
    renderPage();
    await waitFor(() => expect(screen.getAllByText("林小满").length).toBeGreaterThan(0));
    expect(screen.getAllByText(/3 单/).length).toBeGreaterThan(0);
    expect(
      screen.getByRole("combobox", { name: "按标签筛选客户" }),
    ).toBeInTheDocument();
  });

  it("展示已知委托金额与最近下单，并说明不含收款事实", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("¥1500")).toBeInTheDocument());
    expect(screen.getByText("2026/11/02")).toBeInTheDocument();
    expect(screen.getByText(/这里没有收款事实/)).toBeInTheDocument();
  });

  it("按标签筛选后只留下带该标签的客户", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getAllByText("林小满").length).toBeGreaterThan(0));

    await user.selectOptions(
      screen.getByRole("combobox", { name: "按标签筛选客户" }),
      "t-long",
    );
    await waitFor(() => expect(screen.queryByText("陈叙")).not.toBeInTheDocument());
    expect(screen.getAllByText("林小满").length).toBeGreaterThan(0);
  });

  it("新建标签会创建并挂到当前客户", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getAllByText("林小满").length).toBeGreaterThan(0));

    await user.type(screen.getByRole("textbox", { name: "新建标签名称" }), "回头客");
    await user.click(screen.getByRole("button", { name: "新建并添加" }));

    await waitFor(() => expect(clientTagApi.create).toHaveBeenCalledWith("回头客"));
    await waitFor(() =>
      expect(clientTagApi.link).toHaveBeenCalledWith("c-a", "t-回头客"),
    );
  });

  it("解除标签调用后端并从界面移除", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getAllByText("林小满").length).toBeGreaterThan(0));

    await user.click(screen.getByRole("button", { name: "移除标签 长期客户" }));
    await waitFor(() =>
      expect(clientTagApi.unlink).toHaveBeenCalledWith("c-a", "t-long"),
    );
  });

  it("删除仍被使用的标签时把错误展示出来，且不禁用删除按钮的说明可见", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getAllByText("林小满").length).toBeGreaterThan(0));

    await user.click(screen.getByText("管理全部标签"));
    // 使用中的标签：按钮禁用并给出原因，而不是让用户点了才失败。
    const deleteBtns = await screen.findAllByRole("button", { name: "删除" });
    const used = deleteBtns.find((b) => b.getAttribute("title") === "仍有客户使用，请先移除关联");
    expect(used).toBeDefined();
    expect(used).toBeDisabled();
    const free = deleteBtns.find((b) => b !== used);
    expect(free).not.toBeDisabled();
  });

  it("关联订单的状态列显示中文，不出现英文枚举", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getAllByText("林小满").length).toBeGreaterThan(0));

    const [row] = screen.getAllByRole("button", { name: /林小满/ });
    if (!row) throw new Error("未找到客户行");
    await user.click(row);
    await waitFor(() => expect(screen.getByText("AF-2026-0001")).toBeInTheDocument());

    // 状态与阶段合并在同一行元信息里，用包含匹配；仍要求中文标签存在、英文枚举不出现。
    expect(screen.getAllByText(/活动/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/\bactive\b/)).toBeNull();
  });

  it("按客户 ID 跳转到订单页", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getAllByText("林小满").length).toBeGreaterThan(0));

    await user.click(screen.getByRole("button", { name: "在订单信息中查看全部" }));
    await waitFor(() => expect(screen.getByText("订单页")).toBeInTheDocument());
  });

  it("标签操作不把客户资料判成脏，也不改动 revision", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getAllByText("林小满").length).toBeGreaterThan(0));

    await user.click(screen.getByRole("button", { name: "移除标签 长期客户" }));
    await waitFor(() => expect(clientTagApi.unlink).toHaveBeenCalled());

    // 没有未保存修改 → 不出现"有未保存修改"提示，保存按钮保持禁用。
    expect(screen.queryByText(/有未保存修改/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存客户资料" })).toBeDisabled();
    expect(clientApi.update).not.toHaveBeenCalled();
  });

  it("加载失败时展示可读错误", async () => {
    clientApi.list.mockRejectedValueOnce(new Error("数据库被锁定"));
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/数据库被锁定/)).toBeInTheDocument(),
    );
  });
});

describe("标签模块的收起与展开", () => {
  it("默认收起：只展示已有标签，编辑器不占位", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("¥1500")).toBeInTheDocument());

    const editor = document.querySelector(".tag-editor");
    expect(editor).not.toBeNull();
    expect(editor?.className).toContain("tag-editor-collapsed");
    expect(screen.getByRole("button", { name: "管理标签" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("展开后原有控件一个不少，再点收起恢复紧凑", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText("¥1500")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "管理标签" }));
    const toggle = screen.getByRole("button", { name: "收起" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("添加已有标签")).toBeInTheDocument();
    expect(screen.getByLabelText("新建标签名称")).toBeInTheDocument();

    await user.click(toggle);
    expect(document.querySelector(".tag-editor")?.className).toContain("tag-editor-collapsed");
  });
});
