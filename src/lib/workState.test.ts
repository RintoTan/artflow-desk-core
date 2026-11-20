import { describe, expect, it } from "vitest";

import { workStateLabel, type WorkStateKey } from "./workState";

describe("制作进度文案", () => {
  it("四种状态都返回中文，且与后端枚举一一对应", () => {
    // 逐项写死：后端新增枚举时必须来这里补一行，而不是让界面显示英文。
    const expected: Record<WorkStateKey, string> = {
      queued: "排队中",
      inProgress: "制作中",
      completed: "已完成",
      cancelled: "已取消",
    };
    for (const [key, label] of Object.entries(expected) as [WorkStateKey, string][]) {
      expect(workStateLabel(key)).toBe(label);
    }
    expect(Object.keys(expected)).toHaveLength(4);
  });

  it("未知值原样返回，不返回空白也不抛错", () => {
    expect(workStateLabel("paused")).toBe("paused");
  });

  it("空值给占位符而不是 undefined", () => {
    expect(workStateLabel(null)).toBe("—");
    expect(workStateLabel(undefined)).toBe("—");
    expect(workStateLabel("")).toBe("—");
  });

  it("与业务状态是两套文案：同一个「已完成」不共享键名", () => {
    // 这条断言是防止将来有人把两个模块合并：业务状态用 active，制作进度用 queued。
    expect(workStateLabel("active")).toBe("active");
    expect(workStateLabel("queued")).toBe("排队中");
  });
});
