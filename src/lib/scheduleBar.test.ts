import { describe, expect, it } from "vitest";

import {
  barModel,
  buildWindow,
  civilFromDays,
  daysFromCivil,
  deliveryLabel,
  formatDayKey,
  localDayIndex,
  localDayKey,
  parseDayKey,
  shortDate,
} from "./scheduleBar";

function order(overrides: Record<string, unknown> = {}) {
  return {
    status: "active" as const,
    deadlineState: "scheduled" as const,
    plannedStartDate: null,
    plannedDeliveryDate: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

const TZ = "Asia/Shanghai";
const TODAY = parseDayKey("2026-11-17")!;
const WINDOW = buildWindow(TODAY); // 2026-10-03 .. 2027-01-01

describe("日历日换算（不用毫秒整除）", () => {
  it("1970-01-01 是第 0 天", () => {
    expect(daysFromCivil(1970, 1, 1)).toBe(0);
  });

  it("闰年 2 月 29 日与前后一天连续", () => {
    const feb28 = daysFromCivil(2024, 2, 28);
    const feb29 = daysFromCivil(2024, 2, 29);
    const mar1 = daysFromCivil(2024, 3, 1);
    expect(feb29 - feb28).toBe(1);
    expect(mar1 - feb29).toBe(1);
  });

  it("跨年、跨世纪都连续", () => {
    expect(daysFromCivil(2027, 1, 1) - daysFromCivil(2026, 12, 31)).toBe(1);
    expect(daysFromCivil(2000, 3, 1) - daysFromCivil(2000, 2, 28)).toBe(2); // 2000 是闰年
    expect(daysFromCivil(1900, 3, 1) - daysFromCivil(1900, 2, 28)).toBe(1); // 1900 不是闰年
  });

  it("来回换算完全一致", () => {
    for (const [y, m, d] of [
      [1970, 1, 1],
      [2026, 11, 17],
      [1969, 12, 31],
      [2100, 2, 28],
    ] as const) {
      expect(civilFromDays(daysFromCivil(y, m, d))).toEqual({ year: y, month: m, day: d });
    }
  });

  it("非法日期不静默滚动成别的日子", () => {
    expect(parseDayKey("2026-02-30")).toBeNull();
    expect(parseDayKey("2026-13-01")).toBeNull();
    expect(parseDayKey("2026-1-1")).toBeNull();
    expect(parseDayKey("")).toBeNull();
    expect(parseDayKey(null)).toBeNull();
    expect(parseDayKey("2026-11-17")).not.toBeNull();
  });

  it("格式化回 YYYY-MM-DD 与 MM-DD", () => {
    expect(formatDayKey(TODAY)).toBe("2026-11-17");
    expect(shortDate(TODAY)).toBe("11-17");
  });
});

describe("工作时区换算", () => {
  it("UTC 深夜在上海是第二天，在纽约还是当天", () => {
    // 2026-11-17T23:30Z → 上海 11-18 07:30；纽约 11-17 18:30
    expect(localDayKey("2026-11-17T23:30:00.000Z", "Asia/Shanghai")).toBe("2026-11-18");
    expect(localDayKey("2026-11-17T23:30:00.000Z", "America/New_York")).toBe("2026-11-17");
  });

  it("夏令时切换当天不会算错日期", () => {
    // 纽约 2026-03-08 02:00 进入夏令时
    expect(localDayKey("2026-03-08T06:30:00.000Z", "America/New_York")).toBe("2026-03-08");
    expect(localDayKey("2026-03-08T07:30:00.000Z", "America/New_York")).toBe("2026-03-08");
    // 上海无夏令时，跨日只在 16:00Z
    expect(localDayKey("2026-03-08T15:59:00.000Z", "Asia/Shanghai")).toBe("2026-03-08");
    expect(localDayKey("2026-03-08T16:00:00.000Z", "Asia/Shanghai")).toBe("2026-03-09");
  });

  it("坏时区/坏时间不抛错，返回 null", () => {
    expect(localDayKey("2026-11-17T00:00:00.000Z", "Not/AZone")).toBeNull();
    expect(localDayKey("2026-11-17T00:00:00.000Z", null)).toBeNull();
    expect(localDayKey("not-a-date", TZ)).toBeNull();
    expect(localDayIndex(null, TZ)).toBeNull();
  });
});

describe("窗口", () => {
  it("固定前后各 45 天", () => {
    expect(WINDOW).toEqual({ from: TODAY - 45, to: TODAY + 45 });
  });
});

describe("排期模型", () => {
  const model = (o: Record<string, unknown>) => barModel(order(o) as never, WINDOW, TODAY, TZ);

  it("两个计划日期都在：画区间 + 交付标记", () => {
    const m = model({ plannedStartDate: "2026-11-10", plannedDeliveryDate: "2026-11-20" });
    expect(m.band).not.toBeNull();
    expect(m.band!.leftPct).toBeGreaterThan(0);
    expect(m.band!.widthPct).toBeGreaterThan(0);
    expect(m.markers.map((x) => x.kind)).toContain("delivery");
  });

  it("只有交付日：只有点，没有区间", () => {
    const m = model({ plannedDeliveryDate: "2026-11-20" });
    expect(m.band).toBeNull();
    expect(m.markers.map((x) => x.kind)).toEqual(["delivery"]);
  });

  it("只有开始日：只画计划开始点，不推算交付", () => {
    const m = model({ plannedStartDate: "2026-11-10" });
    expect(m.band).toBeNull();
    // 计划与实际是两种标记，不能混为一谈
    expect(m.markers.map((x) => x.kind)).toEqual(["planStart"]);
  });

  it("两个都空：什么都不画", () => {
    const m = model({});
    expect(m.band).toBeNull();
    expect(m.markers).toHaveLength(0);
  });

  it("反向区间安全降级：不画区间，但两个点都还在", () => {
    const m = model({ plannedStartDate: "2026-11-20", plannedDeliveryDate: "2026-11-10" });
    expect(m.invalidRange).toBe(true);
    expect(m.band).toBeNull();
    expect(m.markers.map((x) => x.kind).sort()).toEqual(["delivery", "planStart"]);
  });

  it("越界日期钳在边缘并标记方向", () => {
    const m = model({ plannedDeliveryDate: "2026-01-01" });
    expect(m.markers[0]!.pct).toBe(0);
    expect(m.markers[0]!.overflow).toBe("left");
    const far = model({ plannedDeliveryDate: "2027-06-01" });
    expect(far.markers[0]!.pct).toBe(100);
    expect(far.markers[0]!.overflow).toBe("right");
  });

  it("今天的位置随窗口固定在中点", () => {
    expect(model({}).todayPct).toBeCloseTo(50, 5);
  });

  it("风险色只读 deadlineState，不在前端重算", () => {
    for (const state of ["overdue", "today", "dueSoon", "scheduled", "unscheduled"] as const) {
      const m = model({ plannedDeliveryDate: "2026-11-20", deadlineState: state });
      expect(m.markers[0]!.tone).toBe(state);
    }
  });

  it("终态订单一律中性，不出现逾期红", () => {
    for (const status of ["complete", "cancelled"] as const) {
      const m = model({
        status,
        deadlineState: "scheduled",
        plannedDeliveryDate: "2026-11-20",
      });
      expect(m.markers[0]!.tone).toBe("neutral");
    }
  });

  it("完成/取消标记只认当前有效状态", () => {
    const completed = model({
      status: "complete",
      completedAt: "2026-11-17T02:00:00.000Z",
      cancelledAt: null,
    });
    expect(completed.markers.map((x) => x.kind)).toContain("completed");
    expect(completed.markers.map((x) => x.kind)).not.toContain("cancelled");

    const cancelled = model({
      status: "cancelled",
      cancelledAt: "2026-11-16T02:00:00.000Z",
      completedAt: "2026-11-10T02:00:00.000Z",
    });
    expect(cancelled.markers.map((x) => x.kind)).toContain("cancelled");
    expect(cancelled.markers.map((x) => x.kind)).not.toContain("completed");
  });

  it("实际开工不会被当成计划开始", () => {
    const m = model({ startedAt: "2026-11-17T02:00:00.000Z" });
    expect(m.band).toBeNull();
    expect(m.markers.map((x) => x.kind)).toEqual(["started"]);
  });

  it("坏日期不崩，只当没有", () => {
    const m = model({ plannedStartDate: "2026-02-30", plannedDeliveryDate: "oops" });
    expect(m.band).toBeNull();
    expect(m.markers).toHaveLength(0);
  });
});

describe("窄窗口文字", () => {
  it("有交付日就给 MM-DD", () => {
    expect(deliveryLabel({ plannedDeliveryDate: "2026-11-20" } as never)).toBe("交付 11-20");
  });

  it("没有交付日就不给，不虚构", () => {
    expect(deliveryLabel({ plannedDeliveryDate: null } as never)).toBeNull();
    expect(deliveryLabel({ plannedDeliveryDate: "2026-02-30" } as never)).toBeNull();
  });
});
