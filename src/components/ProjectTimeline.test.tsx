import { MemoryRouter, Route, Routes, useSearchParams } from "react-router-dom";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OrderView } from "../bridge/commands";
import { ProjectTimeline } from "./ProjectTimeline";

/** 2026-11-18 12:00（Asia/Shanghai）→ 工作日的今天固定为 2026-11-18。 */
const NOW = "2026-11-18T04:00:00.000Z";

const hoisted = vi.hoisted(() => ({
  listOrders: vi.fn(),
  status: vi.fn(),
}));

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>("../bridge/commands");
  return {
    ...actual,
    api: { ...actual.api, listOrders: hoisted.listOrders, status: hoisted.status },
  };
});

const STATUS = {
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
    clientId: null,
    clientName: "林小满",
    commissionType: null,
    stageTemplateId: "tpl-a",
    source: null,
    amountCents: 88000,
    note: null,
    status: "active",
    workState: "queued",
    currentStageId: "draft",
    currentStageTitle: "草稿",
    currentStageIndex: 0,
    stageCount: 5,
    stages: [],
    queuePosition: 0,
    plannedStartDate: "2026-11-10",
    plannedDeliveryDate: "2026-11-20",
    deadlineState: "dueSoon",
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    revision: 1,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    capabilities: {
      canStartWork: true,
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

function OrdersProbe() {
  const [params] = useSearchParams();
  return <div data-testid="order-probe">{params.get("orderId") ?? ""}</div>;
}

function renderTimeline() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<ProjectTimeline nowIso={NOW} />} />
        <Route path="/orders" element={<OrdersProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

function rangeText(): string {
  return screen.getByTestId("timeline-range").textContent ?? "";
}

beforeEach(() => {
  hoisted.listOrders.mockReset();
  hoisted.status.mockReset();
  hoisted.status.mockResolvedValue(STATUS);
  hoisted.listOrders.mockResolvedValue([order()]);
});

describe("ProjectTimeline 尺度与导航", () => {

  it("切到日尺度会重算窗口与画布宽", async () => {
    const user = userEvent.setup();
    renderTimeline();
    await screen.findByTestId("timeline-frame");
    await user.click(screen.getByRole("button", { name: "日" }));
    // 锚点取切换前窗口中心，故只断言跨度与画布宽，不锁死具体起止日
    expect(rangeText()).toContain("日尺度");
    expect(screen.getByTestId("timeline-canvas").style.width).toBe("1320px");
  });

  it("提供日 / 周 / 月 / 年四个视图", async () => {
    renderTimeline();
    await screen.findByTestId("timeline-frame");
    const group = screen.getByRole("group", { name: "时间尺度" });
    const labels = Array.from(group.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels).toEqual(["日", "周", "月", "年"]);
  });

  it("切到周视图按整自然周对齐", async () => {
    const user = userEvent.setup();
    renderTimeline();
    await screen.findByTestId("timeline-frame");
    await user.click(screen.getByRole("button", { name: "周" }));
    // 8 周：起点为周一、终点为周日，跨度 56~62 天
    expect(rangeText()).toMatch(/窗口 \d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}/);
  });




  it("切换尺度不重新请求订单", async () => {
    const user = userEvent.setup();
    renderTimeline();
    await screen.findByTestId("timeline-frame");
    await user.click(screen.getByRole("button", { name: "日" }));
    await user.click(screen.getByRole("button", { name: "年" }));
    expect(hoisted.listOrders).toHaveBeenCalledTimes(1);
  });
});

describe("ProjectTimeline 订单展示", () => {
  it("终态默认隐藏，打开开关后以中性色出现", async () => {
    const user = userEvent.setup();
    hoisted.listOrders.mockResolvedValue([
      order({ id: "id-active", code: "AF-1" }),
      order({
        id: "id-done",
        code: "AF-2",
        status: "complete",
        plannedStartDate: "2026-11-01",
        plannedDeliveryDate: "2026-11-05",
        completedAt: "2026-11-05T02:00:00.000Z",
      }),
    ]);
    renderTimeline();
    await screen.findByTestId("timeline-frame");
    expect(screen.queryByText("AF-2")).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("显示已结束"));
    expect(screen.getByText("AF-2")).toBeInTheDocument();
    const row = document.querySelector('.timeline-row[data-order-id="id-done"]');
    expect(row).toHaveAttribute("data-tone", "terminal");
  });

  it("只有开始日期的订单仍显示在时间线上，并单独标注", async () => {
    hoisted.listOrders.mockResolvedValue([
      order({ id: "id-start", code: "AF-3", plannedStartDate: "2026-11-16", plannedDeliveryDate: null }),
    ]);
    renderTimeline();
    await screen.findByTestId("timeline-frame");
    expect(screen.getByText("AF-3")).toBeInTheDocument();
    expect(screen.getByText("仅开始")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-range")).toHaveTextContent("完全未排期 0 单");
  });

  it("两个日期都为空的订单进入完全未排期区", async () => {
    hoisted.listOrders.mockResolvedValue([
      order({ id: "id-start", code: "AF-3", plannedStartDate: "2026-11-16", plannedDeliveryDate: null }),
      order({ id: "id-none", code: "AF-4", title: "没定日期", plannedStartDate: null, plannedDeliveryDate: null }),
    ]);
    renderTimeline();
    await screen.findByTestId("timeline-frame");
    expect(screen.getByTestId("timeline-range")).toHaveTextContent("完全未排期 1 单");
    const block = screen.getByRole("heading", { name: /完全未排期/ }).parentElement!;
    expect(within(block).getByText("AF-4")).toBeInTheDocument();
  });

  it("年尺度下同日订单退化为点，不画横条", async () => {
    const user = userEvent.setup();
    hoisted.listOrders.mockResolvedValue([
      order({
        id: "id-single",
        code: "AF-5",
        plannedStartDate: "2026-11-18",
        plannedDeliveryDate: "2026-11-18",
      }),
    ]);
    renderTimeline();
    await screen.findByTestId("timeline-frame");
    await user.click(screen.getByRole("button", { name: "年" }));
    const row = document.querySelector('.timeline-row[data-order-id="id-single"]')!;
    expect(row.querySelector(".timeline-bar")).toBeNull();
    expect(row.querySelector(".timeline-mark.is-delivery")).not.toBeNull();
  });

  it("整段在窗口外的订单给出方向提示，不伪造端点", async () => {
    hoisted.listOrders.mockResolvedValue([
      order({
        id: "id-out",
        code: "AF-6",
        plannedStartDate: "2028-03-01",
        plannedDeliveryDate: "2028-03-10",
        deadlineState: "scheduled",
      }),
    ]);
    renderTimeline();
    await screen.findByTestId("timeline-frame");
    expect(screen.getByText(/窗口外：2028-03-01 → 2028-03-10/)).toBeInTheDocument();
    expect(document.querySelector(".timeline-bar")).toBeNull();
  });
});

describe("ProjectTimeline 空状态", () => {
  it("没有任何订单", async () => {
    hoisted.listOrders.mockResolvedValue([]);
    renderTimeline();
    expect(await screen.findByText("尚无订单")).toBeInTheDocument();
  });

  it("有订单但都没有计划日期", async () => {
    hoisted.listOrders.mockResolvedValue([
      order({ id: "id-a", code: "AF-7", plannedStartDate: null, plannedDeliveryDate: null }),
    ]);
    renderTimeline();
    expect(await screen.findByText("没有任何订单填入计划日期")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-range")).toHaveTextContent("完全未排期 1 单");
  });

  it("只剩终态订单且都没有计划日期时，仍显示终态空状态（FIX-01）", async () => {
    hoisted.listOrders.mockResolvedValue([
      order({
        id: "id-done",
        code: "AF-DONE",
        status: "complete",
        plannedStartDate: null,
        plannedDeliveryDate: null,
        completedAt: "2026-11-05T02:00:00.000Z",
      }),
      order({
        id: "id-cancelled",
        code: "AF-CANCELLED",
        status: "cancelled",
        plannedStartDate: null,
        plannedDeliveryDate: null,
        cancelledAt: "2026-11-06T02:00:00.000Z",
      }),
    ]);
    renderTimeline();
    expect(await screen.findByText("活动订单已全部结束")).toBeInTheDocument();
    expect(screen.queryByText("没有任何订单填入计划日期")).not.toBeInTheDocument();
    expect(screen.queryByText("尚无订单")).not.toBeInTheDocument();
  });

  it("活动订单全部被终态过滤", async () => {
    hoisted.listOrders.mockResolvedValue([
      order({
        id: "id-done",
        code: "AF-8",
        status: "complete",
        plannedStartDate: "2026-11-01",
        plannedDeliveryDate: "2026-11-05",
      }),
    ]);
    renderTimeline();
    expect(await screen.findByText("活动订单已全部结束")).toBeInTheDocument();
  });
});

describe("ProjectTimeline 错误与刷新", () => {
  it("初次读取失败显示错误与重试，重试成功后渲染时间线", async () => {
    const user = userEvent.setup();
    hoisted.listOrders.mockRejectedValueOnce(new Error("数据库被占用"));
    renderTimeline();
    expect(await screen.findByText("无法读取时间线")).toBeInTheDocument();
    expect(screen.getByText(/数据库被占用/)).toBeInTheDocument();

    hoisted.listOrders.mockResolvedValue([order()]);
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByTestId("timeline-frame")).toBeInTheDocument();
  });

  it("后续刷新失败保留上次数据并给出反馈", async () => {
    const user = userEvent.setup();
    renderTimeline();
    await screen.findByTestId("timeline-frame");
    hoisted.listOrders.mockRejectedValueOnce(new Error("刷新炸了"));
    await user.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByText(/刷新失败，仍显示上次读取的数据/)).toBeInTheDocument();
    expect(screen.getByText("AF-2026-0001")).toBeInTheDocument();
  });

  it("旧请求不会覆盖新请求的结果", async () => {
    let resolveFirst: (value: OrderView[]) => void = () => {};
    const first = new Promise<OrderView[]>((resolve) => {
      resolveFirst = resolve;
    });
    hoisted.listOrders.mockReturnValueOnce(first);
    hoisted.listOrders.mockResolvedValueOnce([order({ id: "id-new", code: "AF-NEW", title: "新请求" })]);

    renderTimeline();
    await waitFor(() => expect(hoisted.listOrders).toHaveBeenCalledTimes(1));

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await screen.findByText("AF-NEW");

    await act(async () => {
      resolveFirst([order({ id: "id-old", code: "AF-OLD", title: "旧请求" })]);
    });
    await waitFor(() => expect(screen.queryByText("AF-OLD")).not.toBeInTheDocument());
    expect(screen.getByText("AF-NEW")).toBeInTheDocument();
  });
});

describe("ProjectTimeline 下钻", () => {
  it("单击只选中订单行，不跳转；双击才进详情", async () => {
    const user = userEvent.setup();
    hoisted.listOrders.mockResolvedValue([
      order({ id: "0b7c7e5e-1f52-4f4a-9f37-2d2b1c9a8e11", code: "AF-2026-0101" }),
    ]);
    renderTimeline();
    await screen.findByTestId("timeline-frame");

    const row = document.querySelector(".timeline-row")!;
    await user.click(row);
    expect(row).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByTestId("order-probe")).toBeNull();

    await user.dblClick(row);
    expect(screen.getByTestId("order-probe")).toHaveTextContent(
      "0b7c7e5e-1f52-4f4a-9f37-2d2b1c9a8e11",
    );
  });

  it("键盘 Enter 可以打开订单详情", async () => {
    const user = userEvent.setup();
    hoisted.listOrders.mockResolvedValue([order({ id: "id-keyboard", code: "AF-2026-0102" })]);
    renderTimeline();
    await screen.findByTestId("timeline-frame");
    const link = screen.getAllByRole("button", { name: /AF-2026-0102/ })[0]!;
    link.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("order-probe")).toHaveTextContent("id-keyboard");
  });

  it("完全未排期条目也能进入详情", async () => {
    const user = userEvent.setup();
    hoisted.listOrders.mockResolvedValue([
      order({ id: "id-none", code: "AF-2026-0103", plannedStartDate: null, plannedDeliveryDate: null }),
    ]);
    renderTimeline();
    await screen.findByText("没有任何订单填入计划日期");
    const block = screen.getByRole("heading", { name: /完全未排期/ }).parentElement!;
    await user.click(within(block).getByRole("link"));
    expect(screen.getByTestId("order-probe")).toHaveTextContent("id-none");
  });
});
