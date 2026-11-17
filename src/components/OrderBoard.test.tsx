import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { OrderView, TemplateView } from "../bridge/commands";
import OrderBoard from "./OrderBoard";

function template(id: string, name: string, stages: [string, string][]): TemplateView {
  const steps = stages.map(([stepId, title], index) => ({ stepId, title, position: index }));
  return {
    id,
    name,
    isDefault: false,
    revision: 1,
    steps,
    stepCount: steps.length,
    usageCount: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  } as unknown as TemplateView;
}

function order(partial: Partial<OrderView>): OrderView {
  return {
    id: "o",
    code: "AF-2026-0001",
    title: "示例订单",
    clientId: "c1",
    clientName: "林小满",
    commissionType: null,
    source: null,
    stageTemplateId: "tpl-a",
    amountCents: 88000,
    note: null,
    status: "active",
    currentStageId: "a1",
    currentStageTitle: "草稿",
    currentStageIndex: 0,
    stages: [],
    queuePosition: 1,
    plannedStartDate: null,
    plannedDeliveryDate: "2026-11-20",
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    deadlineState: "scheduled",
    workState: "queued",
    capabilities: {} as OrderView["capabilities"],
    revision: 1,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...partial,
  } as OrderView;
}

const TPL_A = template("tpl-a", "插画 A", [
  ["a1", "草稿"],
  ["a2", "线稿"],
  ["a3", "固有色"],
]);
const TPL_B = template("tpl-b", "插画 B", [
  ["b1", "构思"],
  ["b2", "定稿"],
]);

function props(overrides: Partial<Parameters<typeof OrderBoard>[0]> = {}) {
  return {
    orders: [] as OrderView[],
    templates: [TPL_A, TPL_B],
    onOpen: vi.fn(),
    formatMoney: (cents: number | null) => (cents === null ? "未知" : `¥${cents / 100}`),
    formatDate: (value: string | null) => value ?? "未排期",
    ...overrides,
  };
}

describe("OrderBoard（扁平总览）", () => {
  it("不再有总览/聚焦子模式，也不再有阶段列", () => {
    render(<OrderBoard {...props({ orders: [order({})] })} />);
    expect(document.querySelector(".board-mode")).toBeNull();
    expect(document.querySelector(".board-nav")).toBeNull();
    expect(document.querySelector(".board-col")).toBeNull();
  });

  it("展示全部订单，包含已结束订单且排在活动订单之后", () => {
    const list = [
      order({ id: "done", code: "AF-0003", status: "complete" }),
      order({ id: "live", code: "AF-0001" }),
    ];
    render(<OrderBoard {...props({ orders: list })} />);
    const cards = Array.from(document.querySelectorAll(".flat-card code, .flat-card-code"));
    expect(cards.map((n) => n.textContent)).toEqual(["AF-0001", "AF-0003"]);
  });

  it("按流程模板筛选后只留该模板订单，并列出该模板自己的阶段", async () => {
    const user = userEvent.setup();
    render(
      <OrderBoard
        {...props({
          orders: [
            order({ id: "a", stageTemplateId: "tpl-a", currentStageId: "a1" }),
            order({ id: "b", stageTemplateId: "tpl-b", currentStageId: "b1", currentStageTitle: "构思" }),
          ],
        })}
      />,
    );
    await user.selectOptions(screen.getByLabelText("按流程模板筛选"), "tpl-b");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    const chips = Array.from(document.querySelectorAll(".stage-chip")).map((n) => n.textContent);
    expect(chips[0]).toBe("全部阶段");
    expect(chips.slice(1).map((t) => t?.replace(/\d+$/, ""))).toEqual(["构思", "定稿"]);
  });

  it("阶段筛选按 (模板, 阶段) 匹配，同名阶段不会互相命中", async () => {
    const user = userEvent.setup();
    // 两个模板都有「草稿」，ID 不同
    const tplC = template("tpl-c", "插画 C", [["c1", "草稿"]]);
    render(
      <OrderBoard
        {...props({
          templates: [TPL_A, tplC],
          orders: [
            order({ id: "a", stageTemplateId: "tpl-a", currentStageId: "a1", currentStageTitle: "草稿" }),
            order({ id: "c", stageTemplateId: "tpl-c", currentStageId: "c1", currentStageTitle: "草稿" }),
          ],
        })}
      />,
    );
    await user.selectOptions(screen.getByLabelText("按阶段筛选（按流程分组）"), "tpl-c:c1");
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(within(items[0]!).getByText("AF-2026-0001")).toBeInTheDocument();
  });

  it("切换模板会清掉与新模板不兼容的阶段条件", async () => {
    const user = userEvent.setup();
    render(<OrderBoard {...props({ orders: [order({})] })} />);
    await user.selectOptions(screen.getByLabelText("按阶段筛选（按流程分组）"), "tpl-a:a1");
    expect(document.querySelector(".board-count")?.textContent).toContain("1 / 1");
    await user.selectOptions(screen.getByLabelText("按流程模板筛选"), "tpl-b");
    expect(document.querySelector(".board-count")?.textContent).toContain("/ 1");
    expect((screen.getByLabelText("按流程模板筛选") as HTMLSelectElement).value).toBe("tpl-b");
  });

  it("卡片只有打开详情，没有阶段操作按钮", () => {
    render(<OrderBoard {...props({ orders: [order({})] })} />);
    expect(screen.queryByRole("button", { name: /阶段操作/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /→/ })).toBeNull();
    expect(screen.getByRole("button", { name: /打开 AF-2026-0001/ })).toBeInTheDocument();
  });

  it("无结果时给出空状态与清除入口", async () => {
    const user = userEvent.setup();
    render(
      <OrderBoard
        {...props({ orders: [order({ currentStageId: "a1" })] })}
      />,
    );
    await user.selectOptions(screen.getByLabelText("按阶段筛选（按流程分组）"), "tpl-a:a3");
    expect(document.querySelector(".board-empty-state")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "清除看板筛选" }).length).toBeGreaterThan(0);
  });
});
