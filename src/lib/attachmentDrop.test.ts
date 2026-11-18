import { describe, expect, it } from "vitest";

import { decideDrop, isInsideRect, partitionImagePaths, physicalToCss } from "./attachmentDrop";

describe("拖拽文件前置过滤", () => {
  it("接受后端白名单里的四种扩展名，大小写不敏感", () => {
    const result = partitionImagePaths([
      "/tmp/a.png",
      "/tmp/b.JPG",
      "/tmp/c.jpeg",
      "/tmp/d.WebP",
    ]);
    expect(result.accepted).toHaveLength(4);
    expect(result.rejected).toHaveLength(0);
  });

  it("拒绝不支持或没有扩展名的文件，并给出可读原因", () => {
    const result = partitionImagePaths(["/tmp/a.gif", "/tmp/README", "/tmp/b.pdf"]);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected.map((r) => r.name)).toEqual(["a.gif", "README", "b.pdf"]);
    expect(result.rejected[0]?.reason).toContain("不支持 .gif");
    expect(result.rejected[1]?.reason).toContain("没有扩展名");
  });

  it("混合拖入时只放行合法项，不让整批失败", () => {
    const result = partitionImagePaths(["/tmp/x.png", "/tmp/y.tiff", "/tmp/z.webp"]);
    expect(result.accepted).toEqual(["/tmp/x.png", "/tmp/z.webp"]);
    expect(result.rejected).toHaveLength(1);
  });

  it("物理像素换算成 CSS 像素：Retina 下坐标要除以 DPR", () => {
    expect(physicalToCss({ x: 300, y: 400 }, 2)).toEqual({ x: 150, y: 200 });
    expect(physicalToCss({ x: 300, y: 400 }, 1)).toEqual({ x: 300, y: 400 });
    expect(physicalToCss(null, 2)).toBeNull();
    expect(physicalToCss({ x: Number.NaN, y: 1 }, 2)).toBeNull();
  });
});

describe("落点判定：只有参考图片面板是合法投放区", () => {
  const rect = { left: 100, top: 200, right: 600, bottom: 700 };
  const base = {
    devicePixelRatio: 2,
    rect,
    paths: ["/tmp/a.png"],
    dragOrderId: "o1",
    activeOrderId: "o1",
    now: 10_000,
    lastDropAt: 0,
  };

  it("面板内松手（物理坐标）→ 导入", () => {
    const d = decideDrop({ ...base, position: { x: 300, y: 500 } });
    expect(d).toEqual({ import: true, paths: ["/tmp/a.png"] });
  });

  it("订单列表 / 侧边栏 / 详情其它区域 → 不导入", () => {
    // 物理像素 = CSS × 2：列表在面板右侧、侧栏在左边、搜索在面板上方
    const list = decideDrop({ ...base, position: { x: 1500, y: 800 } });
    const sidebar = decideDrop({ ...base, position: { x: 100, y: 800 } });
    const search = decideDrop({ ...base, position: { x: 1200, y: 80 } });
    expect(list).toEqual({ import: false, reason: "outside" });
    expect(sidebar).toEqual({ import: false, reason: "outside" });
    expect(search).toEqual({ import: false, reason: "outside" });
  });

  it("面板矩形本身不含 padding 外扩：紧贴边缘外侧 1px 即拒绝", () => {
    expect(isInsideRect({ x: 599, y: 699 }, rect)).toBe(true);
    expect(isInsideRect({ x: 601, y: 699 }, rect)).toBe(false);
    expect(decideDrop({ ...base, rect, position: { x: 1210, y: 1000 } })).toEqual({
      import: false,
      reason: "outside",
    });
  });

  it("坐标缺失或非法 → 不导入", () => {
    expect(decideDrop({ ...base, position: null })).toEqual({
      import: false,
      reason: "missing-position",
    });
    expect(decideDrop({ ...base, position: { x: Number.NaN, y: 10 } })).toEqual({
      import: false,
      reason: "missing-position",
    });
  });

  it("拖拽期间换单 → 不导入，也不写到新订单", () => {
    const d = decideDrop({ ...base, dragOrderId: "o1", activeOrderId: "o2", position: { x: 300, y: 500 } });
    expect(d).toEqual({ import: false, reason: "order-changed" });
  });

  it("同一次拖拽的重复 drop → 只算一次", () => {
    const d = decideDrop({ ...base, lastDropAt: 9_500, now: 10_000, position: { x: 300, y: 500 } });
    expect(d).toEqual({ import: false, reason: "duplicate" });
  });

  it("没有文件路径 → 不导入", () => {
    expect(decideDrop({ ...base, paths: [], position: { x: 300, y: 500 } })).toEqual({
      import: false,
      reason: "no-paths",
    });
  });

  it("没有量到面板矩形 → 不导入（不回退到整个详情）", () => {
    expect(decideDrop({ ...base, rect: null, position: { x: 300, y: 500 } })).toEqual({
      import: false,
      reason: "outside",
    });
  });
});
