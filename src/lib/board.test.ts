import { describe, expect, it } from "vitest";

import type { OrderView, StageView } from "../bridge/commands";
import {
  buildBoard,
  parseSkippedStages,
  planStageMove,
  skippedStageIds,
  stageKey,
} from "./board";
import type { OrderEvent } from "../bridge/commands";

function stages(titles: string[], currentIndex: number): StageView[] {
  return titles.map((title, index) => ({
    id: `s-${title}`,
    title,
    position: index,
    isCurrent: index === currentIndex,
  }));
}

function order(partial: Partial<OrderView> & { titles?: string[]; currentIndex?: number }): OrderView {
  const titles = partial.titles ?? ["草稿", "细化", "上色", "完稿"];
  const currentIndex = partial.currentIndex ?? 0;
  const { titles: _t, currentIndex: _c, ...rest } = partial;
  return {
    id: rest.id ?? "o1",
    code: rest.code ?? "AF-2026-0001",
    title: rest.title ?? "测试单",
    clientId: null,
    clientName: null,
    commissionType: null,
    stageTemplateId: "tpl-a",
    source: null,
    amountCents: null,
    note: null,
    status: "active",
    workState: "inProgress",
    currentStageId: `s-${titles[currentIndex]}`,
    currentStageTitle: titles[currentIndex] ?? null,
    currentStageIndex: currentIndex,
    stageCount: titles.length,
    stages: stages(titles, currentIndex),
    queuePosition: 0,
    plannedStartDate: null,
    plannedDeliveryDate: null,
    deadlineState: "scheduled",
    startedAt: "2026-11-01T00:00:00Z",
    completedAt: null,
    cancelledAt: null,
    revision: 1,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    capabilities: {
      canStartWork: false,
      canUndoStartWork: false,
      undoBlockedReason: null,
      canAdvance: true,
      canRework: true,
      canSkip: false,
      canComplete: false,
      canCancel: true,
      canReopen: false,
      canEditWorkflow: true,
    },
    ...rest,
  };
}

describe("stageKey", () => {
  it("忽略首尾空白、内部多空白与大小写", () => {
    expect(stageKey("  上色  ")).toBe("上色");
    expect(stageKey("Line  Art")).toBe(stageKey("line art"));
  });
});

describe("buildBoard", () => {
  it("按规范化阶段名分列，跨模板同名阶段合并成一列", () => {
    const board = buildBoard([
      order({ id: "a", currentStageTitle: "细化", stages: stages(["草稿", "细化"], 1) }),
      order({ id: "b", currentStageTitle: " 细化 ", stages: stages(["线稿", "细化"], 1) }),
    ]);
    // 草稿 / 细化 / 线稿 三个阶段都来自真实模板，因此三列都在；
    // 同名「细化」合并成一列。
    // 两个模板的首阶段都是 0 号位：跨模板时没有"正确"先后，按名称稳定排序。
    // 顺序只求大致从左到右，不承诺业务含义。
    expect(board.columns.map((c) => c.title)).toEqual(["线稿", "草稿", "细化"]);
    const thin = board.columns.find((c) => c.title === "细化")!;
    expect(thin.orders.map((o) => o.id).sort()).toEqual(["a", "b"]);
  });

  it("列按最小阶段序号排序，近似流程顺序", () => {
    const board = buildBoard([
      order({ id: "late", currentIndex: 2 }),
      order({ id: "early", currentIndex: 0 }),
    ]);
    expect(board.columns[0]!.title).toBe("草稿");
    expect(board.columns[1]!.title).toBe("细化");
    // 空阶段也算列：一张单也能把卡片拖到"还没人"的下一个阶段。
    expect(board.columns.map((c) => c.title)).toEqual(["草稿", "细化", "上色", "完稿"]);
  });

  it("已完成与已取消不进入阶段列", () => {
    const board = buildBoard([
      order({ id: "a" }),
      order({ id: "b", status: "complete", workState: "completed" }),
      order({ id: "c", status: "cancelled", workState: "cancelled" }),
    ]);
    expect(board.columns.flatMap((c) => c.orders)).toHaveLength(1);
    expect(board.finished.map((o) => o.id).sort()).toEqual(["b", "c"]);
  });

  it("金额合计排除 NULL，但订单数仍然计入", () => {
    const board = buildBoard([
      order({ id: "a", amountCents: 10_000 }),
      order({ id: "b", amountCents: null }),
      order({ id: "c", amountCents: 5_000 }),
    ]);
    const column = board.columns[0]!;
    expect(column.orders).toHaveLength(3);
    expect(column.knownAmountCents).toBe(15_000);
    expect(column.unknownAmountCount).toBe(1);
  });

  it("空阶段列存在但没有卡片，不虚构阶段", () => {
    const board = buildBoard([order({ titles: ["草稿", "完稿"], currentIndex: 0 })]);
    expect(board.columns.map((c) => c.title)).toEqual(["草稿", "完稿"]);
    expect(board.columns[1]!.orders).toHaveLength(0);
    expect(board.columns[1]!.knownAmountCents).toBe(0);
  });

  it("未开工订单仍在自己阶段列里", () => {
    const board = buildBoard([order({ id: "a", startedAt: null, workState: "queued" })]);
    expect(board.columns[0]!.orders[0]!.id).toBe("a");
  });
});

describe("planStageMove", () => {
  it("下一阶段 → advance", () => {
    const plan = planStageMove(order({ currentIndex: 1 }), "上色");
    expect(plan).toMatchObject({ kind: "advance", targetStageId: "s-上色", steps: 1 });
  });

  it("跨两个阶段 → blocked，不偷偷连续推进", () => {
    const plan = planStageMove(order({ currentIndex: 0 }), "上色");
    expect(plan.kind).toBe("blocked");
    if (plan.kind === "blocked") expect(plan.reason).toContain("不能跳过中间阶段");
  });

  it("更早的阶段 → rework，并说明退回几步", () => {
    const plan = planStageMove(order({ currentIndex: 2 }), "草稿");
    expect(plan).toMatchObject({ kind: "rework", targetStageId: "s-草稿", steps: 2 });
  });

  it("目标订单的流程里没有这个阶段名 → blocked", () => {
    const plan = planStageMove(order({ titles: ["草稿", "完稿"], currentIndex: 0 }), "上色");
    expect(plan.kind).toBe("blocked");
    if (plan.kind === "blocked") expect(plan.reason).toContain("没有「上色」阶段");
  });

  it("同一订单里同名阶段不唯一 → blocked", () => {
    const plan = planStageMove(order({ titles: ["草稿", "细化", "细化"], currentIndex: 0 }), "细化");
    expect(plan.kind).toBe("blocked");
    if (plan.kind === "blocked") expect(plan.reason).toContain("两个同名");
  });

  it("终态订单不能拖拽改阶段", () => {
    const plan = planStageMove(order({ status: "complete" }), "细化");
    expect(plan.kind).toBe("blocked");
  });

  it("未开工不能返工", () => {
    const plan = planStageMove(order({ currentIndex: 2, startedAt: null }), "草稿");
    expect(plan.kind).toBe("blocked");
    if (plan.kind === "blocked") expect(plan.reason).toContain("尚未开工");
  });

  it("拖到当前列 → noop，不写库", () => {
    const plan = planStageMove(order({ currentIndex: 1 }), "细化");
    expect(plan.kind).toBe("noop");
  });
});

describe("planStageMove · 跳级", () => {
  it("默认不允许跳级：跨阶段仍然 blocked", () => {
    const plan = planStageMove(order({ currentIndex: 0 }), "上色");
    expect(plan.kind).toBe("blocked");
  });

  it("allowSkip 时跨一个阶段 → skip，并列出被跳过的阶段", () => {
    const plan = planStageMove(order({ currentIndex: 0 }), "上色", { allowSkip: true });
    expect(plan).toMatchObject({ kind: "skip", targetStageId: "s-上色", steps: 2 });
    if (plan.kind === "skip") {
      expect(plan.skipped.map((s) => s.title)).toEqual(["细化"]);
    }
  });

  it("allowSkip 时跳到最后一个阶段 → skip，列出全部中间阶段", () => {
    const plan = planStageMove(order({ currentIndex: 0 }), "完稿", { allowSkip: true });
    if (plan.kind !== "skip") throw new Error("应为 skip");
    expect(plan.skipped.map((s) => s.title)).toEqual(["细化", "上色"]);
  });

  it("下一阶段永远走 advance，不算跳级", () => {
    const plan = planStageMove(order({ currentIndex: 1 }), "上色", { allowSkip: true });
    expect(plan.kind).toBe("advance");
  });

  it("未开工时不能跳级", () => {
    const plan = planStageMove(order({ currentIndex: 0, startedAt: null }), "上色", {
      allowSkip: true,
    });
    expect(plan.kind).toBe("blocked");
    if (plan.kind === "blocked") expect(plan.reason).toContain("尚未开工");
  });

  it("更早的阶段仍然是返工，不会被当成跳级", () => {
    const plan = planStageMove(order({ currentIndex: 3 }), "草稿", { allowSkip: true });
    expect(plan.kind).toBe("rework");
  });
});

describe("parseSkippedStages", () => {
  it("解析合法快照", () => {
    expect(
      parseSkippedStages('[{"stage_id":"a","title":"线稿","position":1}]'),
    ).toEqual([{ stageId: "a", title: "线稿" }]);
  });

  it("空值、坏 JSON、缺字段一律当空", () => {
    expect(parseSkippedStages(null)).toEqual([]);
    expect(parseSkippedStages("not-json")).toEqual([]);
    expect(parseSkippedStages('{"stage_id":"a"}')).toEqual([]);
    expect(parseSkippedStages('[{"stage_id":"a"}]')).toEqual([]);
  });
});

function event(partial: Partial<OrderEvent> & { kind: string; id: number }): OrderEvent {
  return {
    orderId: "o1",
    fromStageId: null,
    fromStageTitle: null,
    toStageId: null,
    toStageTitle: null,
    fromStatus: null,
    toStatus: null,
    movement: null,
    note: null,
    oldStartDate: null,
    oldDeliveryDate: null,
    newStartDate: null,
    newDeliveryDate: null,
    reason: null,
    changeSource: null,
    skippedStages: null,
    skipReason: null,
    occurredAt: "2026-11-20T10:00:00+08:00",
    ...partial,
  };
}

describe("skippedStageIds", () => {
  const titles = ["草稿", "线稿", "上色", "细化", "完稿"];
  const snapshot = (names: string[]) =>
    JSON.stringify(
      names.map((title, index) => ({ stage_id: `s-${title}`, title, position: index + 1 })),
    );

  it("跳级后：快照里的阶段标为已跳过", () => {
    const o = order({ titles, currentIndex: 2 }); // 上色
    const events = [
      event({ id: 1, kind: "created" }),
      event({
        id: 2,
        kind: "stage_skipped",
        fromStageId: "s-草稿",
        toStageId: "s-上色",
        skippedStages: snapshot(["线稿"]),
      }),
    ];
    expect(skippedStageIds(o, events)).toEqual(["s-线稿"]);
  });

  it("跳级后继续推进：已跳过的阶段仍然标为已跳过", () => {
    const o = order({ titles, currentIndex: 3 }); // 细化
    const events = [
      event({
        id: 2,
        kind: "stage_skipped",
        fromStageId: "s-草稿",
        toStageId: "s-上色",
        skippedStages: snapshot(["线稿"]),
      }),
      event({
        id: 3,
        kind: "stage_advanced",
        fromStageId: "s-上色",
        toStageId: "s-细化",
      }),
    ];
    expect(skippedStageIds(o, events)).toEqual(["s-线稿"]);
  });

  it("返工回到曾被跳过的阶段：该阶段恢复为当前，不再标已跳过", () => {
    const o = order({ titles, currentIndex: 1 }); // 线稿（当前）
    const events = [
      event({
        id: 2,
        kind: "stage_skipped",
        fromStageId: "s-草稿",
        toStageId: "s-上色",
        skippedStages: snapshot(["线稿"]),
      }),
      event({ id: 3, kind: "stage_reworked", fromStageId: "s-上色", toStageId: "s-线稿" }),
    ];
    expect(skippedStageIds(o, events)).toEqual([]);
  });

  it("返工到更早阶段后，被跳过的阶段回到未做", () => {
    const o = order({ titles, currentIndex: 0 });
    const events = [
      event({
        id: 2,
        kind: "stage_skipped",
        fromStageId: "s-草稿",
        toStageId: "s-细化",
        skippedStages: snapshot(["线稿", "上色"]),
      }),
      event({ id: 3, kind: "stage_reworked", fromStageId: "s-细化", toStageId: "s-草稿" }),
    ];
    expect(skippedStageIds(o, events)).toEqual([]);
  });

  it("两次跳级叠加：两批被跳过的阶段都保留", () => {
    const o = order({ titles, currentIndex: 4 }); // 完稿
    const events = [
      event({
        id: 2,
        kind: "stage_skipped",
        fromStageId: "s-草稿",
        toStageId: "s-上色",
        skippedStages: snapshot(["线稿"]),
      }),
      event({
        id: 3,
        kind: "stage_skipped",
        fromStageId: "s-上色",
        toStageId: "s-完稿",
        skippedStages: snapshot(["细化"]),
      }),
    ];
    expect(skippedStageIds(o, events)).toEqual(["s-线稿", "s-细化"]);
  });

  it("没有事件时不标已跳过", () => {
    expect(skippedStageIds(order({ titles, currentIndex: 0 }), [])).toEqual([]);
  });
});
