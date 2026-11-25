import { MemoryRouter, Route, Routes } from "react-router-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OrderView } from "../bridge/commands";

const hoisted = vi.hoisted(() => ({
  listOrders: vi.fn(),
  status: vi.fn(),
  updateOrderDetails: vi.fn(),
  cancelOrder: vi.fn(),
  completeOrder: vi.fn(),
  reopenOrder: vi.fn(),
  undoStartWork: vi.fn(),
}));

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>("../bridge/commands");
  return {
    ...actual,
    api: {
      ...actual.api,
      listOrders: hoisted.listOrders,
      status: hoisted.status,
      updateOrderDetails: hoisted.updateOrderDetails,
      cancelOrder: hoisted.cancelOrder,
      completeOrder: hoisted.completeOrder,
      reopenOrder: hoisted.reopenOrder,
      undoStartWork: hoisted.undoStartWork,
    },
  };
});

const { default: CalendarPage } = await import("./CalendarPage");

const STATUS = {
  appVersion: "0.1.2",
  firstRun: false,
  generation: "gen-test",
  schemaVersion: 12,
  upgradedFrom: null,
  rootPath: "/tmp/test",
  sqliteVersion: "3.54.1",
  journalMode: "wal",
  workingTimezone: "Asia/Shanghai",
  systemTimezone: "Asia/Shanghai",
  lockHeld: true,
  orders: 1,
  clients: 1,
  templates: 0,
  attachments: 0,
  pendingCleanup: 0,
  highWater: [],
  integrity: "ok",
};

function order(overrides: Partial<OrderView> = {}): OrderView {
  return {
    id: "a",
    code: "AF-2026-0001",
    title: "测试订单",
    clientId: "c1",
    clientName: "林小满",
    commissionType: "半身立绘",
    stageTemplateId: "tpl",
    source: "画加",
    amountCents: 88000,
    note: null,
    status: "active",
    workState: "queued",
    currentStageId: "s1",
    currentStageTitle: "草稿",
    currentStageIndex: 0,
    stageCount: 5,
    stages: [],
    queuePosition: 0,
    plannedStartDate: "2026-11-10",
    plannedDeliveryDate: "2026-11-14",
    deadlineState: "scheduled",
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    revision: 2,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    capabilities: {
      canStartWork: false,
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
    ...overrides,
  };
}

function ipc<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/calendar"]}>
      <Routes>
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/orders" element={<div data-testid="orders-route" />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function ready(orders: OrderView[]) {
  hoisted.listOrders.mockImplementation(async () => ipc(orders));
  renderPage();
  return screen.findByRole("button", { name: "今天" });
}

beforeEach(() => {
  hoisted.listOrders.mockReset();
  hoisted.status.mockReset();
  hoisted.updateOrderDetails.mockReset();
  hoisted.cancelOrder.mockReset();
  hoisted.completeOrder.mockReset();
  hoisted.reopenOrder.mockReset();
  hoisted.undoStartWork.mockReset();
  hoisted.status.mockImplementation(async () => ipc(STATUS));
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-11-18T04:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("日历右键菜单", () => {
  it("右键订单条：菜单打开，并且该条被选中", async () => {
    await ready([order()]);
    const chip = await screen.findByRole("button", { name: "AF-2026-0001 测试订单" });
    fireEvent.contextMenu(chip);

    await screen.findByRole("menu", { name: "订单操作" });
    expect(chip).toHaveAttribute("aria-selected", "true");
  });

  it("右键不产生改期：日期写入一次都没有发生", async () => {
    await ready([order()]);
    const chip = await screen.findByRole("button", { name: "AF-2026-0001 测试订单" });
    fireEvent.contextMenu(chip);
    await screen.findByRole("menu", { name: "订单操作" });

    expect(hoisted.updateOrderDetails).not.toHaveBeenCalled();
  });

  it("菜单里的取消进入取消对话框，对象是被右键的那一单", async () => {
    await ready([order()]);
    const chip = await screen.findByRole("button", { name: "AF-2026-0001 测试订单" });
    fireEvent.contextMenu(chip);

    fireEvent.click(await screen.findByRole("menuitem", { name: "取消订单…" }));
    const dialog = await screen.findByRole("alertdialog", { name: "取消订单" });
    expect(dialog.textContent).toContain("AF-2026-0001");
  });

  it("已完成订单：只有打开与重新打开，没有取消", async () => {
    const done = order({ status: "complete" });
    done.capabilities.canCancel = false;
    done.capabilities.canReopen = true;
    await ready([done]);
    // 终态订单默认不进网格，先打开「显示已结束」再用右键
    fireEvent.click(screen.getByLabelText(/显示已结束/));

    const chip = await screen.findByRole("button", { name: "AF-2026-0001 测试订单" });
    fireEvent.contextMenu(chip);

    await screen.findByRole("menu", { name: "订单操作" });
    expect(screen.getByRole("menuitem", { name: "打开订单" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "重新打开" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "取消订单…" })).toBeNull();
  });

  it("Esc 关掉菜单", async () => {
    await ready([order()]);
    const chip = await screen.findByRole("button", { name: "AF-2026-0001 测试订单" });
    fireEvent.contextMenu(chip);
    await screen.findByRole("menu", { name: "订单操作" });

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});
