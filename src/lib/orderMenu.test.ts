import { describe, expect, it } from "vitest";

import type { OrderView } from "../bridge/commands";
import { LIFECYCLE_CONFIRM, ORDER_MENU_LABEL, orderMenuActions } from "./orderMenu";

function order(overrides: Partial<OrderView> = {}): OrderView {
  return {
    id: "o1",
    code: "AF-2026-0001",
    title: "测试订单",
    clientId: null,
    clientName: null,
    commissionType: null,
    stageTemplateId: "tpl",
    source: null,
    amountCents: null,
    note: null,
    status: "active",
    workState: "queued",
    currentStageId: "s1",
    currentStageTitle: "草稿",
    currentStageIndex: 0,
    stageCount: 1,
    stages: [],
    queuePosition: 0,
    plannedStartDate: null,
    plannedDeliveryDate: null,
    deadlineState: "scheduled",
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    revision: 1,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    archivedAt: null,
    pinnedAt: null,
    capabilities: {
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
    },
    ...overrides,
  };
}

describe("订单右键菜单条目", () => {
  it("活动中的订单：打开、置顶、取消", () => {
    expect(orderMenuActions(order())).toEqual(["open", "pin", "cancel"]);
  });

  it("已开工且到最后一个阶段：多出撤销与完成", () => {
    const view = order();
    view.capabilities.canUndoStartWork = true;
    view.capabilities.canComplete = true;
    expect(orderMenuActions(view)).toEqual(["open", "pin", "undo", "complete", "cancel"]);
  });

  it("已置顶的订单：置顶换成取消置顶，其余不变", () => {
    const view = order({ pinnedAt: "2026-11-20T10:00:00+08:00" });
    expect(orderMenuActions(view)).toEqual(["open", "unpin", "cancel"]);
  });

  it("已完成的订单：没有置顶，只留打开与重开", () => {
    const view = order({ status: "complete" });
    view.capabilities.canCancel = false;
    view.capabilities.canReopen = true;
    expect(orderMenuActions(view)).toEqual(["open", "reopen"]);
  });

  it("已取消的订单同样不能置顶", () => {
    const view = order({ status: "cancelled" });
    view.capabilities.canCancel = false;
    view.capabilities.canReopen = true;
    expect(orderMenuActions(view)).toEqual(["open", "reopen"]);
  });

  it("已归档的订单不能置顶——归档会清掉置顶，菜单也不该留入口", () => {
    const view = order({ archivedAt: "2026-11-21T10:00:00+08:00" });
    expect(orderMenuActions(view)).not.toContain("pin");
  });

  it("pinnedAt 非空但订单已完成：不算有效置顶，不显示取消置顶", () => {
    // 清理漏写的旧数据不能让界面冒出一个「取消置顶」，判据与后端一致。
    const view = order({ status: "complete", pinnedAt: "2026-11-20T10:00:00+08:00" });
    view.capabilities.canCancel = false;
    expect(orderMenuActions(view)).not.toContain("unpin");
  });

  it("条目不随能力顺序变化而乱序：顺序固定，只做筛选", () => {
    const view = order({ pinnedAt: "2026-11-20T10:00:00+08:00" });
    view.capabilities.canUndoStartWork = true;
    view.capabilities.canComplete = true;
    view.capabilities.canReopen = true;
    expect(orderMenuActions(view)).toEqual([
      "open",
      "unpin",
      "undo",
      "complete",
      "cancel",
      "reopen",
    ]);
  });

  it("打开订单永远可用——菜单空了就没有存在意义", () => {
    const view = order({ status: "complete" });
    view.capabilities.canCancel = false;
    expect(orderMenuActions(view)).toContain("open");
  });

  it("确认文案与详情里的说法一致，且完成、重开各有一套", () => {
    expect(LIFECYCLE_CONFIRM.complete.title).toBe("完成订单");
    expect(LIFECYCLE_CONFIRM.complete.confirmLabel).toBe("确认完成");
    expect(LIFECYCLE_CONFIRM.reopen.title).toBe("重新打开订单");
    expect(LIFECYCLE_CONFIRM.reopen.confirmLabel).toBe("确认重新打开");
    expect(Object.keys(LIFECYCLE_CONFIRM).sort()).toEqual(["complete", "reopen"]);
  });

  it("每个动作都有中文标签，不留空按钮", () => {
    for (const label of Object.values(ORDER_MENU_LABEL)) {
      expect(label.trim().length).toBeGreaterThan(0);
    }
  });
});
