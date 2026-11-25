import { describe, expect, it } from "vitest";

import { describeError, isConflict } from "./commands";

/**
 * 错误展示层的分工：
 * 业务错误的 message 已经是给用户看的句子，不该再挂内部枚举；
 * 技术错误的码要留着，否则用户报障时无从定位。
 */
describe("describeError", () => {
  const limit = "最多只能置顶 5 个订单，请先取消其他订单的置顶。";

  it("业务错误只显示人话，不泄漏内部枚举", () => {
    expect(describeError({ code: "INVALID", message: limit })).toBe(limit);
    expect(describeError({ code: "CONFLICT", message: "已被其他窗口修改" })).toBe("已被其他窗口修改");
    expect(describeError({ code: "NOT_FOUND", message: "订单不存在" })).toBe("订单不存在");
  });

  it("技术错误码保留，便于定位", () => {
    expect(describeError({ code: "DB", message: "数据库完整性检查失败" })).toBe(
      "数据库完整性检查失败（DB）",
    );
    expect(describeError({ code: "ZIP", message: "备份包校验失败" })).toBe("备份包校验失败（ZIP）");
  });

  it("缺码时按 ERROR 处理，不吞掉消息", () => {
    expect(describeError({ code: "", message: "未知失败" })).toBe("未知失败");
  });

  it("普通 Error 与非对象输入不被改写成带码文案", () => {
    expect(describeError(new Error("网络中断"))).toBe("网络中断");
    expect(describeError("纯字符串")).toBe("纯字符串");
  });
});

describe("isConflict", () => {
  it("只认 CONFLICT", () => {
    expect(isConflict({ code: "CONFLICT", message: "" })).toBe(true);
    expect(isConflict({ code: "INVALID", message: "" })).toBe(false);
    expect(isConflict(null)).toBe(false);
  });
});
