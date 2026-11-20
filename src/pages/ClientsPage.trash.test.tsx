import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientDetail, ClientView } from "../bridge/commands";

const CLIENT: ClientView = {
  id: "c-a",
  displayName: "林小满",
  contact: "wx: lin",
  note: null,
  revision: 3,
  orderCount: 3,
  activeCount: 1,
  completedCount: 1,
  knownAmountCents: 0,
  lastOrderAt: null,
  tags: [],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const detail = (): ClientDetail => ({
  client: CLIENT,
  orders: [
    {
      id: "o1",
      code: "AF-2026-0001",
      title: "双人插画",
      status: "active",
      currentStageTitle: "线稿",
      amountCents: 0,
      createdAt: "2026-11-02T03:04:05.000Z",
    },
  ],
});

const list = vi.fn(async () => [CLIENT]);
const clientDetail = vi.fn(async () => detail());
const clientDeleteImpact = vi.fn(async () => ({
  clientId: "c-a",
  clientName: "林小满",
  orderCount: 3,
  alreadyTrashed: 0,
}));
const deleteClient = vi.fn(async () => ({
  clientId: "c-a",
  deletedAt: "2026-11-21T00:00:00+08:00",
  ordersTrashed: 3,
  ordersAlreadyTrashed: 0,
}));

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    api: {
      ...actual.api,
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
    clientApi: { list, detail: clientDetail },
    clientTagApi: { list: async () => [] },
    trashApi: { clientDeleteImpact, deleteClient },
  };
});

const { default: ClientsPage } = await import("./ClientsPage");

async function setup(refreshQa?: () => void) {
  const { QaRefreshContext } = await import("../lib/qaRefresh");
  const router = createMemoryRouter(
    [
      { path: "/clients", element: <ClientsPage /> },
      { path: "/orders", element: <p>订单页</p> },
    ],
    { initialEntries: ["/clients"] },
  );
  render(
    <QaRefreshContext.Provider value={refreshQa ?? (() => {})}>
      <RouterProvider router={router} />
    </QaRefreshContext.Provider>,
  );
  await userEvent.click(await screen.findByRole("button", { name: /林小满/ }));
  await screen.findByRole("button", { name: "移入回收站…" });
}

beforeEach(() => {
  list.mockClear();
  clientDeleteImpact.mockReset();
  clientDeleteImpact.mockResolvedValue({
    clientId: "c-a",
    clientName: "林小满",
    orderCount: 3,
    alreadyTrashed: 0,
  });
  deleteClient.mockReset();
  deleteClient.mockResolvedValue({
    clientId: "c-a",
    deletedAt: "2026-11-21T00:00:00+08:00",
    ordersTrashed: 3,
    ordersAlreadyTrashed: 0,
  });
});

describe("客户详情里的删除入口", () => {
  it("入口在标签区之后的底部危险操作区", async () => {
    await setup();
    const heading = screen.getByRole("heading", { name: "危险操作" });
    expect(heading.closest("section")).toContainElement(
      screen.getByRole("button", { name: "移入回收站…" }),
    );
  });

  it("影响范围取自服务端；没有已删订单时不显示次级说明", async () => {
    const user = userEvent.setup();
    await setup();

    await user.click(screen.getByRole("button", { name: "移入回收站…" }));
    const dialog = await screen.findByRole("alertdialog");
    await waitFor(() => expect(dialog).toHaveTextContent("3 个关联订单"));

    expect(clientDeleteImpact).toHaveBeenCalledWith("c-a");
    expect(dialog).not.toHaveTextContent("此前已在回收站");
  });

  it("有已删订单时说明它们会被一并归入客户组", async () => {
    const user = userEvent.setup();
    clientDeleteImpact.mockResolvedValueOnce({
      clientId: "c-a",
      clientName: "林小满",
      orderCount: 3,
      alreadyTrashed: 2,
    });
    await setup();

    await user.click(screen.getByRole("button", { name: "移入回收站…" }));
    const dialog = await screen.findByRole("alertdialog");

    expect(await within(dialog).findByText(/其中 2 个订单此前已在回收站/)).toBeInTheDocument();
    expect(dialog).toHaveTextContent("本次将一并归入该客户组");
  });

  it("取消不会调用删除 API", async () => {
    const user = userEvent.setup();
    await setup();

    await user.click(screen.getByRole("button", { name: "移入回收站…" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(deleteClient).not.toHaveBeenCalled();
  });

  it("确认后调用删除、刷新列表并提示包含的订单数", async () => {
    const user = userEvent.setup();
    await setup();
    const callsBefore = list.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "移入回收站…" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "移入回收站" }));

    await waitFor(() => expect(deleteClient).toHaveBeenCalledWith("c-a"));
    expect(await screen.findByText("已移入回收站（含 3 个订单）")).toBeInTheDocument();
    expect(list.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("删除失败时展示错误且不提示成功", async () => {
    const user = userEvent.setup();
    deleteClient.mockRejectedValueOnce(
      Object.assign(new Error("客户正在被引用"), { code: "CONFLICT" }),
    );
    await setup();

    await user.click(screen.getByRole("button", { name: "移入回收站…" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "移入回收站" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("客户正在被引用");
    expect(screen.queryByText(/已移入回收站（含/)).not.toBeInTheDocument();
  });

  it("删除成功但列表刷新失败时，仍提示成功并给出页面级错误", async () => {
    const user = userEvent.setup();
    await setup();
    list.mockRejectedValueOnce(new Error("列表读取失败"));

    await user.click(screen.getByRole("button", { name: "移入回收站…" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "移入回收站" }));

    expect(await screen.findByText("已移入回收站（含 3 个订单）")).toBeInTheDocument();
    expect(await screen.findByText(/列表读取失败/)).toBeInTheDocument();
    // 确认框已经关闭，错误不再写回对话框。
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
