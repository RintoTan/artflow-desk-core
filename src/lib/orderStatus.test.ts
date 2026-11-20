import { describe, expect, it } from "vitest";

import { orderStatusLabel } from "./orderStatus";

describe("订单状态文案", () => {
  it("三种已知状态都返回中文", () => {
    expect(orderStatusLabel("active")).toBe("活动");
    expect(orderStatusLabel("complete")).toBe("已完成");
    expect(orderStatusLabel("cancelled")).toBe("已取消");
  });

  it("未知状态原样返回，不返回空白也不抛错", () => {
    expect(orderStatusLabel("archived")).toBe("archived");
  });

  it("空值给占位符而不是 undefined", () => {
    expect(orderStatusLabel(null)).toBe("—");
    expect(orderStatusLabel(undefined)).toBe("—");
  });
});
