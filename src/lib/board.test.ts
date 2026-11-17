import { describe, expect, it } from "vitest";

import type { OrderView, StageView } from "../bridge/commands";
import { buildBoard, planStageMove, stageKey } from "./board";

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
