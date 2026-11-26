import { describe, expect, it } from "vitest";

import { COMMISSION_TYPES, suggestOrderTitle } from "./commissionType";

describe("委托类型预设", () => {
  it("包含七种高频类型，顺序固定", () => {
    expect([...COMMISSION_TYPES]).toEqual(["插画", "组合页", "服设", "设定卡", "表情包", "头像", "摸鱼"]);
  });
});

describe("按客户与类型生成标题", () => {
  it("两半都有时拼成「客户 · 类型」", () => {
    expect(suggestOrderTitle("QA 客户 05", "插画")).toBe("QA 客户 05 · 插画");
  });

  it("去掉首尾空格再拼", () => {
    expect(suggestOrderTitle("  林三  ", " 头像 ")).toBe("林三 · 头像");
  });

  it("缺一半就不生成，交给用户自己写", () => {
    expect(suggestOrderTitle("", "插画")).toBeNull();
    expect(suggestOrderTitle("林三", "")).toBeNull();
    expect(suggestOrderTitle("林三", "   ")).toBeNull();
  });
});
