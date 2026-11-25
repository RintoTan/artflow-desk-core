/**
 * 订单右键菜单的条目与文案。
 *
 * 这里只回答两件事：**这个订单现在能做哪些事**，以及**做完之后说什么**。
 * 真正的执行仍然走各页面对应的入口（订单页的确认面板 / 取消对话框），
 * 所以菜单不会成为第二套业务规则。
 *
 * 顺序固定，与详情里的操作栏一致：打开在最上，其余按生命周期排列。
 */

import { api, newRequestId, type Capabilities, type OrderView } from "../bridge/commands";

export type OrderMenuAction = "open" | "undo" | "complete" | "cancel" | "reopen";

const ORDER: OrderMenuAction[] = ["open", "undo", "complete", "cancel", "reopen"];

export const ORDER_MENU_LABEL: Record<OrderMenuAction, string> = {
  open: "打开订单",
  undo: "撤销开工",
  complete: "完成",
  cancel: "取消订单…",
  reopen: "重新打开",
};

/** 需要二次确认的两项。文案与详情里的确认框逐字一致——同一个决定不该有两种说法。 */
export const LIFECYCLE_CONFIRM: Record<
  "complete" | "reopen",
  { title: string; detail: string; confirmLabel: string; done: string }
> = {
  complete: {
    title: "完成订单",
    detail: "完成后会锁定制作流程与开工状态，只能在确认后重新打开。",
    confirmLabel: "确认完成",
    done: "订单已完成",
  },
  reopen: {
    title: "重新打开订单",
    detail: "订单将回到活动状态并加入队列末尾，保留当前阶段与开工记录。",
    confirmLabel: "确认重新打开",
    done: "订单已重新打开",
  },
};

/**
 * 按当前订单能力挑出可以做的事。
 *
 * 不具备条件的项**不出现**，而不是灰一片：右键菜单是就地操作的入口，
 * 一排禁用项只会让人以为「这里本来就能做，只是现在不行」。
 */
export function orderMenuActions(caps: Capabilities): OrderMenuAction[] {
  return ORDER.filter((action) => {
    switch (action) {
      case "open":
        return true;
      case "undo":
        return caps.canUndoStartWork;
      case "complete":
        return caps.canComplete;
      case "cancel":
        return caps.canCancel;
      case "reopen":
        return caps.canReopen;
    }
  });
}

export type LifecycleCommand = "undo" | "complete" | "reopen";

/** 三个可直接执行的命令。取消要经过对话框，不在这里。 */
export function lifecycleCommand(action: LifecycleCommand, order: OrderView): Promise<OrderView> {
  const input = {
    orderId: order.id,
    expectedRevision: order.revision,
    requestId: newRequestId(action),
  };
  switch (action) {
    case "undo":
      return api.undoStartWork(input);
    case "complete":
      return api.completeOrder(input);
    case "reopen":
      return api.reopenOrder(input);
  }
}

/** 执行成功后的提示。 */
export const LIFECYCLE_DONE: Record<LifecycleCommand, string> = {
  undo: "已撤销开工",
  complete: LIFECYCLE_CONFIRM.complete.done,
  reopen: LIFECYCLE_CONFIRM.reopen.done,
};
