import { describe, expect, it } from "vitest";

import { placeContextMenu } from "./contextMenuPlacement";

const VIEWPORT = { width: 1200, height: 800 };
const SIZE = { width: 200, height: 150 };

describe("右键菜单定位", () => {
  it("空间够时贴着指针出现", () => {
    expect(placeContextMenu({ x: 300, y: 200 }, SIZE, VIEWPORT)).toEqual({ left: 300, top: 200 });
  });

  it("靠近右边界时往左收，保证整块可见", () => {
    // 1200 - 200 - 8 = 992
    expect(placeContextMenu({ x: 1180, y: 200 }, SIZE, VIEWPORT)).toEqual({
      left: 992,
      top: 200,
    });
  });

  it("靠近底部时往上收", () => {
    // 800 - 150 - 8 = 642
    expect(placeContextMenu({ x: 300, y: 790 }, SIZE, VIEWPORT)).toEqual({ left: 300, top: 642 });
  });

  it("右下角同时收敛，不出现负坐标或越界", () => {
    expect(placeContextMenu({ x: 1199, y: 799 }, SIZE, VIEWPORT)).toEqual({ left: 992, top: 642 });
  });

  it("指针贴边时留出间隙，菜单不压在窗口边框上", () => {
    expect(placeContextMenu({ x: 0, y: 0 }, SIZE, VIEWPORT)).toEqual({ left: 8, top: 8 });
  });

  it("菜单比视口还大时优先保证左上可见", () => {
    expect(placeContextMenu({ x: 500, y: 400 }, { width: 2000, height: 900 }, VIEWPORT)).toEqual({
      left: 8,
      top: 8,
    });
  });
});
