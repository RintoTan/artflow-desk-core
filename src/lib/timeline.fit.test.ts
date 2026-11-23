import { describe, expect, it } from "vitest";

import { buildTicks, canvasWidth, dayToX, rowGeometry, spanWindow } from "./timeline";
import { daysFromCivil } from "./scheduleBar";

const TODAY = daysFromCivil(2026, 11, 23);

describe("Fit-to-Window", () => {
  it("画布严格等于可视宽度（月视图 12 个月、1257px）", () => {
    const win = spanWindow("month", TODAY, 12);
    const days = win.to - win.from + 1;
    const px = 1257 / days;
    expect(canvasWidth(win, "month", px)).toBeCloseTo(1257, 6);
    expect(dayToX(win.to, win, "month", px)).toBeLessThanOrEqual(1257);
    expect(dayToX(win.to, win, "month", px) + px).toBeCloseTo(1257, 6);
  });

  it("四种尺度都按同一规则收进窗口", () => {
    for (const [scale, span] of [["day", 30], ["month", 12], ["year", 3]] as const) {
      const win = spanWindow(scale, TODAY, span);
      const days = win.to - win.from + 1;
      const px = 900 / days;
      expect(canvasWidth(win, scale, px)).toBeCloseTo(900, 6);
    }
  });

  it("刻度与订单条共用同一套坐标", () => {
    const win = spanWindow("month", TODAY, 12);
    const days = win.to - win.from + 1;
    const px = 1257 / days;
    const ticks = buildTicks(win, "month", TODAY, px);
    const first = ticks.tier2[0]!;
    const last = ticks.tier2[ticks.tier2.length - 1]!;
    expect(first.left).toBeCloseTo(dayToX(first.day, win, "month", px), 6);
    expect(last.left + last.width).toBeLessThanOrEqual(1257 + 0.001);
  });

  it("订单条右端不超过画布", () => {
    const win = spanWindow("month", TODAY, 12);
    const days = win.to - win.from + 1;
    const px = 1257 / days;
    const geo = rowGeometry(
      {
        status: "active",
        deadlineState: "scheduled",
        plannedStartDate: "2026-05-01",
        plannedDeliveryDate: "2027-04-30",
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
      },
      win,
      TODAY,
      "Asia/Shanghai",
      "month",
      px,
    );
    expect(geo.band).not.toBeNull();
    expect(geo.band!.left + geo.band!.width).toBeLessThanOrEqual(1257 + 1);
  });
});
