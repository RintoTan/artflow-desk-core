import { describe, expect, it } from "vitest";

import { chipDropZone } from "./chipZone";

const base = { singleDay: false, clippedLeft: false, clippedRight: false, width: 120 };

describe("日历条拖拽命中区", () => {
  it("右端抓手 → 交付日拖拽（不会被改期按钮抢走）", () => {
    expect(chipDropZone({ ...base, handle: "end", ratio: 0.5 })).toBe("delivery");
  });

  it("左端抓手 → 开始日拖拽", () => {
    expect(chipDropZone({ ...base, handle: "start", ratio: 0.5 })).toBe("start");
  });

  it("没有抓手时按比例：两端 14px 内算端点，中间是整条平移", () => {
    expect(chipDropZone({ ...base, handle: null, ratio: 0.05 })).toBe("start");
    expect(chipDropZone({ ...base, handle: null, ratio: 0.97 })).toBe("delivery");
    expect(chipDropZone({ ...base, handle: null, ratio: 0.5 })).toBe("move");
  });

  it("单日订单没有端点，一律整体平移", () => {
    expect(
      chipDropZone({ ...base, singleDay: true, handle: "end", ratio: 0.99 }),
    ).toBe("move");
  });

  it("被裁切的一端不提供端点拖拽", () => {
    expect(
      chipDropZone({ ...base, clippedRight: true, handle: "end", ratio: 0.99 }),
    ).toBe("move");
    expect(
      chipDropZone({ ...base, clippedLeft: true, handle: "start", ratio: 0.01 }),
    ).toBe("move");
  });
});
