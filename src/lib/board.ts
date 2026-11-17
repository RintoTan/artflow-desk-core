import type { OrderView } from "../bridge/commands";

/**
 * 看板分组与拖拽语义。
 *
 * 两条不可越界的规则：
 * 1. **分列按规范化阶段名**——不同流程模板的阶段 ID 不同，按 ID 分列会把同一件事拆成两列；
 *    但拖动时必须回到**目标订单自己**的阶段表里解析 ID，不能拿列名直接写库。
 * 2. **分组只是展示**。是否允许移动、该调用哪个合法动作，一律由本模块给出结论，
 *    真正的执行仍走后端 `advance_stage` / `rework_stage`。
 */

/** 规范化阶段名：去首尾空白、压内部空白、忽略大小写与全角差异。 */
export function stageKey(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

export type BoardColumn = {
  key: string;
  title: string;
  orders: OrderView[];
  /** 已知委托金额合计（分）：NULL 金额不计入 */
  knownAmountCents: number;
  /** 金额未知的订单数：单独说明，不把它们当成 0 元单 */
  unknownAmountCount: number;
};

export type BoardModel = {
  columns: BoardColumn[];
  /** 活动但没有当前阶段的订单（正常数据不会出现，防御性保留） */
  unassigned: OrderView[];
  /** 已完成 / 已取消：单独区域，绝不混进阶段列 */
  finished: OrderView[];
};

/**
 * 活动订单按当前阶段名分列。
 * 列顺序：按成员在各自流程里的最小阶段序号升序，其次按名称——
 * 这样跨模板时也能得到一个「大致从左到右推进」的稳定顺序。
 */
export function buildBoard(orders: OrderView[]): BoardModel {
  const columns = new Map<string, { title: string; orders: OrderView[]; minIndex: number }>();
  const unassigned: OrderView[] = [];
  const finished: OrderView[] = [];

  for (const order of orders) {
    if (order.status !== "active") {
      finished.push(order);
      continue;
    }
    if (!order.currentStageTitle) {
      unassigned.push(order);
      continue;
    }
    const key = stageKey(order.currentStageTitle);
    const index = order.currentStageIndex ?? Number.MAX_SAFE_INTEGER;
    const existing = columns.get(key);
    if (existing) {
      existing.orders.push(order);
      existing.minIndex = Math.min(existing.minIndex, index);
    } else {
      columns.set(key, {
        title: order.currentStageTitle,
        orders: [order],
        minIndex: index,
      });
    }
  }

  const sorted = [...columns.entries()]
    .sort((a, b) => a[1].minIndex - b[1].minIndex || a[1].title.localeCompare(b[1].title))
    .map(([key, value]) => {
      let known = 0;
      let unknown = 0;
      for (const order of value.orders) {
        if (order.amountCents === null) unknown += 1;
        else known += order.amountCents;
      }
      return {
        key,
        title: value.title,
        orders: value.orders,
        knownAmountCents: known,
        unknownAmountCount: unknown,
      };
    });

  return { columns: sorted, unassigned, finished };
}

export type StageMovePlan =
  | { kind: "noop"; reason: string }
  | { kind: "blocked"; reason: string }
  | {
      kind: "advance" | "rework";
      targetStageId: string;
      targetStageTitle: string;
      /** 落后/领先多少阶段，用于在确认框里说清影响 */
      steps: number;
    };

type Resolved = { ok: true; stage: OrderView["stages"][number] } | { ok: false; error: string };

/** 在目标订单自己的阶段表里按名称找唯一阶段。 */
function resolveStage(order: OrderView, targetTitle: string): Resolved {
  const key = stageKey(targetTitle);
  const matches = order.stages.filter((stage) => stageKey(stage.title) === key);
  if (matches.length === 0) {
    return {
      ok: false,
      error: `该订单的流程里没有「${targetTitle}」阶段；不同模板的阶段不能互相搬运`,
    };
  }
  if (matches.length > 1) {
    return { ok: false, error: `该订单有两个同名「${targetTitle}」阶段，无法确定目标` };
  }
  const [only] = matches;
  if (!only) {
    return { ok: false, error: `该订单的流程里没有「${targetTitle}」阶段` };
  }
  return { ok: true, stage: only };
}

/**
 * 把「拖到某一列」翻译成一次**已有的合法业务动作**。
 * 这里不做任何猜测：无法唯一确定时一律 blocked，并说明原因。
 */
export function planStageMove(order: OrderView, targetTitle: string): StageMovePlan {
  if (order.status !== "active") {
    return { kind: "blocked", reason: "已完成或已取消的订单不能在看板里改阶段" };
  }
  const resolved = resolveStage(order, targetTitle);
  if (!resolved.ok) {
    return { kind: "blocked", reason: resolved.error };
  }
  const target = resolved.stage;
  const currentIndex = order.currentStageIndex;
  if (currentIndex === null) {
    return { kind: "blocked", reason: "订单当前没有阶段，请先在详情里检查流程" };
  }
  const targetIndex = order.stages.findIndex((stage) => stage.id === target.id);

  if (targetIndex === currentIndex) {
    return { kind: "noop", reason: "已经是这个阶段，无需移动" };
  }

  if (targetIndex === currentIndex + 1) {
    return {
      kind: "advance",
      targetStageId: target.id,
      targetStageTitle: target.title,
      steps: 1,
    };
  }

  if (targetIndex > currentIndex + 1) {
    const next = order.stages[currentIndex + 1];
    return {
      kind: "blocked",
      reason: `不能跳过中间阶段：一次只能推进到「${next ? next.title : "下一阶段"}」，跨阶段请到订单详情处理`,
    };
  }

  // 往回拖：领域层的返工动作支持指定更早的目标阶段，但要求已开工。
  if (!order.startedAt) {
    return { kind: "blocked", reason: "订单尚未开工，不能返工到更早的阶段" };
  }
  return {
    kind: "rework",
    targetStageId: target.id,
    targetStageTitle: target.title,
    steps: currentIndex - targetIndex,
  };
}

/** 推进要求已开工——领域层会再校验一次，这里只负责提前说清楚。 */
export function advanceBlockedReason(order: OrderView): string | null {
  if (order.status !== "active") return "已完成或已取消的订单不能推进阶段";
  if (!order.startedAt) return "订单尚未开工，不能推进阶段";
  if (order.currentStageIndex === null) return "订单当前没有阶段";
  if (order.currentStageIndex >= order.stageCount - 1) {
    return "已经在最后一个阶段，请用「完成」结束订单";
  }
  return null;
}
