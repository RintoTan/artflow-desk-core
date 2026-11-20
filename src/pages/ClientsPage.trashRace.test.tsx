import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientDetail, ClientView } from "../bridge/commands";

function client(id: string, name: string): ClientView {
  return {
    id,
    displayName: name,
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
  };
}

const CLIENT_A = client("c-a", "甲客户");
const CLIENT_B = client("c-b", "乙客户");

function detailOf(view: ClientView): ClientDetail {
  return { client: view, orders: [] };
}

const list = vi.fn(async () => [CLIENT_A, CLIENT_B]);
const clientDetail = vi.fn(async (id: string) =>
  detailOf(id === "c-b" ? CLIENT_B : CLIENT_A),
);
const clientDeleteImpact = vi.fn();
const deleteClient = vi.fn(async (id: string) => ({
  clientId: id,
  deletedAt: "2026-11-21T00:00:00+08:00",
  ordersTrashed: 5,
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

async function renderPage() {
  const router = createMemoryRouter([{ path: "/clients", element: <ClientsPage /> }], {
    initialEntries: ["/clients"],
  });
  render(<RouterProvider router={router} />);
  await screen.findByRole("button", { name: /甲客户/ });
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue([CLIENT_A, CLIENT_B]);
  clientDetail.mockImplementation(async (id: string) =>
    detailOf(id === "c-b" ? CLIENT_B : CLIENT_A),
  );
  deleteClient.mockResolvedValue({
    clientId: "c-b",
    deletedAt: "2026-11-21T00:00:00+08:00",
    ordersTrashed: 5,
    ordersAlreadyTrashed: 0,
  });
});

describe("客户删除影响范围的竞态", () => {
  it("A 的旧请求晚返回时，不会覆盖 B 的确认框内容", async () => {
    const user = userEvent.setup();
    const slowA = deferred<{
      clientId: string;
      clientName: string;
      orderCount: number;
      alreadyTrashed: number;
    }>();

    clientDeleteImpact
      .mockImplementationOnce(() => slowA.promise)
      .mockImplementationOnce(async () => ({
        clientId: "c-b",
        clientName: "乙客户",
        orderCount: 5,
        alreadyTrashed: 0,
      }));

    await renderPage();

    // 1) 打开 A 的确认框，影响范围还在路上
    await user.click(screen.getByRole("button", { name: /甲客户/ }));
    await user.click(await screen.findByRole("button", { name: "移入回收站…" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("正在统计影响范围…");

    // 2) 取消，随后切到 B
    await user.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /乙客户/ }));
    await user.click(await screen.findByRole("button", { name: "移入回收站…" }));

    const dialog = await screen.findByRole("alertdialog");
    await waitFor(() => expect(dialog).toHaveTextContent("5 个关联订单"));

    // 3) A 的旧请求这时才返回，带着 99 单
    slowA.resolve({
      clientId: "c-a",
      clientName: "甲客户",
      orderCount: 99,
      alreadyTrashed: 0,
    });

    await waitFor(() => expect(clientDeleteImpact).toHaveBeenCalledTimes(2));
    expect(dialog).toHaveTextContent("5 个关联订单");
    expect(dialog).not.toHaveTextContent("99");

    // 4) 确认删除的必须是 B
    await user.click(within(dialog).getByRole("button", { name: "移入回收站" }));
    await waitFor(() => expect(deleteClient).toHaveBeenCalledWith("c-b"));
  });

  it("影响范围不属于当前客户时，确认按钮保持禁用", async () => {
    const user = userEvent.setup();
    // 服务端返回了另一个客户的数据：属于异常，必须挡住确认。
    clientDeleteImpact.mockResolvedValue({
      clientId: "c-a",
      clientName: "甲客户",
      orderCount: 3,
      alreadyTrashed: 0,
    });

    await renderPage();
    await user.click(screen.getByRole("button", { name: /乙客户/ }));
    await user.click(await screen.findByRole("button", { name: "移入回收站…" }));

    const dialog = await screen.findByRole("alertdialog");
    await waitFor(() => expect(dialog).toHaveTextContent("甲客户"));
    expect(within(dialog).getByRole("button", { name: "移入回收站" })).toBeDisabled();
  });
});
