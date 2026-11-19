import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NAV_ICON_SHAPES, NavIcon } from "./NavIcon";

const NAMES = [
  "dashboard",
  "orders",
  "clients",
  "templates",
  "stats",
  "settings",
  "status",
  "calendar",
] as const;

describe("Arctic Line 导航图标", () => {
  it("八个图标都在，且没有多余的名字", () => {
    expect(Object.keys(NAV_ICON_SHAPES).sort()).toEqual([...NAMES].sort());
  });

  it.each(NAMES)("%s 使用统一的 24 网格与描边参数", (name) => {
    const { container } = render(<NavIcon name={name} />);
    const svg = container.querySelector("svg")!;

    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("stroke-width")).toBe("1.8");
    expect(svg.getAttribute("stroke-linecap")).toBe("round");
    expect(svg.getAttribute("stroke-linejoin")).toBe("round");
    // 线框图标：不允许出现填充、渐变或装饰
    expect(svg.getAttribute("fill")).toBe("none");
    expect(svg.querySelector("defs, linearGradient, radialGradient, filter, image, use")).toBeNull();
    // 纯装饰：名字由旁边的文字与 aria-label 提供
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("focusable")).toBe("false");
  });

  it.each(NAMES)("%s 至少有 3 条笔画，细到 20px 也不会糊成一团", (name) => {
    expect(NAV_ICON_SHAPES[name].length).toBeGreaterThanOrEqual(3);
  });

  it("每个图标的几何都落在 24 网格的安全区内", () => {
    for (const name of NAMES) {
      for (const shape of NAV_ICON_SHAPES[name]) {
        if (shape.kind === "circle") {
          expect(shape.cx - shape.r).toBeGreaterThanOrEqual(2.5);
          expect(shape.cx + shape.r).toBeLessThanOrEqual(21.5);
          expect(shape.cy - shape.r).toBeGreaterThanOrEqual(2.5);
          expect(shape.cy + shape.r).toBeLessThanOrEqual(21.5);
        } else if (shape.kind === "rect") {
          expect(shape.x).toBeGreaterThanOrEqual(2.5);
          expect(shape.x + shape.w).toBeLessThanOrEqual(21.5);
          expect(shape.y).toBeGreaterThanOrEqual(2.5);
          expect(shape.y + shape.h).toBeLessThanOrEqual(21.5);
        }
      }
    }
  });

  it("所有绝对锚点都在 24 网格安全区内", () => {
    // 只取 `M`（绝对）锚点：相对曲线里的数字是增量，不能当坐标用。
    // 光学校正（谁比谁略大）是看图定的，见报告 §2，这里只守住越界。
    for (const name of NAMES) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const shape of NAV_ICON_SHAPES[name]) {
        if (shape.kind === "circle") {
          xs.push(shape.cx - shape.r, shape.cx + shape.r);
          ys.push(shape.cy - shape.r, shape.cy + shape.r);
        } else if (shape.kind === "rect") {
          xs.push(shape.x, shape.x + shape.w);
          ys.push(shape.y, shape.y + shape.h);
        } else {
          const segments = shape.d.split("M").slice(1);
          for (const segment of segments) {
            const [x, y] = (segment.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
            if (x !== undefined && y !== undefined) {
              xs.push(x);
              ys.push(y);
            }
          }
        }
      }
      expect(Math.min(...xs), name).toBeGreaterThanOrEqual(2.5);
      expect(Math.max(...xs), name).toBeLessThanOrEqual(21.5);
      expect(Math.min(...ys), name).toBeGreaterThanOrEqual(2.5);
      expect(Math.max(...ys), name).toBeLessThanOrEqual(21.5);
    }
  });
});
