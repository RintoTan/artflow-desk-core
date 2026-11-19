import { MemoryRouter, Route, Routes, useSearchParams } from "react-router-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OrderView } from "../bridge/commands";
import { parseDayKey } from "../lib/scheduleBar";
import { weekdayIndex } from "../lib/timeline";
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
  it("默认月视图：连续周行，每周 7 天，周一起始", async () => {
    await ready([order()]);
    const weeks = document.querySelectorAll(".cal-week");
    // 连续式日历：初始前后各 30 周，滚动到边界再扩展
    expect(weeks.length).toBeGreaterThanOrEqual(28);
    const cells = document.querySelectorAll(".cal-day-bg");
    expect(cells.length).toBe(weeks.length * 7);
    const firstDay = Number(cells[0]?.getAttribute("data-day"));
    expect(weekdayIndex(firstDay)).toBe(0); // 每周从周一开始
    // 相邻格子严格 +1，不重复不跳号
    const days = [...cells].map((c) => Number(c.getAttribute("data-day")));
    expect(days.every((d, i) => i === 0 || d === days[i - 1]! + 1)).toBe(true);
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

  it("未排期改期：两个日期都可自由填写，两端皆空时不能提交", async () => {
    const user = userEvent.setup();
    hoisted.updateOrderDetails.mockImplementation(async () => ipc(order()));
    await ready([
      order({ id: "none", code: "AF-2026-0002", title: "完全未排期", plannedStartDate: null, plannedDeliveryDate: null }),
    ]);
    await user.click(screen.getByRole("button", { name: "为 AF-2026-0002 改期" }));
    const dialog = await screen.findByRole("alertdialog");

    // 不再有二选一单选，两个输入都可用
    expect(within(dialog).queryByRole("radio")).not.toBeInTheDocument();
    const startInput = within(dialog).getByLabelText(/计划开始/) as HTMLInputElement;
    const deliveryInput = within(dialog).getByLabelText(/计划交付/) as HTMLInputElement;
    expect(startInput.disabled).toBe(false);
    expect(deliveryInput.disabled).toBe(false);
    // 两端皆空 → 不能确认
    expect(within(dialog).getByRole("button", { name: "确认改期" })).toBeDisabled();

    // 只填开始日期
    fireEvent.change(startInput, { target: { value: "2026-11-20" } });
    expect(within(dialog).getByRole("button", { name: "确认改期" })).toBeEnabled();
    await user.click(within(dialog).getByRole("button", { name: "确认改期" }));
    await waitFor(() => expect(hoisted.updateOrderDetails).toHaveBeenCalledTimes(1));
    expect(hoisted.updateOrderDetails.mock.calls[0]![0]).toMatchObject({
      plannedStartDate: "2026-11-20",
      plannedDeliveryDate: null,
    });
  });

  it("未排期改期：两端都填时按两端写入，且校验先后顺序", async () => {
    const user = userEvent.setup();
    hoisted.updateOrderDetails.mockImplementation(async () => ipc(order()));
    await ready([
      order({ id: "none", code: "AF-2026-0002", title: "完全未排期", plannedStartDate: null, plannedDeliveryDate: null }),
    ]);
    await user.click(screen.getByRole("button", { name: "为 AF-2026-0002 改期" }));
    const dialog = await screen.findByRole("alertdialog");
    const startInput = within(dialog).getByLabelText(/计划开始/);
    const deliveryInput = within(dialog).getByLabelText(/计划交付/);

    fireEvent.change(startInput, { target: { value: "2026-11-20" } });
    fireEvent.change(deliveryInput, { target: { value: "2026-11-18" } });
    expect(within(dialog).getByText("计划交付日期不能早于计划开始日期")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "确认改期" })).toBeDisabled();

    fireEvent.change(deliveryInput, { target: { value: "2026-11-25" } });
    await user.click(within(dialog).getByRole("button", { name: "确认改期" }));
    await waitFor(() => expect(hoisted.updateOrderDetails).toHaveBeenCalledTimes(1));
    expect(hoisted.updateOrderDetails.mock.calls[0]![0]).toMatchObject({
      plannedStartDate: "2026-11-20",
      plannedDeliveryDate: "2026-11-25",
    });
  });

  it("清空一端后另一端保留", async () => {
    const user = userEvent.setup();
    await ready([order({ plannedStartDate: "2026-11-10", plannedDeliveryDate: "2026-11-14" })]);
    await user.click(screen.getByRole("button", { name: "为 AF-2026-0001 改期" }));
    const dialog = await screen.findByRole("alertdialog");
    const startInput = within(dialog).getByLabelText(/计划开始/) as HTMLInputElement;
    fireEvent.change(startInput, { target: { value: "" } });
    expect(startInput.value).toBe("");
    expect((within(dialog).getByLabelText(/计划交付/) as HTMLInputElement).value).toBe("2026-11-14");
    expect(within(dialog).getByRole("button", { name: "确认改期" })).toBeEnabled();
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

describe("UI-06：+N 浮层与日期格交互", () => {
  const overlap = ["01", "02", "03", "04"].map((n) =>
    order({
      id: `o${n}`,
      code: `AF-2026-00${n}`,
      title: `订单 ${n}`,
      plannedStartDate: "2026-11-18",
      plannedDeliveryDate: "2026-11-18",
    }),
  );

  it("再次点击同一个 +N 关闭，点日历其它地方也关闭", async () => {
    await ready(overlap);
    const more = document.querySelector<HTMLElement>(".cal-more")!;
    fireEvent.click(more, { detail: 1 });
    expect(await screen.findByRole("dialog", { name: /2026-11-18 的订单/ })).toBeInTheDocument();

    fireEvent.click(more, { detail: 1 });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /2026-11-18 的订单/ })).not.toBeInTheDocument(),
    );

    fireEvent.click(more, { detail: 1 });
    expect(await screen.findByRole("dialog", { name: /2026-11-18 的订单/ })).toBeInTheDocument();
    fireEvent.pointerDown(document.querySelector(".cal-title")!);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /2026-11-18 的订单/ })).not.toBeInTheDocument(),
    );
  });

  it("按 Esc 关闭浮层", async () => {
    await ready(overlap);
    fireEvent.click(document.querySelector<HTMLElement>(".cal-more")!, { detail: 1 });
    const popover = await screen.findByRole("dialog", { name: /2026-11-18 的订单/ });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /2026-11-18 的订单/ })).not.toBeInTheDocument(),
    );
    expect(popover).toBeTruthy();
  });

  it("点击浮层内部不关闭", async () => {
    await ready(overlap);
    fireEvent.click(document.querySelector<HTMLElement>(".cal-more")!, { detail: 1 });
    const popover = await screen.findByRole("dialog", { name: /2026-11-18 的订单/ });
    fireEvent.pointerDown(popover);
    expect(screen.getByRole("dialog", { name: /2026-11-18 的订单/ })).toBeInTheDocument();
  });

  it("点击非当月日期：焦点落在该格并把月份切过去", async () => {
    await ready([order()]);
    const outside = [...document.querySelectorAll<HTMLElement>(".cal-day-bg")].find(
      (cell) => cell.dataset.outside === "1" && Number(cell.dataset.day) > parseDayKey("2026-11-30")!,
    )!;
    expect(outside).toBeTruthy();
    fireEvent.click(outside, { detail: 1 });
    await waitFor(() => expect(screen.getByText("2026 年 12 月")).toBeInTheDocument());
    const same = document.querySelector<HTMLElement>(`.cal-day-bg[data-day="${outside.dataset.day}"]`)!;
    expect(same.dataset.focus).toBe("1");
  });
});

describe("UI-06：未排期订单拖入日期格", () => {
  it("松手直接开确认框，默认把落点写进交付日期", async () => {
    await ready([
      order({
        id: "none",
        code: "AF-2026-0002",
        title: "完全未排期",
        plannedStartDate: null,
        plannedDeliveryDate: null,
      }),
    ]);
    const target = parseDayKey("2026-12-18")!;
    const cell = document.querySelector<HTMLElement>(`.cal-day-bg[data-day="${target}"]`)!;
    // jsdom 没有 elementsFromPoint：按落点返回目标格
    const original = document.elementsFromPoint;
    document.elementsFromPoint = (() => [cell]) as unknown as typeof document.elementsFromPoint;

    try {
      const item = document.querySelector<HTMLElement>(".cal-pool-item")!;
      fireEvent.pointerDown(item, { button: 0, clientX: 10, clientY: 10, pointerId: 7 });
      fireEvent.pointerMove(window, { clientX: 40, clientY: 40, pointerId: 7 });
      fireEvent.pointerMove(window, { clientX: 220, clientY: 220, pointerId: 7 });
      fireEvent.pointerUp(window, { clientX: 220, clientY: 220, pointerId: 7 });

      const dialog = await screen.findByRole("alertdialog");
      expect((within(dialog).getByLabelText(/计划交付/) as HTMLInputElement).value).toBe("2026-12-18");
      expect((within(dialog).getByLabelText(/计划开始/) as HTMLInputElement).value).toBe("");
    } finally {
      document.elementsFromPoint = original;
    }
  });
});
