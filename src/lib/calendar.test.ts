import { describe, expect, it } from "vitest";

import type { OrderView } from "../bridge/commands";
import { civilFromDays, parseDayKey } from "./scheduleBar";
import {
  ROW_MIN_H,
  dominantMonthDay,
  monthGridMetrics,
  weekGridMetrics,
  weeksInMonth,
} from "./calendar";
import {
  LANES,
  MONTH_CELLS,
  canReschedule,
  compareForLanes,
  compareUnscheduled,
  dropPlan,
  isSameMonth,
  layoutWeek,
  monthMatrix,
  monthTitle,
  orderSpan,
  rescheduleInput,
  shiftMonth,
  shiftWeek,
  weekDays,
  weekStartOf,
  weekTitle,
} from "./calendar";

function day(iso: string): number {
  const key = parseDayKey(iso);
  if (key === null) throw new Error(`bad date ${iso}`);
  return key;
}

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
    note: "备注",
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
    revision: 3,
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

describe("网格", () => {
  it("月视图固定 42 格，从当月 1 号所在周的周一开始", () => {
    const cells = monthMatrix(day("2026-11-18"));
    expect(cells).toHaveLength(MONTH_CELLS);
    expect(cells[0]).toBe(day("2026-10-26")); // 2026-11-01 是周日 → 前一周周一
    expect(cells[41]).toBe(day("2026-12-06"));
    expect(cells.filter((d) => isSameMonth(d, day("2026-11-18")))).toHaveLength(30);
  });

  it("闰年 2 月与跨年都只影响格子内容，不改变 42 格", () => {
    const leap = monthMatrix(day("2028-02-10"));
    expect(leap).toHaveLength(42);
    expect(leap.filter((d) => isSameMonth(d, day("2028-02-10")))).toHaveLength(29);

    const dec = monthMatrix(day("2026-12-31"));
    expect(dec.filter((d) => isSameMonth(d, day("2026-12-31")))).toHaveLength(31);
    expect(dec[41]).toBeGreaterThan(day("2026-12-31"));
  });

  it("周起始固定周一", () => {
    expect(weekStartOf(day("2026-11-18"))).toBe(day("2026-11-16"));
    expect(weekStartOf(day("2026-11-16"))).toBe(day("2026-11-16"));
    expect(weekDays(day("2026-11-18"))).toEqual([
      day("2026-11-16"),
      day("2026-11-17"),
      day("2026-11-18"),
      day("2026-11-19"),
      day("2026-11-20"),
      day("2026-11-21"),
      day("2026-11-22"),
    ]);
  });

  it("月份位移夹取月末，不溢出到下个月", () => {
    expect(monthTitle(shiftMonth(day("2026-01-31"), 1))).toBe("2026 年 2 月");
    expect(shiftMonth(day("2026-01-31"), 1)).toBe(day("2026-02-28"));
    expect(shiftMonth(day("2028-01-31"), 1)).toBe(day("2028-02-29"));
    expect(shiftMonth(day("2026-12-15"), 1)).toBe(day("2027-01-15"));
    expect(shiftMonth(day("2026-01-15"), -1)).toBe(day("2025-12-15"));
    expect(shiftWeek(day("2026-11-18"), -1)).toBe(day("2026-11-11"));
  });

  it("标题文案", () => {
    expect(monthTitle(day("2026-11-18"))).toBe("2026 年 11 月");
    expect(weekTitle(day("2026-11-18"))).toBe("2026-11-16 ~ 2026-11-22");
  });
});

describe("订单区间", () => {
  it("四种日期形状", () => {
    expect(orderSpan(order())).toEqual({
      from: day("2026-11-10"),
      to: day("2026-11-14"),
      kind: "range",
    });
    expect(orderSpan(order({ plannedDeliveryDate: "2026-11-10" }))?.kind).toBe("single");
    expect(orderSpan(order({ plannedDeliveryDate: null }))).toEqual({
      from: day("2026-11-10"),
      to: day("2026-11-10"),
      kind: "startOnly",
    });
    expect(orderSpan(order({ plannedStartDate: null }))?.kind).toBe("deliveryOnly");
    expect(orderSpan(order({ plannedStartDate: null, plannedDeliveryDate: null }))).toBeNull();
  });

  it("终态不可改期", () => {
    expect(canReschedule(order())).toBe(true);
    expect(canReschedule(order({ status: "complete" }))).toBe(false);
    expect(canReschedule(order({ status: "cancelled" }))).toBe(false);
  });
});

describe("轨道分配", () => {
  const ws = day("2026-11-16");

  it("同一天多个订单按最早交付、再按编号占不同轨道", () => {
    const a = order({ id: "a", code: "AF-0003", plannedStartDate: "2026-11-17", plannedDeliveryDate: "2026-11-17" });
    const b = order({ id: "b", code: "AF-0001", plannedStartDate: "2026-11-17", plannedDeliveryDate: "2026-11-17" });
    const c = order({ id: "c", code: "AF-0002", plannedStartDate: "2026-11-17", plannedDeliveryDate: "2026-11-17" });
    const layout = layoutWeek([a, b, c], ws, LANES.month);
    expect(layout.segments.map((s) => [s.order.code, s.lane])).toEqual([
      ["AF-0001", 0],
      ["AF-0002", 1],
      ["AF-0003", 2],
    ]);
    expect(layout.hidden.size).toBe(0);
  });

  it("重叠区间不共用轨道，不重叠的可复用", () => {
    const a = order({ id: "a", plannedStartDate: "2026-11-16", plannedDeliveryDate: "2026-11-18" });
    const b = order({ id: "b", code: "AF-0002", plannedStartDate: "2026-11-18", plannedDeliveryDate: "2026-11-20" });
    const c = order({ id: "c", code: "AF-0003", plannedStartDate: "2026-11-19", plannedDeliveryDate: "2026-11-21" });
    const layout = layoutWeek([a, b, c], ws, LANES.month);
    const byId = Object.fromEntries(layout.segments.map((s) => [s.order.id, s.lane]));
    expect(byId.a!).toBe(0);
    expect(byId.b!).toBe(1); // 与 a 在 11-18 重叠
    expect(byId.c!).toBe(0); // 11-19 起 a 已结束
  });

  it("跨周订单在下一周重新分配轨道，并标记延续段", () => {
    const long = order({
      id: "long",
      plannedStartDate: "2026-11-10",
      plannedDeliveryDate: "2026-11-24",
    });
    const thisWeek = layoutWeek([long], ws, LANES.week);
    expect(thisWeek.segments[0]!.clippedLeft).toBe(true);
    expect(thisWeek.segments[0]!.colStart).toBe(0);
    expect(thisWeek.segments[0]!.colEnd).toBe(6);

    const nextWeek = layoutWeek([long], ws + 7, LANES.week);
    expect(nextWeek.segments[0]!.clippedLeft).toBe(true); // 起点在上一周
    expect(nextWeek.segments[0]!.clippedRight).toBe(false); // 11-24 落在这周内
    expect(nextWeek.segments[0]!.colStart).toBe(0);
    expect(nextWeek.segments[0]!.colEnd).toBe(1); // 11-23、11-24
  });

  it("超出 3 条轨道进入折叠，同一订单同一天只计数一次", () => {
    const orders = ["01", "02", "03", "04"].map((n, i) =>
      order({
        id: `o${n}`,
        code: `AF-000${n}`,
        plannedStartDate: "2026-11-18",
        plannedDeliveryDate: "2026-11-19",
        createdAt: `2026-11-0${i + 1}T00:00:00.000Z`,
      }),
    );
    const layout = layoutWeek(orders, ws, LANES.month);
    expect(layout.segments).toHaveLength(3);
    const day18 = layout.hidden.get(day("2026-11-18")) ?? [];
    const day19 = layout.hidden.get(day("2026-11-19")) ?? [];
    expect(day18).toHaveLength(1);
    expect(day19).toHaveLength(1);
    expect(day18[0]!.id).toBe(day19[0]!.id);
  });

  it("周视图上限 6，月视图上限 3", () => {
    const orders = Array.from({ length: 8 }, (_, i) =>
      order({
        id: `o${i}`,
        code: `AF-100${i}`,
        plannedStartDate: "2026-11-18",
        plannedDeliveryDate: "2026-11-18",
      }),
    );
    expect(layoutWeek(orders, ws, LANES.month).segments).toHaveLength(3);
    expect(layoutWeek(orders, ws, LANES.week).segments).toHaveLength(6);
  });

  it("活动订单永远排在终态之前，终态不能挤掉活动", () => {
    const terminal = order({
      id: "done",
      code: "AF-0001",
      status: "complete",
      plannedStartDate: "2026-11-16",
      plannedDeliveryDate: "2026-11-16",
    });
    const active = order({
      id: "act",
      code: "AF-9999",
      plannedStartDate: "2026-11-16",
      plannedDeliveryDate: "2026-11-16",
    });
    expect(compareForLanes(active, terminal)).toBeLessThan(0);
    const layout = layoutWeek([terminal, active], ws, 1);
    expect(layout.segments[0]!.order.id).toBe("act");
    expect(layout.hidden.get(day("2026-11-16"))?.[0]?.id).toBe("done");
  });

  it("单端与单日订单各占一条轨道", () => {
    const startOnly = order({
      id: "s",
      code: "AF-0001",
      plannedDeliveryDate: null,
      plannedStartDate: "2026-11-17",
    });
    const single = order({
      id: "d",
      code: "AF-0002",
      plannedStartDate: "2026-11-17",
      plannedDeliveryDate: "2026-11-17",
    });
    const layout = layoutWeek([startOnly, single], ws, LANES.month);
    expect(layout.segments.map((s) => s.kind)).toEqual(["startOnly", "single"]);
    expect(new Set(layout.segments.map((s) => s.lane)).size).toBe(2);
  });

  it("未排期订单不进入网格", () => {
    const empty = order({ id: "e", plannedStartDate: null, plannedDeliveryDate: null });
    expect(layoutWeek([empty], ws, LANES.month).segments).toHaveLength(0);
  });
});

describe("拖放计划", () => {
  it("单日订单整体移动，保持同日", () => {
    const o = order({ plannedStartDate: "2026-11-10", plannedDeliveryDate: "2026-11-10" });
    const plan = dropPlan(o, day("2026-11-20"), "single");
    expect(plan).toEqual({ ok: true, start: "2026-11-20", delivery: "2026-11-20", unchanged: false });
  });

  it("区间订单整体平移，保留天数", () => {
    const o = order({ plannedStartDate: "2026-11-10", plannedDeliveryDate: "2026-11-14" });
    const plan = dropPlan(o, day("2026-11-20"), "move");
    expect(plan).toMatchObject({ ok: true, start: "2026-11-20", delivery: "2026-11-24" });
  });

  it("只改端点，不补另一端", () => {
    const range = order({ plannedStartDate: "2026-11-10", plannedDeliveryDate: "2026-11-14" });
    expect(dropPlan(range, day("2026-11-12"), "start")).toMatchObject({
      ok: true,
      start: "2026-11-12",
      delivery: "2026-11-14",
    });
    expect(dropPlan(range, day("2026-11-20"), "delivery")).toMatchObject({
      ok: true,
      start: "2026-11-10",
      delivery: "2026-11-20",
    });

    const startOnly = order({ plannedStartDate: "2026-11-10", plannedDeliveryDate: null });
    expect(dropPlan(startOnly, day("2026-11-12"), "start")).toMatchObject({ ok: true, start: "2026-11-12", delivery: null });
    expect(dropPlan(startOnly, day("2026-11-12"), "delivery")).toMatchObject({ ok: false });

    const deliveryOnly = order({ plannedStartDate: null, plannedDeliveryDate: "2026-11-20" });
    expect(dropPlan(deliveryOnly, day("2026-11-22"), "delivery")).toMatchObject({ ok: true, start: null, delivery: "2026-11-22" });
    expect(dropPlan(deliveryOnly, day("2026-11-22"), "start")).toMatchObject({ ok: false });
  });

  it("未排期订单必须指定写哪一端", () => {
    const empty = order({ plannedStartDate: null, plannedDeliveryDate: null });
    expect(dropPlan(empty, day("2026-11-20"), "unscheduled")).toMatchObject({ ok: false });
    expect(dropPlan(empty, day("2026-11-20"), "unscheduled", "start")).toMatchObject({
      ok: true,
      start: "2026-11-20",
      delivery: null,
    });
    expect(dropPlan(empty, day("2026-11-20"), "unscheduled", "delivery")).toMatchObject({
      ok: true,
      start: null,
      delivery: "2026-11-20",
    });
  });

  it("开始晚于交付被拒绝，同日允许", () => {
    const o = order({ plannedStartDate: "2026-11-10", plannedDeliveryDate: "2026-11-14" });
    expect(dropPlan(o, day("2026-11-20"), "start")).toMatchObject({ ok: false });
    expect(dropPlan(o, day("2026-11-09"), "delivery")).toMatchObject({ ok: false });
    // 开始=交付 是合法的单日排期
    expect(dropPlan(o, day("2026-11-10"), "delivery")).toMatchObject({
      ok: true,
      start: "2026-11-10",
      delivery: "2026-11-10",
    });
  });

  it("终态订单不可拖动", () => {
    const done = order({ status: "complete" });
    expect(dropPlan(done, day("2026-11-20"), "move")).toMatchObject({ ok: false });
  });

  it("拖到原日期是未变化", () => {
    const o = order({ plannedStartDate: "2026-11-10", plannedDeliveryDate: "2026-11-14" });
    expect(dropPlan(o, day("2026-11-10"), "start")).toMatchObject({ ok: true, unchanged: true });
  });
});

describe("整单回填入参", () => {
  it("只改日期时其余字段全部原样带回", () => {
    const o = order();
    const input = rescheduleInput(o, { start: "2026-11-11", delivery: "2026-11-15" }, "calendar", " 客户延期 ");
    expect(input).toEqual({
      orderId: o.id,
      expectedRevision: 3,
      title: "测试订单",
      clientId: "c1",
      commissionType: "半身立绘",
      source: "画加",
      amountCents: 88000,
      plannedStartDate: "2026-11-11",
      plannedDeliveryDate: "2026-11-15",
      note: "备注",
      changeSource: "calendar",
      reason: "客户延期",
    });
  });

  it("空原因归一为 null，来源透传", () => {
    const input = rescheduleInput(order(), { start: null, delivery: null }, "order_details", "   ");
    expect(input.reason).toBeNull();
    expect(input.changeSource).toBe("order_details");
    expect(input.plannedStartDate).toBeNull();
  });
});

describe("未排期池排序", () => {
  it("按创建时间升序，再按编号", () => {
    const a = order({ id: "a", code: "AF-0002", createdAt: "2026-11-02T00:00:00.000Z" });
    const b = order({ id: "b", code: "AF-0001", createdAt: "2026-11-01T00:00:00.000Z" });
    const c = order({ id: "c", code: "AF-0000", createdAt: "2026-11-02T00:00:00.000Z" });
    expect([a, b, c].sort(compareUnscheduled).map((o) => o.id)).toEqual(["b", "c", "a"]);
  });
});

describe("月视图网格度量", () => {
  it("窗口变高行高变大，窗口变矮行高变小（没有最小行高挡路）", () => {
    const short = monthGridMetrics(300, 6);
    const tall = monthGridMetrics(900, 6);
    expect(short.rowH).toBeLessThan(tall.rowH);
    expect(tall.rowH).toBeGreaterThan(120);
    // 900 / 6 = 150 的预算，扣掉分隔线后应接近 149
    expect(Math.abs(tall.rowH - 149)).toBeLessThanOrEqual(2);
  });

  it("按当月实际周数均分：4 周月比 6 周月行更高", () => {
    const four = monthGridMetrics(720, 4);
    const six = monthGridMetrics(720, 6);
    expect(four.rowH).toBeGreaterThan(six.rowH);
  });

  it("整月高度不超过可视高度（不产生纵向滚动条）", () => {
    for (const available of [280, 380, 520, 720, 1000]) {
      for (const weeks of [4, 5, 6]) {
        const m = monthGridMetrics(available, weeks);
        // 每行还有 1px 分隔线
        expect(m.rowH * weeks + weeks).toBeLessThanOrEqual(available + 1);
      }
    }
  });

  it("行高等于三段之和，轨道数随行高降级", () => {
    for (const available of [0, 260, 400, 620, 900, 1400]) {
      const m = monthGridMetrics(available, 6);
      expect(m.rowH).toBe(m.numH + m.laneH * m.lanes + m.moreH);
      expect(m.lanes).toBeGreaterThanOrEqual(1);
      // 轨道数不再写死 3：空间够就更多，最多 6
      expect(m.lanes).toBeLessThanOrEqual(6);
      expect(m.chipH).toBeLessThanOrEqual(m.laneH);
    }
    expect(monthGridMetrics(1600, 4).lanes).toBeGreaterThan(3);
    expect(monthGridMetrics(300, 6).lanes).toBe(1);
  });

  it("极端矮窗口也不会低于可读下限", () => {
    const m = monthGridMetrics(120, 6);
    expect(m.rowH).toBeGreaterThanOrEqual(ROW_MIN_H);
  });

  it("周视图度量与月视图解耦", () => {
    const week = weekGridMetrics();
    expect(week.lanes).toBeGreaterThanOrEqual(3);
    expect(week.rowH).toBe(week.numH + week.laneH * week.lanes + week.moreH);
  });
});

describe("当月周数", () => {
  it("2026 年 11 月是 6 周（11-01 是周日，首周从 10-26 起算）", () => {
    expect(weeksInMonth(day("2026-11-19"))).toBe(6);
  });

  it("2026 年 12 月与 2027 年 1 月都能算", () => {
    expect(weeksInMonth(day("2026-12-01"))).toBeGreaterThanOrEqual(4);
    expect(weeksInMonth(day("2027-01-15"))).toBeGreaterThanOrEqual(4);
  });

  it("2026 年 2 月是 5 周", () => {
    expect(weeksInMonth(day("2026-02-10"))).toBe(5);
  });
});

describe("月份归属投票", () => {
  const row = (...days: number[]) => days;

  it("11 月末那一周里有 1 天属于 12 月时，整行仍算 11 月", () => {
    const nov30 = day("2026-11-30");
    const rows = [
      row(nov30 - 7, ...Array.from({ length: 6 }, (_, i) => nov30 - 7 + 1 + i)),
      row(nov30, ...Array.from({ length: 6 }, (_, i) => nov30 + 1 + i)),
    ];
    // 第一行整体是 11 月，第二行是 6 天 12 月 + 1 天 11 月 → 1:1 平票取更早的行
    const winner = dominantMonthDay(rows);
    expect(winner).not.toBeNull();
    expect(civilFromDays(winner!).month).toBe(11);
  });

  it("整屏都是下个月时才会切到下个月", () => {
    const dec7 = day("2026-12-07");
    const rows = [0, 1, 2].map((i) => Array.from({ length: 7 }, (_, c) => dec7 + i * 7 + c));
    const winner = dominantMonthDay(rows);
    expect(civilFromDays(winner!).month).toBe(12);
  });

  it("跨年：12 月与次年 1 月各自独立计票", () => {
    const jan4 = day("2027-01-04");
    const rows = [0, 1].map((i) => Array.from({ length: 7 }, (_, c) => jan4 + i * 7 + c));
    expect(civilFromDays(dominantMonthDay(rows)!).year).toBe(2027);
  });

  it("没有任何可见行时返回 null", () => {
    expect(dominantMonthDay([])).toBeNull();
  });
});
