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
    canComplete: false,
    canCancel: true,
    canReopen: false,
    canEditWorkflow: true,
  },
};

let stored: Record<string, string | null>;
let getImpl: (key: string) => Promise<string | null>;
let setCalls: Array<{ key: string; value: string }>;

const preferenceApi = {
  get: (key: string) => getImpl(key),
  set: async (key: string, value: string) => {
    setCalls.push({ key, value });
    stored[key] = value;
    return value as string;
  },
};

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    preferenceApi,
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
    templateApi: { ...actual.templateApi, list: async () => [] },
    queueApi: { ...actual.queueApi, list: async () => ({ revision: 0, items: [] }) },
  };
});

const { default: OrdersPage } = await import("./OrdersPage");

function renderPage() {
  const router = createMemoryRouter(
    [{ path: "/orders", element: <OrdersPage /> }],
    { initialEntries: ["/orders"] },
  );
  return render(<RouterProvider router={router} />);
}

beforeEach(() => {
  stored = {};
  setCalls = [];
  getImpl = async (key) => (key in stored ? (stored[key] ?? null) : null);
});

describe("订单视图偏好", () => {
  it("没有保存过时默认使用卡片视图", async () => {
    renderPage();
    await waitFor(() => expect(screen.getAllByText("双人插画").length).toBeGreaterThan(0));
    expect(screen.getByRole("button", { name: "卡片" })).toHaveAttribute("aria-pressed", "true");
    // 卡片视图是并排双栏：详情不应是抽屉形式。
    expect(document.querySelector(".orders-detail-drawer")).toBeNull();
  });

  it("保存过 board 时进入看板", async () => {
    stored.orders_view_mode = "board";
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "看板" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
  });

  it("非法的已存值安全回退到卡片，不报错也不崩", async () => {
    stored.orders_view_mode = "timeline";
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "卡片" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
  });

  it("切换视图会写入同一个键，键名与后端一致", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getAllByText("双人插画").length).toBeGreaterThan(0));

    await user.click(screen.getByRole("button", { name: "表格" }));
    await waitFor(() =>
      expect(setCalls).toContainEqual({ key: "orders_view_mode", value: "table" }),
    );
  });

  it("偏好读取被拒（DENIED）时列表照常显示，并明确提示没记住", async () => {
    const user = userEvent.setup();
    getImpl = async (key) => {
      if (key === "orders_view_mode") throw new Error("不允许读取的偏好项：orders_view_mode");
      return null;
    };
    // set 也失败时，界面必须说清"这次切了但没记住"。
    preferenceApi.set = async (key: string, value: string) => {
      setCalls.push({ key, value });
      throw new Error("不允许写入的偏好项：orders_view_mode");
    };

    renderPage();
    // 关键回归：DENIED 不能把整个订单列表打成错误页。
    await waitFor(() => expect(screen.getAllByText("双人插画").length).toBeGreaterThan(0));

    await user.click(screen.getByRole("button", { name: "看板" }));
    await waitFor(() =>
      expect(
        screen.getAllByRole("status").some((n) => /没能记住偏好/.test(n.textContent ?? "")),
      ).toBe(true),
    );
    // 视图本身仍然切换了，用户不会被卡住。
    expect(screen.getByRole("button", { name: "看板" })).toHaveAttribute("aria-pressed", "true");
  });
});
