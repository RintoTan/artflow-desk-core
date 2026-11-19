import { MemoryRouter, Route, Routes, useSearchParams } from "react-router-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OrderView } from "../bridge/commands";
import { daysFromCivil } from "../lib/scheduleBar";
import CalendarPage from "./CalendarPage";

const hoisted = vi.hoisted(() => ({
  listOrders: vi.fn(),
  status: vi.fn(),
  updateOrderDetails: vi.fn(),
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
    },
  };
});

const STATUS = {
  appVersion: "0.1.0",
  firstRun: false,
  generation: "gen-test",
  schemaVersion: 6,
  upgradedFrom: null,
  rootPath: "/tmp/test",
  sqliteVersion: "3.54.1",
  journalMode: "wal",
  workingTimezone: "Asia/Shanghai",
  systemTimezone: "Asia/Shanghai",
  lockHeld: true,
  orders: 0,
  clients: 0,
  templates: 0,
  attachments: 0,
  pendingCleanup: 0,
  highWater: [],
  integrity: "ok",
};

function order(overrides: Partial<OrderView> = {}): OrderView {
  return {
    id: "id-1",
    code: "AF-2026-0001",
    title: "测试订单",
    clientId: "c1",
    clientName: "林小满",
    commissionType: "半身立绘",
    stageTemplateId: "tpl",
    source: "画加",
    amountCents: 88000,
    note: "两张草图",
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

function OrdersProbe() {
  const [params] = useSearchParams();
  return <div data-testid="order-probe">{params.get("orderId") ?? ""}</div>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/calendar"]}>
      <Routes>
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/orders" element={<OrdersProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function ready(orders: OrderView[]) {
  hoisted.listOrders.mockImplementation(async () => ipc(orders));
  renderPage();
  await screen.findByRole("button", { name: "今天" });
}

beforeEach(() => {
  hoisted.listOrders.mockReset();
  hoisted.status.mockReset();
  hoisted.updateOrderDetails.mockReset();
  hoisted.status.mockImplementation(async () => ipc(STATUS));
  hoisted.listOrders.mockImplementation(async () =>
    ipc([
      order({ id: "a", code: "AF-2026-0001", plannedStartDate: "2026-11-10", plannedDeliveryDate: "2026-11-14" }),
      order({
        id: "none",
        code: "AF-2026-0002",
        title: "完全未排期",
        plannedStartDate: null,
        plannedDeliveryDate: null,
      }),
    ]),
  );
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-11-18T04:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("日历页面骨架", () => {
  it("默认月视图：6 周 × 7 天 = 42 格，周一起始", async () => {
    await ready([order()]);
    const weeks = document.querySelectorAll(".cal-week");
    expect(weeks).toHaveLength(6);
    const cells = document.querySelectorAll(".cal-day-bg");
    expect(cells).toHaveLength(42);
    // 2026-11-01 是周日 → 网格从 2026-10-26（周一）开始
    expect(Number(cells[0]?.getAttribute("data-day"))).toBe(daysFromCivil(2026, 10, 26));
    expect(screen.getByText("2026 年 11 月")).toBeInTheDocument();
  });

  it("切到周视图是 7 列，且保留当前浏览月份", async () => {
    const user = userEvent.setup();
    await ready([order()]);
    await user.click(screen.getByRole("button", { name: "下一段" }));
    const title = screen.getByText(/2026 年 12 月/);
    expect(title).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "周" }));
    expect(document.querySelectorAll(".cal-week")).toHaveLength(1);
    expect(document.querySelectorAll(".cal-day-bg")).toHaveLength(7);
    // 仍然是 12 月，没有跳回今天所在的 11 月
    expect(screen.getByText(/2026-12-14 ~ 2026-12-20/)).toBeInTheDocument();
  });

  it("「今天」回到包含今天的月份", async () => {
    const user = userEvent.setup();
    await ready([order()]);
    await user.click(screen.getByRole("button", { name: "上一段" }));
    expect(screen.getByText("2026 年 10 月")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "今天" }));
    expect(screen.getByText("2026 年 11 月")).toBeInTheDocument();
  });
});

describe("订单显示", () => {
  it("未排期订单进左侧池子，不进入网格", async () => {
    await ready([
      order({ id: "a" }),
      order({ id: "none", code: "AF-2026-0002", title: "完全未排期", plannedStartDate: null, plannedDeliveryDate: null }),
    ]);
    const pool = screen.getByLabelText("未排期订单");
    expect(within(pool).getByText("完全未排期")).toBeInTheDocument();
    const chips = [...document.querySelectorAll(".cal-chip")];
    expect(chips.map((c) => c.getAttribute("data-order-id"))).toEqual(["a"]);
  });

  it("同一周超过 3 条轨道折叠成 +N，点开能看到全部并可改期", async () => {
    const orders = ["01", "02", "03", "04"].map((n) =>
      order({
        id: `o${n}`,
        code: `AF-2026-00${n}`,
        title: `订单 ${n}`,
        plannedStartDate: "2026-11-18",
        plannedDeliveryDate: "2026-11-18",
      }),
    );
    await ready(orders);
    const more = [...document.querySelectorAll(".cal-more")];
    expect(more.length).toBeGreaterThan(0);
    expect(more[0]?.textContent).toBe("+1");
    fireEvent.click(more[0]!);
    const popover = await screen.findByRole("dialog", { name: /2026-11-18 的订单/ });
    expect(within(popover).getAllByRole("button", { name: "改期" })).toHaveLength(1);
  });

  it("显示已结束：终态进入网格但不可拖动，并出现历史分区", async () => {
    const user = userEvent.setup();
    await ready([
      order({ id: "a" }),
      order({
        id: "done",
        code: "AF-2026-0009",
        title: "已完成订单",
        status: "complete",
        plannedStartDate: "2026-11-12",
        plannedDeliveryDate: "2026-11-12",
      }),
      order({
        id: "ghost",
        code: "AF-2026-0010",
        title: "已结束未排期",
        status: "cancelled",
        plannedStartDate: null,
        plannedDeliveryDate: null,
      }),
    ]);
    // 默认关闭：终态不出现
    expect(document.querySelectorAll(".cal-chip")).toHaveLength(1);
    expect(screen.queryByText("已结束且未排期")).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "显示已结束" }));
    const chip = document.querySelector<HTMLElement>('[data-order-id="done"]')!;
    expect(chip).toBeTruthy();
    expect(chip.className).toContain("is-terminal");
    expect(chip.getAttribute("data-mode")).toBe("none");
    expect(screen.getByText("已结束且未排期")).toBeInTheDocument();
    expect(screen.getByText("已结束未排期")).toBeInTheDocument();
  });

  it("点击订单进入现有详情路由", async () => {
    const user = userEvent.setup();
    await ready([order({ id: "click-me" })]);
    await user.click(document.querySelector<HTMLElement>(".cal-chip")!);
    await waitFor(() => expect(screen.getByTestId("order-probe")).toHaveTextContent("click-me"));
  });
});

describe("改期流程", () => {
  it("键盘路径：改期对话框回填当前日期，确认后只写一次且来源为 calendar", async () => {
    const user = userEvent.setup();
    hoisted.updateOrderDetails.mockImplementation(async () => ipc(order()));
    await ready([order()]);

    await user.click(screen.getByRole("button", { name: "为 AF-2026-0001 改期" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("改期确认")).toBeInTheDocument();
    expect(within(dialog).getByText("AF-2026-0001")).toBeInTheDocument();
    expect(within(dialog).getByText("林小满 · 半身立绘")).toBeInTheDocument();

    const delivery = within(dialog).getByLabelText(/计划交付/) as HTMLInputElement;
    expect(delivery.value).toBe("2026-11-14");
    fireEvent.change(delivery, { target: { value: "2026-11-18" } });
    const reason = within(dialog).getByLabelText(/改期原因/);
    fireEvent.change(reason, { target: { value: "客户延期" } });

    await user.click(within(dialog).getByRole("button", { name: "确认改期" }));
    await waitFor(() => expect(hoisted.updateOrderDetails).toHaveBeenCalledTimes(1));

    const input = hoisted.updateOrderDetails.mock.calls[0]![0];
    expect(input).toMatchObject({
      orderId: "id-1",
      expectedRevision: 2,
      title: "测试订单",
      clientId: "c1",
      commissionType: "半身立绘",
      source: "画加",
      amountCents: 88000,
      plannedStartDate: "2026-11-10",
      plannedDeliveryDate: "2026-11-18",
      note: "两张草图",
      changeSource: "calendar",
      reason: "客户延期",
    });
  });

  it("取消确认零写入", async () => {
    const user = userEvent.setup();
    await ready([order()]);
    await user.click(screen.getByRole("button", { name: "为 AF-2026-0001 改期" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText(/计划交付/), { target: { value: "2026-11-25" } });
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(hoisted.updateOrderDetails).not.toHaveBeenCalled();
  });

  it("开始晚于交付被拦在对话框里，不发请求", async () => {
    const user = userEvent.setup();
    await ready([order()]);
    await user.click(screen.getByRole("button", { name: "为 AF-2026-0001 改期" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText(/计划交付/), { target: { value: "2026-11-01" } });
    expect(within(dialog).getByText("计划交付日期不能早于计划开始日期")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "确认改期" })).toBeDisabled();
    expect(hoisted.updateOrderDetails).not.toHaveBeenCalled();
  });

  it("未排期订单改期：必须选写入哪一端", async () => {
    const user = userEvent.setup();
    hoisted.updateOrderDetails.mockImplementation(async () => ipc(order()));
    await ready([
      order({ id: "none", code: "AF-2026-0002", title: "完全未排期", plannedStartDate: null, plannedDeliveryDate: null }),
    ]);
    await user.click(screen.getByRole("button", { name: "为 AF-2026-0002 改期" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/还没有计划日期/)).toBeInTheDocument();

    const date = within(dialog).getByLabelText(/排期日期/);
    fireEvent.change(date, { target: { value: "2026-11-20" } });
    // 默认写交付端
    await user.click(within(dialog).getByRole("button", { name: "确认改期" }));
    await waitFor(() => expect(hoisted.updateOrderDetails).toHaveBeenCalledTimes(1));
    expect(hoisted.updateOrderDetails.mock.calls[0]![0]).toMatchObject({
      plannedStartDate: null,
      plannedDeliveryDate: "2026-11-20",
    });
  });

  it("revision 冲突：对话框保留并显示后端原文，自动重载", async () => {
    const user = userEvent.setup();
    hoisted.updateOrderDetails.mockImplementation(async () => {
      throw { code: "CONFLICT", message: "订单已被修改（当前版本 5，你基于 2）。请刷新后重试。" };
    });
    await ready([order()]);
    const callsBefore = hoisted.listOrders.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "为 AF-2026-0001 改期" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText(/计划交付/), { target: { value: "2026-11-28" } });
    await user.click(within(dialog).getByRole("button", { name: "确认改期" }));

    await waitFor(() => expect(screen.getByRole("alertdialog")).toHaveTextContent(/订单已被修改/));
    expect(hoisted.updateOrderDetails).toHaveBeenCalledTimes(1);
    expect(hoisted.listOrders.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("终态订单没有改期入口", async () => {
    const user = userEvent.setup();
    await ready([
      order({ id: "done", code: "AF-2026-0009", status: "complete", title: "已完成" }),
    ]);
    await user.click(screen.getByRole("checkbox", { name: "显示已结束" }));
    expect(screen.queryByRole("button", { name: /为 AF-2026-0009 改期/ })).not.toBeInTheDocument();
  });
});

describe("数据加载", () => {
  it("首次加载失败显示错误与重试，重试后恢复", async () => {
    const user = userEvent.setup();
    hoisted.listOrders.mockRejectedValueOnce(new Error("QA 注入"));
    renderPage();
    await screen.findByText("无法读取日历数据");
    await user.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByRole("button", { name: "今天" });
  });

  it("刷新失败保留旧数据", async () => {
    const user = userEvent.setup();
    await ready([order()]);
    hoisted.listOrders.mockRejectedValue(new Error("QA 注入：刷新失败"));
    await user.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/刷新失败/));
    expect(document.querySelectorAll(".cal-chip").length).toBeGreaterThan(0);
  });
});
