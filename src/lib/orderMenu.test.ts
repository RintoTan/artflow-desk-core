import { describe, expect, it } from "vitest";

import type { Capabilities } from "../bridge/commands";
import { LIFECYCLE_CONFIRM, ORDER_MENU_LABEL, orderMenuActions } from "./orderMenu";

function caps(overrides: Partial<Capabilities> = {}): Capabilities {
  return {
    canStartWork: false,
    canUndoStartWork: false,
    undoBlockedReason: null,
    canAdvance: false,
    canRework: false,
    canSkip: false,
    canComplete: false,
    canCancel: true,
    canReopen: false,
    canEditWorkflow: true,
    ...overrides,
  };
}

describe("订单右键菜单条目", () => {
  it("活动中的订单：只有打开与取消", () => {
    expect(orderMenuActions(caps())).toEqual(["open", "cancel"]);
  });

  it("已开工且到最后一个阶段：多出撤销与完成", () => {
    expect(
      orderMenuActions(caps({ canUndoStartWork: true, canComplete: true })),
    ).toEqual(["open", "undo", "complete", "cancel"]);
  });

  it("已完成的订单：不再有取消与完成，只留打开与重开", () => {
    expect(
      orderMenuActions(caps({ canCancel: false, canReopen: true })),
    ).toEqual(["open", "reopen"]);
  });

  it("已取消的订单同样只剩打开与重开", () => {
    expect(
      orderMenuActions(caps({ canCancel: false, canReopen: true, canComplete: false })),
    ).toEqual(["open", "reopen"]);
  });

  it("条目不随能力顺序变化而乱序：顺序固定，只做筛选", () => {
    const actions = orderMenuActions(
      caps({ canUndoStartWork: true, canComplete: true, canCancel: true, canReopen: true }),
    );
    expect(actions).toEqual(["open", "undo", "complete", "cancel", "reopen"]);
  });

  it("打开订单永远可用——菜单空了就没有存在意义", () => {
    expect(orderMenuActions(caps({ canCancel: false }))).toContain("open");
  });

  it("确认文案与详情里的说法一致，且完成、重开各有一套", () => {
    expect(LIFECYCLE_CONFIRM.complete.title).toBe("完成订单");
    expect(LIFECYCLE_CONFIRM.complete.confirmLabel).toBe("确认完成");
    expect(LIFECYCLE_CONFIRM.reopen.title).toBe("重新打开订单");
    expect(LIFECYCLE_CONFIRM.reopen.confirmLabel).toBe("确认重新打开");
    // 取消走的是 CancelOrderDialog，不该在这里出现第三条确认文案
    expect(Object.keys(LIFECYCLE_CONFIRM).sort()).toEqual(["complete", "reopen"]);
  });

  it("每个动作都有中文标签，不留空按钮", () => {
    for (const label of Object.values(ORDER_MENU_LABEL)) {
      expect(label.trim().length).toBeGreaterThan(0);
    }
  });
});
