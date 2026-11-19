import { MemoryRouter, Route, Routes, useSearchParams } from "react-router-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OrderView } from "../bridge/commands";
import { ProjectTimeline } from "./ProjectTimeline";

/**
 * DEV-06D-2-FIX-02：ISSUE-01（标题完整显示）、ISSUE-02（周视图范围）、UX-TL-01（日期提示）。
 *
 * jsdom 没有排版引擎，标题"是否被压扁"必须在真实浏览器里量（scripts/timeline-autoqa.mjs）；
 * 这里验的是可访问名称、原文完整、提示内容与显隐、以及周窗口/刻度的计算结论。
 */

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

function ipc<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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

async function renderWith(orders: OrderView[]) {
  hoisted.listOrders.mockImplementation(async () => ipc(orders));
  renderTimeline();
  await screen.findByTestId("timeline-frame");
}

beforeEach(() => {
  hoisted.listOrders.mockReset();
  hoisted.status.mockReset();
  hoisted.status.mockImplementation(async () => ipc(STATUS));
  hoisted.listOrders.mockImplementation(async () => ipc([order()]));
});

// ---------------------------------------------------------------- ISSUE-01

describe("ISSUE-01 标题完整显示", () => {
  const LONG =
    "封面主视觉重绘与全彩上色第二版修订稿第三轮细化和背景补画以及最终交付前的整体检查IllustrationFullRedrawRevisionWithoutAnySpacesAtAll";

  it("短标题：完整渲染，并提供同名 title 供悬浮查看", async () => {
    await renderWith([order({ title: "短标题" })]);
    const link = document.querySelector<HTMLAnchorElement>(".timeline-info")!;
    expect(within(link).getByText("短标题")).toBeInTheDocument();
    expect(link).toHaveAttribute("title", "短标题");
    // 可访问名称包含订单编号、完整标题与客户/阶段
    expect(link.textContent).toContain("短标题");
    expect(link.textContent).toContain("AF-2026-0001");
  });

  it("超长标题：DOM 文本仍是完整标题，title 与可访问名称不被截断", async () => {
    await renderWith([order({ title: LONG })]);
    const link = document.querySelector<HTMLAnchorElement>(".timeline-info")!;
    const titleNode = link.querySelector(".timeline-title")!;
    expect(titleNode.textContent).toBe(LONG);
    expect(link.title).toBe(LONG);
    // 视觉截断交给 CSS（ellipsis），DOM 里不能残留省略号字符
    expect(titleNode.textContent).not.toContain("…");
    expect(link.textContent).toContain(LONG);
  });

  it("键盘用户：链接自身可聚焦，名称里带完整标题", async () => {
    const user = userEvent.setup();
    await renderWith([order({ title: LONG })]);
    const link = document.querySelector<HTMLAnchorElement>(".timeline-info")!;
    link.focus();
    expect(document.activeElement).toBe(link);
    expect(link.getAttribute("title")).toBe(LONG);

    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByTestId("order-probe")).toHaveTextContent("id-1"),
    );
  });

  it("鼠标点击信息列仍然进入订单详情（ID 不是编号）", async () => {
    const user = userEvent.setup();
    await renderWith([order({ id: "real-uuid-7", code: "AF-2026-0099", title: "点我" })]);
    await user.click(document.querySelector<HTMLAnchorElement>(".timeline-info")!);
    await waitFor(() =>
      expect(screen.getByTestId("order-probe")).toHaveTextContent("real-uuid-7"),
    );
  });

  it("三行文字结构保持不变：编号 / 标题 / 客户与阶段", async () => {
    await renderWith([order()]);
    const link = document.querySelector<HTMLAnchorElement>(".timeline-info")!;
    expect(link.querySelector(".timeline-code")?.textContent).toBe("AF-2026-0001");
    expect(link.querySelector(".timeline-title")?.textContent).toBe("测试订单");
    expect(link.querySelector(".timeline-sub")?.textContent).toContain("林小满");
  });
});

// ---------------------------------------------------------------- UX-TL-01

describe("UX-TL-01 日期提示", () => {
  it("双日期订单：悬浮区间条显示完整起止日期", async () => {
    await renderWith([order({ plannedStartDate: "2026-11-10", plannedDeliveryDate: "2026-11-20" })]);
    const bar = document.querySelector<HTMLElement>(".timeline-bar")!;
    fireEvent.pointerOver(bar);

    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent("开始日期：2026-11-10");
    expect(tip).toHaveTextContent("交付日期：2026-11-20");
    expect(bar).toHaveAttribute("aria-label", "AF-2026-0001 排期：开始日期：2026-11-10；交付日期：2026-11-20");
  });

  it("鼠标离开后提示消失", async () => {
    await renderWith([order()]);
    const bar = document.querySelector<HTMLElement>(".timeline-bar")!;
    fireEvent.pointerOver(bar);
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    fireEvent.pointerOut(bar);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  });

  it("键盘聚焦区间条也能看到提示，失焦后消失", async () => {
    await renderWith([order({ plannedStartDate: "2026-11-10", plannedDeliveryDate: "2026-11-20" })]);
    const bar = document.querySelector<HTMLElement>(".timeline-bar")!;
    expect(bar).toHaveAttribute("tabindex", "0");
    fireEvent.focus(bar);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("开始日期：2026-11-10");
    fireEvent.blur(bar);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  });

  it("只有开始日期：提示「仅开始」", async () => {
    await renderWith([order({ plannedStartDate: "2026-11-12", plannedDeliveryDate: null })]);
    const mark = document.querySelector<HTMLElement>(".timeline-mark.is-planStart")!;
    fireEvent.pointerOver(mark);
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent("仅开始");
    expect(tip).toHaveTextContent("开始日期：2026-11-12");
    expect(tip).not.toHaveTextContent("交付日期");
  });

  it("只有交付日期：提示「仅交付」", async () => {
    await renderWith([order({ plannedStartDate: null, plannedDeliveryDate: "2026-11-16" })]);
    const mark = document.querySelector<HTMLElement>(".timeline-mark.is-delivery")!;
    fireEvent.pointerOver(mark);
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent("仅交付");
    expect(tip).toHaveTextContent("交付日期：2026-11-16");
    expect(tip).not.toHaveTextContent("开始日期");
  });

  it("同一天：提示「单日排期」且只出现一个日期", async () => {
    await renderWith([order({ plannedStartDate: "2026-11-15", plannedDeliveryDate: "2026-11-15" })]);
    const bar = document.querySelector<HTMLElement>(".timeline-bar.is-single")!;
    fireEvent.pointerOver(bar);
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent("2026-11-15");
    expect(tip).toHaveTextContent("单日排期");
    expect(tip.textContent!.match(/2026-11-15/g)).toHaveLength(1);
  });

  it("部分超出窗口：提示仍是完整原始起止日期", async () => {
    await renderWith([order({ plannedStartDate: "2026-08-01", plannedDeliveryDate: "2026-09-10" })]);
    const bar = document.querySelector<HTMLElement>(".timeline-bar")!;
    expect(bar).toHaveAttribute("data-clip", "left");
    fireEvent.pointerOver(bar);
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent("开始日期：2026-08-01");
    expect(tip).toHaveTextContent("交付日期：2026-09-10");
  });

  it("已结束订单同样给出日期提示", async () => {
    const user = userEvent.setup();
    // 留一条活动订单，否则时间线会整体进入「活动订单已全部结束」空状态、没有轨道
    await renderWith([
      order({ id: "active-1", code: "AF-2026-0001" }),
      order({
        id: "done-1",
        code: "AF-2026-0002",
        status: "complete",
        plannedStartDate: "2026-11-01",
        plannedDeliveryDate: "2026-11-05",
      }),
    ]);
    await user.click(screen.getByRole("checkbox", { name: "显示已结束" }));
    const terminalRow = document.querySelector<HTMLElement>('.timeline-row[data-order-id="done-1"]')!;
    const bar = terminalRow.querySelector<HTMLElement>(".timeline-bar")!;
    expect(terminalRow.className).toContain("is-terminal");
    fireEvent.pointerOver(bar);
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent("开始日期：2026-11-01");
    expect(tip).toHaveTextContent("交付日期：2026-11-05");
  });

  it("完全未排期订单：轨道上没有图形，也不会有日期提示", async () => {
    await renderWith([
      order({ id: "active-1", code: "AF-2026-0001" }),
      order({
        id: "none-1",
        code: "AF-2026-0003",
        title: "两个日期都没有",
        plannedStartDate: null,
        plannedDeliveryDate: null,
      }),
    ]);
    // 只有那条有日期的订单画了图形
    expect(document.querySelectorAll(".timeline-row")).toHaveLength(1);
    const unscheduled = document.querySelector(".timeline-unscheduled")!;
    expect(unscheduled.textContent).toContain("AF-2026-0003");
    // 未排期区里没有任何可悬浮的排期图形
    expect(unscheduled.querySelector(".timeline-bar, .timeline-mark")).toBeNull();
    expect(unscheduled.querySelector("[aria-label*='排期']")).toBeNull();
  });

  it("悬浮提示不会阻断点击：条上点击仍进入订单详情", async () => {
    const user = userEvent.setup();
    await renderWith([order({ id: "click-target" })]);
    const bar = document.querySelector<HTMLElement>(".timeline-bar")!;
    fireEvent.pointerOver(bar);
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    await user.click(bar);
    await waitFor(() => expect(screen.getByTestId("order-probe")).toHaveTextContent("click-target"));
  });

  it("横向滚动时收起提示，避免 fixed 坐标残留", async () => {
    await renderWith([order()]);
    const bar = document.querySelector<HTMLElement>(".timeline-bar")!;
    fireEvent.pointerOver(bar);
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    fireEvent.scroll(document.querySelector(".timeline-scroll")!);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  });
});

// ---------------------------------------------------------------- ISSUE-02

describe("ISSUE-02 周视图范围", () => {
  it("周窗口 2026-10-26 ~ 2027-01-17，84 天、12 个周一刻度，末周起 01-11", async () => {
    const user = userEvent.setup();
    await renderWith([order()]);
    await user.click(screen.getByRole("button", { name: "周" }));

    expect(rangeText()).toContain("窗口 2026-10-26 ~ 2027-01-17");
    expect(rangeText()).toContain("末周起 2027-01-11");

    const ticks = [...document.querySelectorAll(".timeline-tier-2 .timeline-tick")];
    expect(ticks).toHaveLength(12);
    expect(ticks[0]!.textContent).toBe("10-26");
    expect(ticks[ticks.length - 1]!.textContent).toBe("01-11");

    // 画布覆盖到窗口最后一天 01-17：84 天 × 26px
    expect(screen.getByTestId("timeline-canvas").style.width).toBe("2184px");
  });

  it("周一刻度逐条落在整周边界上（每条宽度 7 天，末周 6 天）", async () => {
    const user = userEvent.setup();
    await renderWith([order()]);
    await user.click(screen.getByRole("button", { name: "周" }));
    const ticks = [...document.querySelectorAll<HTMLElement>(".timeline-tier-2 .timeline-tick")];
    const widths = ticks.map((t) => t.style.width);
    expect(widths.every((w) => w === "182px")).toBe(true); // 7 × 26
    // 末周从 01-11 起算到 01-18（半开区间），右端正好落在画布终点 2184px：
    // 所以视觉上最后一周覆盖 01-11 ~ 01-17，不会多画出一天。
    const last = ticks[ticks.length - 1]!;
    expect(parseFloat(last.style.left) + parseFloat(last.style.width)).toBe(2184);
  });

  it("日 / 月 / 年窗口不受影响", async () => {
    const user = userEvent.setup();
    await renderWith([order()]);
    expect(rangeText()).toContain("窗口 2026-09-01 ~ 2027-09-30");

    await user.click(screen.getByRole("button", { name: "日" }));
    expect(rangeText()).toContain("窗口 2026-11-11 ~ 2026-12-01");

    await user.click(screen.getByRole("button", { name: "年" }));
    expect(rangeText()).toContain("窗口 2025-01-01 ~ 2030-12-31");
    // 非周尺度不带末周刻度文案
    expect(rangeText()).not.toContain("末周起");
  });
});
