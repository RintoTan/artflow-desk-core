import { describe, expect, it } from "vitest";

import {
  DEFAULT_SPAN,
  TODAY_ANCHOR_RATIO,
  VIEW_SPANS,
  anchorFromViewport,
  hasLargerSpan,
  hasSmallerSpan,
  stepSpan,
  spanWindow,
} from "./timeline";
import { civilFromDays, daysFromCivil } from "./scheduleBar";

const TODAY = daysFromCivil(2026, 11, 23);

function days(win: { from: number; to: number }): number {
  return win.to - win.from + 1;
}

describe("跨度档位", () => {
  it("默认跨度符合规格：日 30 天 / 月 12 个月 / 年 3 年", () => {
    expect(VIEW_SPANS.day).toEqual([14, 30, 60]);
    expect(VIEW_SPANS.month).toEqual([6, 12, 24]);
    expect(Object.keys(VIEW_SPANS)).toEqual(["day", "month", "year"]);
    expect(VIEW_SPANS.year).toEqual([3, 5, 10]);
    expect(DEFAULT_SPAN.day).toBe(30);
    expect(DEFAULT_SPAN.month).toBe(12);
    expect(DEFAULT_SPAN.year).toBe(3);
  });

  it("缩放只改档位，到边界不再变化", () => {
    expect(stepSpan("day", 30, 1)).toBe(60);
    expect(stepSpan("day", 30, -1)).toBe(14);
    expect(stepSpan("day", 60, 1)).toBe(60);
    expect(stepSpan("day", 14, -1)).toBe(14);
    expect(hasSmallerSpan("day", 14)).toBe(false);
    expect(hasLargerSpan("day", 60)).toBe(false);
  });
});

describe("窗口按跨度生成", () => {
  it("日视图 30 天就是 30 格，且锚点在中间", () => {
    const win = spanWindow("day", TODAY, 30);
    expect(days(win)).toBe(30);
    expect(win.from).toBe(TODAY - 15);
    expect(win.to).toBe(TODAY + 14);
  });

  it("月视图 12 个月覆盖整年边界", () => {
    const win = spanWindow("month", TODAY, 12);
    const from = civilFromDays(win.from);
    const to = civilFromDays(win.to);
    expect(from.day).toBe(1);
    expect(to.day).toBe(30); // 2026-12 有 30 天? 12 月是 31 天
  });

  it("年视图 3 年从 1 月 1 日到 12 月 31 日", () => {
    const win = spanWindow("year", TODAY, 3);
    const from = civilFromDays(win.from);
    const to = civilFromDays(win.to);
    expect([from.year, from.month, from.day]).toEqual([2025, 1, 1]);
    expect([to.year, to.month, to.day]).toEqual([2027, 12, 31]);
  });

  it("点今天时今天落在左侧 20% 附近", () => {
    const win = spanWindow("day", TODAY, 30, { todayRatio: TODAY_ANCHOR_RATIO });
    const offset = TODAY - win.from;
    expect(offset / days(win)).toBeCloseTo(TODAY_ANCHOR_RATIO, 1);
  });
});

describe("视口中心反推锚点", () => {
  it("滚动后切换视图仍以可见中心为准", () => {
    const win = spanWindow("day", TODAY, 30);
    const mid = anchorFromViewport("day", win, 44 * 5, 44 * 10);
    expect(mid).toBe(win.from + 10);
  });

  it("反推结果被夹在窗口内", () => {
    const win = spanWindow("day", TODAY, 30);
    expect(anchorFromViewport("day", win, -9999, 100)).toBe(win.from);
    expect(anchorFromViewport("day", win, 99999, 100)).toBe(win.to);
  });
});
