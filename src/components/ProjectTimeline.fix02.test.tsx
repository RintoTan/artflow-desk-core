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

  it("信息列（编号/标题）单击只选中，双击才进详情", async () => {
    const user = userEvent.setup();
    await renderWith([order({ id: "info-target", code: "AF-2026-0200", title: "标题也可点" })]);

    const info = document.querySelector<HTMLElement>(".timeline-info")!;
    await user.click(info);
    expect(info).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByTestId("order-probe")).toBeNull();

    await user.dblClick(info);
    await waitFor(() =>
      expect(screen.getByTestId("order-probe")).toHaveTextContent("info-target"),
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
    // 12 个月窗口从 2026-05-01 起：开始早于窗口、交付在窗口内，验证左侧裁切。
    await renderWith([order({ plannedStartDate: "2026-04-01", plannedDeliveryDate: "2026-06-10" })]);
    const bar = document.querySelector<HTMLElement>(".timeline-bar")!;
    expect(bar).toHaveAttribute("data-clip", "left");
    fireEvent.pointerOver(bar);
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent("开始日期：2026-04-01");
    expect(tip).toHaveTextContent("交付日期：2026-06-10");
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

  it("悬浮提示不会吞掉双击：条上双击仍进入订单详情", async () => {
    const user = userEvent.setup();
    await renderWith([order({ id: "click-target" })]);
    const bar = document.querySelector<HTMLElement>(".timeline-bar")!;
    fireEvent.pointerOver(bar);
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    await user.dblClick(bar);
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

const spanDaysOf = (text: string) => {
  const m = /窗口 (\d{4}-\d{2}-\d{2}) ~ (\d{4}-\d{2}-\d{2})/.exec(text);
  if (m === null) throw new Error(`没有窗口文案：${text}`);
  return (Date.parse(`${m[2]}T00:00:00Z`) - Date.parse(`${m[1]}T00:00:00Z`)) / 86400000 + 1;
};

describe("WB-01 视图与缩放", () => {
  it("周视图可切换，并保留自己的跨度档位", async () => {
    const user = userEvent.setup();
    await renderWith([order()]);
    await user.click(screen.getByRole("button", { name: "周" }));
    expect(rangeText()).toContain("周");
    // 周默认 8 周；放大一次到 4 周
    await user.click(screen.getByRole("button", { name: "放大跨度" }));
    expect(rangeText()).toMatch(/窗口/);
  });

  it("缩放只改当前视图的跨度，到边界禁用", async () => {
    const user = userEvent.setup();
    await renderWith([order()]);

    await user.click(screen.getByRole("button", { name: "日" }));
    expect(spanDaysOf(rangeText())).toBe(30);

    // 「放大」= 看更细 = 跨度变小（14 天）
    await user.click(screen.getByRole("button", { name: "放大跨度" }));
    expect(spanDaysOf(rangeText())).toBe(14);
    expect(screen.getByRole("button", { name: "放大跨度" })).toBeDisabled();

    // 「缩小」= 看更多日期 = 跨度变大（60 天）
    await user.click(screen.getByRole("button", { name: "缩小跨度" }));
    await user.click(screen.getByRole("button", { name: "缩小跨度" }));
    expect(spanDaysOf(rangeText())).toBe(60);
    expect(screen.getByRole("button", { name: "缩小跨度" })).toBeDisabled();
  });

  it("切视图后仍停在原视图的跨度上，不串档", async () => {
    const user = userEvent.setup();
    await renderWith([order()]);

    await user.click(screen.getByRole("button", { name: "日" }));
    await user.click(screen.getByRole("button", { name: "缩小跨度" }));
    expect(spanDaysOf(rangeText())).toBe(60);

    await user.click(screen.getByRole("button", { name: "月" }));
    expect(rangeText()).toContain("月");

    await user.click(screen.getByRole("button", { name: "日" }));
    expect(spanDaysOf(rangeText())).toBe(60);
  });
});

describe("WB-01 年视图与归档", () => {
  it("年视图里短到不足 6px 的订单改画圆点，仍可聚焦并带排期说明", async () => {
    const user = userEvent.setup();
    await renderWith([
      order({ id: "id-short", code: "AF-2026-0101", plannedStartDate: "2026-06-01", plannedDeliveryDate: "2026-06-03" }),
    ]);
    await user.click(screen.getByRole("button", { name: "年" }));

    const dot = document.querySelector<HTMLElement>(".timeline-dot");
    expect(dot).not.toBeNull();
    expect(document.querySelector(".timeline-bar")).toBeNull();
    expect(dot).toHaveAttribute("tabindex", "0");
    expect(dot!.getAttribute("aria-label")).toContain("2026-06-01");
  });

  it("年视图里的长排期仍然画成条，不误降级为圆点", async () => {
    const user = userEvent.setup();
    await renderWith([
      order({ id: "id-long", code: "AF-2026-0102", plannedStartDate: "2025-03-01", plannedDeliveryDate: "2027-09-30" }),
    ]);
    await user.click(screen.getByRole("button", { name: "年" }));

    expect(document.querySelector(".timeline-bar")).not.toBeNull();
    expect(document.querySelector(".timeline-dot")).toBeNull();
  });

  it("归档订单照常出现在时间线上（归档只影响订单信息页的列表归属）", async () => {
    await renderWith([
      order({
        id: "id-arch",
        code: "AF-2026-0103",
        archivedAt: "2026-11-20T00:00:00+08:00",
        plannedStartDate: "2026-11-10",
        plannedDeliveryDate: "2026-11-20",
      }),
    ]);
    expect(screen.getAllByText("AF-2026-0103").length).toBeGreaterThan(0);
  });
});

describe("WB-02 视图切换与拖动平移", () => {
  const winOf = () => {
    const m = /窗口 (\d{4}-\d{2}-\d{2}) ~ (\d{4}-\d{2}-\d{2})/.exec(rangeText());
    expect(m).not.toBeNull();
    return { from: m![1]!, to: m![2]! };
  };
  const dayNum = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86400000;


  it("切换视图后保留切换前的窗口中心日期", async () => {
    const user = userEvent.setup();
    await renderWith([order()]);

    const month = winOf();
    const center = Math.round((dayNum(month.from) + dayNum(month.to)) / 2);

    await user.click(screen.getByRole("button", { name: "周" }));
    const week = winOf();
    // 判据是「实际中心」而不是「旧日期仍在窗口内」
    const weekCenter = (dayNum(week.from) + dayNum(week.to)) / 2;
    expect(Math.abs(weekCenter - center)).toBeLessThanOrEqual(1);
  });

  it("缩放时保留窗口中心，不跳回今天", async () => {
    const user = userEvent.setup();
    await renderWith([order()]);
    await user.click(screen.getByRole("button", { name: "月" }));

    const before = winOf();
    const center = Math.round((dayNum(before.from) + dayNum(before.to)) / 2);

    await user.click(screen.getByRole("button", { name: "放大跨度" }));
    const after = winOf();
    const afterCenter = (dayNum(after.from) + dayNum(after.to)) / 2;
    expect(Math.abs(afterCenter - center)).toBeLessThanOrEqual(1);
    expect(after.from).not.toBe(before.from);
  });


})

describe("WB-02 拖动平移与中心复核", () => {
  const winOf = () => {
    const m = /窗口 (\d{4}-\d{2}-\d{2}) ~ (\d{4}-\d{2}-\d{2})/.exec(rangeText());
    expect(m).not.toBeNull();
    return { from: m![1]!, to: m![2]! };
  };
  const dayNum = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86400000;

  it("月 → 日：今天仍在窗口中央（不是只落在窗口内）", async () => {
    const user = userEvent.setup();
    await renderWith([order()]);

    const month = winOf();
    const center = Math.round((dayNum(month.from) + dayNum(month.to)) / 2);

    await user.click(screen.getByRole("button", { name: "日" }));
    const day = winOf();
    const dayCenter = (dayNum(day.from) + dayNum(day.to)) / 2;

    expect(Math.abs(dayCenter - center)).toBeLessThanOrEqual(1);
  });

  it("向左拖动：窗口整体后移，且不触发订单选中或跳转", async () => {
    await renderWith([order()]);
    const before = winOf();
    const track = document.querySelector(".timeline-scroll")!;

    fireEvent.mouseDown(track, { clientX: 500, button: 0 });
    fireEvent.mouseMove(track, { clientX: 440, button: 0 });
    fireEvent.mouseUp(track, { clientX: 440, button: 0 });

    const after = winOf();
    expect(dayNum(after.from)).toBeGreaterThan(dayNum(before.from));
    expect(document.querySelector(".timeline-row")!.getAttribute("aria-selected")).not.toBe("true");
    expect(screen.queryByTestId("order-probe")).toBeNull();
  });

  it("移动未超过阈值不改变窗口", async () => {
    await renderWith([order()]);
    const before = winOf();
    const track = document.querySelector(".timeline-scroll")!;

    fireEvent.mouseDown(track, { clientX: 500, button: 0 });
    fireEvent.mouseMove(track, { clientX: 503, button: 0 });
    fireEvent.mouseUp(track, { clientX: 503, button: 0 });

    expect(winOf().from).toBe(before.from);
  });

  it("刷新是工具栏里的图标按钮，不再单独占一行", async () => {
    await renderWith([order()]);
    const refresh = screen.getByRole("button", { name: "刷新" });
    expect(refresh).toHaveAttribute("title", "刷新");
    expect(refresh.closest(".timeline-controls")).not.toBeNull();
  });

  it("月 → 日之后，今天仍停在窗口中部（相对位置不漂）", async () => {
    const user = userEvent.setup();
    await renderWith([order()]);

    const today = Date.parse("2026-11-18T00:00:00Z") / 86400000;
    const ratioOf = (w: { from: string; to: string }) => {
      const from = Date.parse(`${w.from}T00:00:00Z`) / 86400000;
      const to = Date.parse(`${w.to}T00:00:00Z`) / 86400000;
      return (today - from) / (to - from + 1);
    };

    const before = ratioOf(winOf());
    await user.click(screen.getByRole("button", { name: "日" }));
    const after = ratioOf(winOf());

    expect(before).toBeGreaterThan(0.3);
    expect(before).toBeLessThan(0.7);
    expect(Math.abs(after - before)).toBeLessThan(0.06);
  });
});
