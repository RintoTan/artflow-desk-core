import type { OrderEvent, OrderView } from "../bridge/commands";

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

    // 先把该订单**自己的**阶段全部登记为列，再往里放卡片。
    // 否则空阶段不会出现，只有一张订单时就没有可拖的下一阶段目标
    // （实测：一张单只能看到自己所在的那一列）。
    // 这些阶段都来自真实模板，不是虚构出来的。
    order.stages.forEach((stage, index) => {
      const key = stageKey(stage.title);
      const existing = columns.get(key);
      if (existing) {
        existing.minIndex = Math.min(existing.minIndex, index);
      } else {
        columns.set(key, { title: stage.title, orders: [], minIndex: index });
      }
    });

    if (!order.currentStageTitle) {
      unassigned.push(order);
      continue;
    }
    const key = stageKey(order.currentStageTitle);
    const existing = columns.get(key);
    if (existing) {
      existing.orders.push(order);
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

export type SkippedStage = { stageId: string; title: string };

export type StageMovePlan =
  | { kind: "noop"; reason: string }
  | { kind: "blocked"; reason: string }
  | {
      kind: "advance" | "rework";
      targetStageId: string;
      targetStageTitle: string;
      /** 落后/领先多少阶段，用于在确认框里说清影响 */
      steps: number;
      skipped: [];
    }
  | {
      kind: "skip";
      targetStageId: string;
      targetStageTitle: string;
      steps: number;
      /** 被越过的中间阶段（按流程顺序） */
      skipped: SkippedStage[];
    };

/** 解析事件里的跳级快照；坏数据一律当空，不让历史面板整块挂掉。 */
export function parseSkippedStages(raw: string | null): SkippedStage[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const record = item as Record<string, unknown>;
      const stageId = typeof record.stage_id === "string" ? record.stage_id : null;
      const title = typeof record.title === "string" ? record.title : null;
      if (stageId === null || title === null) return [];
      return [{ stageId, title }];
    });
  } catch {
    return [];
  }
}

/**
 * 当前阶段面板里应显示「已跳过」的阶段 id。
 *
 * 做法是按事件顺序回放每个阶段的状态，而不是只看最后一条事件：
 * - 推进 / 跳级：来源阶段记为已完成，目标阶段成为当前，快照里的阶段记为"已跳过"；
 * - 返工：目标阶段及其之后的阶段全部回到未做，目标成为当前 —— 所以重新进入
 *   一个曾被跳过的阶段后，它不再显示"已跳过"，而历史事件本身不受影响。
 *
 * 只返回"已跳过"，其它状态（done / pending / current）由现有样式表达。
 */
export function skippedStageIds(order: OrderView, events: OrderEvent[]): string[] {
  const state = new Map<string, "pending" | "current" | "done" | "skipped">();
  for (const stage of order.stages) state.set(stage.id, "pending");
  const currentId = order.stages[order.currentStageIndex ?? -1]?.id;

  for (const event of events) {
    if (event.kind === "stage_advanced" || event.kind === "stage_skipped") {
      if (event.fromStageId) state.set(event.fromStageId, "done");
      if (event.toStageId) state.set(event.toStageId, "current");
      if (event.kind === "stage_skipped") {
        for (const skipped of parseSkippedStages(event.skippedStages)) {
          if (state.has(skipped.stageId)) state.set(skipped.stageId, "skipped");
        }
      }
    } else if (event.kind === "stage_reworked") {
      const target = order.stages.findIndex((stage) => stage.id === event.toStageId);
      if (target < 0) continue;
      for (const stage of order.stages.slice(target)) state.set(stage.id, "pending");
      state.set(order.stages[target]!.id, "current");
    }
  }

  // 以当前快照为准：事件回放的终点必须与订单的当前阶段一致。
  if (currentId) state.set(currentId, "current");

  return [...state.entries()]
    .filter(([, value]) => value === "skipped")
    .map(([stageId]) => stageId);
}

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
export function planStageMove(
  order: OrderView,
  targetTitle: string,
  options: { allowSkip?: boolean } = {},
): StageMovePlan {
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
      skipped: [],
    };
  }

  if (targetIndex > currentIndex + 1) {
    const skipped = order.stages.slice(currentIndex + 1, targetIndex);
    if (options.allowSkip) {
      // 跳级要求已开工——领域层还会再校验一次，这里只负责提前说清楚。
      if (!order.startedAt) {
        return { kind: "blocked", reason: "订单尚未开工，不能跳级阶段" };
      }
      return {
        kind: "skip",
        targetStageId: target.id,
        targetStageTitle: target.title,
        steps: targetIndex - currentIndex,
        skipped: skipped.map((stage) => ({ stageId: stage.id, title: stage.title })),
      };
    }
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
    skipped: [],
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
