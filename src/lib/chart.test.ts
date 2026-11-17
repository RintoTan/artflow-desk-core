import { describe, expect, it } from "vitest";

import { axisMaxOf, axisTicks, barPercent, compactCount, labelsEveryBar } from "./chart";

describe("Y 轴刻度", () => {
  it("全零只给一个 0，不硬造 0.5", () => {
    expect(axisTicks(0)).toEqual([0]);
    expect(axisTicks(-3)).toEqual([0]);
  });

  it("最大值为 1 时只给 0 和 1", () => {
    expect(axisTicks(1)).toEqual([0, 1]);
  });

  it("2 给 0/1/2，3~4 给 0/2/4", () => {
    expect(axisTicks(2)).toEqual([0, 1, 2]);
    expect(axisTicks(3)).toEqual([0, 2, 4]);
    expect(axisTicks(4)).toEqual([0, 2, 4]);
  });

  it("常见次数给好读的整刻度", () => {
    expect(axisTicks(7)).toEqual([0, 5, 10]);
    expect(axisTicks(10)).toEqual([0, 5, 10]);
    expect(axisTicks(12)).toEqual([0, 10, 20]);
    expect(axisTicks(100)).toEqual([0, 50, 100]);
  });

  it("刻度永远是非负整数、不重复、且覆盖最大值", () => {
    for (let max = 0; max <= 120; max += 1) {
      const ticks = axisTicks(max);
      expect(ticks.every((t) => Number.isInteger(t) && t >= 0)).toBe(true);
      expect(new Set(ticks).size).toBe(ticks.length);
      expect(ticks[ticks.length - 1]!).toBeGreaterThanOrEqual(max);
      for (let i = 1; i < ticks.length; i += 1) {
        expect(ticks[i]!).toBeGreaterThan(ticks[i - 1]!);
      }
    }
  });
});

describe("柱高换算", () => {
  it("按刻度上界换算，最高不越过 100%", () => {
    expect(barPercent(10, 10)).toBe(100);
    expect(barPercent(5, 10)).toBe(50);
    expect(barPercent(0, 10)).toBe(0);
    expect(barPercent(3, 0)).toBe(0);
  });

  it("axisMaxOf 与刻度一致", () => {
    expect(axisMaxOf(axisTicks(7))).toBe(10);
    expect(axisMaxOf([])).toBe(0);
  });
});

describe("标签密度与数字缩写", () => {
  it("6 个月以内逐柱标，超过只标每月最大值", () => {
    expect(labelsEveryBar(1)).toBe(true);
    expect(labelsEveryBar(6)).toBe(true);
    expect(labelsEveryBar(7)).toBe(false);
    expect(labelsEveryBar(12)).toBe(false);
  });

  it("大数字缩写不至于挤爆轴", () => {
    expect(compactCount(0)).toBe("0");
    expect(compactCount(9)).toBe("9");
    expect(compactCount(999)).toBe("999");
    expect(compactCount(1000)).toBe("1k");
    expect(compactCount(1200)).toBe("1.2k");
    expect(compactCount(12000)).toBe("12k");
  });
});
