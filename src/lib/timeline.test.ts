import { describe, expect, it } from "vitest";

import type { OrderView } from "../bridge/commands";
import { daysFromCivil, parseDayKey } from "./scheduleBar";
import {
  SCALE_CONFIG,
  addMonthsClamped,
  buildTicks,
  canvasWidth,
  dayToX,
  rowGeometry,
  shiftAnchor,
  splitOrders,
  timelineWindow,
  visibleRange,
  type TimelineScale,
} from "./timeline";

const TZ = "Asia/Shanghai";
/** 2026-11-18 是周三；固定锚点让窗口断言可复现。 */
const TODAY = daysFromCivil(2026, 11, 18);

function order(overrides: Partial<OrderView> = {}): OrderView {
  return {
    id: "o1",
    code: "AF-2026-0001",
    title: "测试订单",
    clientId: null,
    clientName: null,
    commissionType: null,
    stageTemplateId: "tpl-a",
    source: null,
    amountCents: null,
    note: null,
    status: "active",
    workState: "queued",
    currentStageId: "draft",
    currentStageTitle: "草稿",
    currentStageIndex: 0,
    stageCount: 2,
    stages: [],
    queuePosition: 0,
    plannedStartDate: null,
    plannedDeliveryDate: null,
    deadlineState: "scheduled",
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

function key(index: number): string {
  const c = (() => {
    let z = index + 719468;
    const era = Math.floor(z / 146097);
    const doe = z - era * 146097;
    const yoe = Math.floor(
      (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
    );
    const y = yoe + era * 400;
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
    const month = mp + (mp < 10 ? 3 : -9);
    return { year: y + (month <= 2 ? 1 : 0), month, day };
  })();
  return `${String(c.year).padStart(4, "0")}-${String(c.month).padStart(2, "0")}-${String(c.day).padStart(2, "0")}`;
}

describe("timelineWindow", () => {
  it("日尺度：前 7 天到后 13 天，共 21 天", () => {
    const win = timelineWindow("day", TODAY);
    expect(key(win.from)).toBe("2026-11-11");
    expect(key(win.to)).toBe("2026-12-01");
    expect(win.to - win.from + 1).toBe(21);
  });

  it("月尺度：自然月首尾对齐，含 13 个月", () => {
    const win = timelineWindow("month", TODAY);
    expect(key(win.from)).toBe("2026-09-01");
    expect(key(win.to)).toBe("2027-09-30");
    const ticks = buildTicks(win, "month", TODAY);
    expect(ticks.tier2).toHaveLength(13);
    expect(win.from <= TODAY && TODAY <= win.to).toBe(true);
  });

  it("年尺度：自然年对齐，2025→2030", () => {
    const win = timelineWindow("year", TODAY);
    expect(key(win.from)).toBe("2025-01-01");
    expect(key(win.to)).toBe("2030-12-31");
    expect(buildTicks(win, "year", TODAY).tier2.length).toBeLessThanOrEqual(24);
  });
});

describe("shiftAnchor", () => {
  it("日尺度按 7 天移动", () => {
    expect(shiftAnchor("day", TODAY, 1) - TODAY).toBe(7);
    expect(shiftAnchor("day", TODAY, -1) - TODAY).toBe(-7);
  });

  it("月位移夹到目标月末，不溢出", () => {
    expect(key(shiftAnchor("month", daysFromCivil(2026, 1, 31), 1))).toBe("2026-02-28");
    expect(key(shiftAnchor("month", daysFromCivil(2026, 3, 31), 1))).toBe("2026-04-30");
    expect(key(shiftAnchor("month", daysFromCivil(2024, 1, 31), 1))).toBe("2024-02-29");
  });

  it("闰年 2 月 29 日向后一个月落在 3 月 29 日", () => {
    expect(key(shiftAnchor("month", daysFromCivil(2024, 2, 29), 1))).toBe("2024-03-29");
    expect(key(addMonthsClamped(daysFromCivil(2024, 2, 29), -1))).toBe("2024-01-29");
  });

  it("年位移 12 个月", () => {
    expect(key(shiftAnchor("year", TODAY, 1))).toBe("2027-11-18");
  });
});

describe("日期解析的边界", () => {
  it("非法日期不参与几何", () => {
    expect(parseDayKey("2026-02-30")).toBeNull();
    expect(parseDayKey("2026-13-01")).toBeNull();
    expect(parseDayKey("2026-1-1")).toBeNull();
    expect(parseDayKey("2023-02-29")).toBeNull();
    expect(parseDayKey("1900-02-29")).toBeNull();
    expect(parseDayKey("2024-02-29")).not.toBeNull();
  });

  it("非法日期只留另一端的标记", () => {
    const win = timelineWindow("day", TODAY);
    const geo = rowGeometry(
      order({ plannedStartDate: "2026-02-30", plannedDeliveryDate: "2026-11-18" }),
      win,
      TODAY,
      TZ,
      "day",
    );
    expect(geo.band).toBeNull();
    expect(geo.markers.map((m) => m.kind)).toEqual(["delivery"]);
  });
});

describe("刻度与坐标一致", () => {
  it("第二层刻度左边界从 0 开始，且宽度总和等于画布宽", () => {
    for (const scale of ["day", "month", "year"] as TimelineScale[]) {
      const win = timelineWindow(scale, TODAY);
      const ticks = buildTicks(win, scale, TODAY);
      expect(ticks.tier2[0]!.left).toBe(0);
      const sum = ticks.tier2.reduce((acc, tick) => acc + tick.width, 0);
      expect(Math.abs(sum - canvasWidth(win, scale))).toBeLessThanOrEqual(0.5);
    }
  });

  it("今天的坐标等于所在刻度格的左边界", () => {
    const win = timelineWindow("day", TODAY);
    const ticks = buildTicks(win, "day", TODAY);
    const todayTick = ticks.tier2.find((tick) => tick.isToday);
    expect(todayTick).toBeDefined();
    expect(dayToX(TODAY, win, "day")).toBe(todayTick!.left);
  });

  it("可见范围随滚动位置变化，且不越出窗口", () => {
    const win = timelineWindow("month", TODAY);
    const left = visibleRange(win, "month", 0, 600);
    expect(left.from).toBe(win.from);
    const shifted = visibleRange(win, "month", 600, 600);
    expect(shifted.from).toBe(win.from + 100);
    const clamped = visibleRange(win, "month", 999999, 600);
    expect(clamped.to).toBe(win.to);
  });
});

describe("rowGeometry", () => {
  const dayWin = timelineWindow("day", TODAY);

  it("区间含首尾两天", () => {
    const geo = rowGeometry(
      order({ plannedStartDate: "2026-11-12", plannedDeliveryDate: "2026-11-20" }),
      dayWin,
      TODAY,
      TZ,
      "day",
    );
    expect(geo.band).not.toBeNull();
    expect(geo.band!.left).toBe(dayToX(daysFromCivil(2026, 11, 12), dayWin, "day"));
    expect(geo.band!.width).toBe(9 * SCALE_CONFIG.day.pxPerDay);
    expect(geo.band!.clippedLeft).toBe(false);
    expect(geo.band!.clippedRight).toBe(false);
  });

  it("部分越界：裁到窗口内并标记方向", () => {
    const geo = rowGeometry(
      order({ plannedStartDate: "2026-11-05", plannedDeliveryDate: "2026-11-14" }),
      dayWin,
      TODAY,
      TZ,
      "day",
    );
    expect(geo.band).not.toBeNull();
    expect(geo.band!.left).toBe(0);
    expect(geo.band!.clippedLeft).toBe(true);
  });

  it("整段在窗口外：不画条，标记带越界方向", () => {
    const geo = rowGeometry(
      order({ plannedStartDate: "2027-03-01", plannedDeliveryDate: "2027-03-10" }),
      dayWin,
      TODAY,
      TZ,
      "day",
    );
    expect(geo.band).toBeNull();
    expect(geo.fullyOutside).toBe(true);
    expect(geo.markers.every((marker) => marker.overflow === "right")).toBe(true);
  });

  it("只有开始日期：空心标记，不补另一端", () => {
    const geo = rowGeometry(
      order({ plannedStartDate: "2026-11-16" }),
      dayWin,
      TODAY,
      TZ,
      "day",
    );
    expect(geo.band).toBeNull();
    expect(geo.markers).toHaveLength(1);
    expect(geo.markers[0]!.kind).toBe("planStart");
  });

  it("只有交付日期：菱形标记", () => {
    const geo = rowGeometry(
      order({ plannedDeliveryDate: "2026-11-22" }),
      dayWin,
      TODAY,
      TZ,
      "day",
    );
    expect(geo.band).toBeNull();
    expect(geo.markers.map((m) => m.kind)).toEqual(["delivery"]);
  });

  it("同日订单 = 单日条", () => {
    const geo = rowGeometry(
      order({ plannedStartDate: "2026-11-18", plannedDeliveryDate: "2026-11-18" }),
      dayWin,
      TODAY,
      TZ,
      "day",
    );
    expect(geo.band).not.toBeNull();
    expect(geo.band!.width).toBe(SCALE_CONFIG.day.pxPerDay);
  });

  it("年尺度单日订单退化为点，不拉成横条", () => {
    const yearWin = timelineWindow("year", TODAY);
    const geo = rowGeometry(
      order({ plannedStartDate: "2026-11-18", plannedDeliveryDate: "2026-11-18" }),
      yearWin,
      TODAY,
      TZ,
      "year",
    );
    expect(geo.band).toBeNull();
    expect(geo.markers.map((m) => m.kind)).toEqual(["delivery"]);
  });

  it("跨年区间连续，宽度按真实天数", () => {
    const yearWin = timelineWindow("year", TODAY);
    const geo = rowGeometry(
      order({ plannedStartDate: "2026-12-20", plannedDeliveryDate: "2027-02-28" }),
      yearWin,
      TODAY,
      TZ,
      "year",
    );
    expect(geo.band).not.toBeNull();
    const days = daysFromCivil(2027, 2, 28) - daysFromCivil(2026, 12, 20) + 1;
    expect(geo.band!.width).toBeCloseTo(days * SCALE_CONFIG.year.pxPerDay, 5);
    expect(geo.band!.clippedLeft).toBe(false);
  });

  it("反向区间不画条（防御性，正式库有 CHECK 阻止）", () => {
    const geo = rowGeometry(
      order({ plannedStartDate: "2026-11-25", plannedDeliveryDate: "2026-11-20" }),
      dayWin,
      TODAY,
      TZ,
      "day",
    );
    expect(geo.invalidRange).toBe(true);
    expect(geo.band).toBeNull();
  });

  it("终态订单保留条，但由组件画成中性虚线", () => {
    const geo = rowGeometry(
      order({
        status: "complete",
        plannedStartDate: "2026-10-01",
        plannedDeliveryDate: "2026-10-15",
        completedAt: "2026-10-14T09:20:00Z",
      }),
      dayWin,
      TODAY,
      TZ,
      "day",
    );
    expect(geo.terminal).toBe(true);
    expect(geo.band).toBeNull(); // 整段在窗口左侧
    expect(geo.fullyOutside).toBe(true);
  });
});

describe("splitOrders", () => {
  const active = order({ id: "a", code: "AF-1", plannedStartDate: "2026-11-10" });
  const noDates = order({ id: "b", code: "AF-2" });
  const done = order({ id: "c", code: "AF-3", status: "complete", plannedDeliveryDate: "2026-10-01" });
  const cancelled = order({ id: "d", code: "AF-4", status: "cancelled" });

  it("默认隐藏终态，未排期只收两个日期都为空的订单", () => {
    const split = splitOrders([active, noDates, done, cancelled], false);
    expect(split.scheduled.map((o) => o.id)).toEqual(["a"]);
    expect(split.unscheduled.map((o) => o.id)).toEqual(["b"]);
  });

  it("打开后终态进入轨道，两个日期都空的仍留在未排期", () => {
    const split = splitOrders([active, noDates, done, cancelled], true);
    expect(split.scheduled.map((o) => o.id).sort()).toEqual(["a", "c"]);
    expect(split.unscheduled.map((o) => o.id)).toEqual(["b", "d"]);
  });

  it("按开始日期排序，缺开始日期的用交付日期", () => {
    const late = order({ id: "late", code: "AF-9", plannedStartDate: "2026-12-01" });
    const onlyDue = order({ id: "due", code: "AF-8", plannedDeliveryDate: "2026-11-01" });
    const split = splitOrders([late, onlyDue], false);
    expect(split.scheduled.map((o) => o.id)).toEqual(["due", "late"]);
  });
});
