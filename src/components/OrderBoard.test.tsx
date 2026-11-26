import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { OrderView, TemplateView } from "../bridge/commands";
import OrderBoard from "./OrderBoard";

function template(id: string, name: string, stages: [string, string][], isDefault = false): TemplateView {
  const steps = stages.map(([stepId, title], index) => ({ stepId, title, position: index }));
  return {
    id,
    name,
    isDefault,
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
    id: partial.id ?? "o",
    code: partial.code ?? "AF-2026-0001",
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

const TPL_A = template(
  "tpl-a",
  "插画 A",
  [
    ["a1", "草稿"],
    ["a2", "线稿"],
  ],
  true,
);
const TPL_B = template("tpl-b", "插画 B", [["b1", "构思"]]);

function props(overrides: Partial<Parameters<typeof OrderBoard>[0]> = {}) {
  return {
    orders: [] as OrderView[],
    templates: [TPL_A, TPL_B],
    onOpen: vi.fn(),
    formatMoney: (cents: number | null) => (cents === null ? "未知" : `¥${cents / 100}`),
    formatDate: (value: string | null) => value ?? "未排期",
    sortMode: "manual" as const,
    ...overrides,
  };
}

/** 平铺网格里的订单编号顺序。 */
function codes(): string[] {
  return Array.from(document.querySelectorAll(".flat-card-code")).map(
    (node) => node.textContent?.replace(/[^A-Z0-9-]/g, "") ?? "",
  );
}

describe("平铺看板", () => {
  it("默认按默认模板平铺，卡片带缩略图位", () => {
    render(
      <OrderBoard
        {...props({
          orders: [
            order({ id: "a", code: "AF-0001" }),
            order({ id: "b", code: "AF-0002", stageTemplateId: "tpl-b", currentStageId: "b1" }),
          ],
        })}
      />,
    );
    // 默认模板是 A，B 的订单不在其中
    expect(codes()).toEqual(["AF-0001"]);
    expect(document.querySelectorAll(".flat-card .order-thumb").length).toBe(1);
  });

  it("切到全部流程时两个模板的订单都在", async () => {
    const user = userEvent.setup();
    render(
      <OrderBoard
        {...props({
          orders: [
            order({ id: "a", code: "AF-0001" }),
            order({ id: "b", code: "AF-0002", stageTemplateId: "tpl-b", currentStageId: "b1" }),
          ],
        })}
      />,
    );
    await user.selectOptions(screen.getByLabelText("按流程模板筛选"), "all");
    expect(new Set(codes())).toEqual(new Set(["AF-0001", "AF-0002"]));
  });

  it("阶段筛选只保留该阶段的订单", async () => {
    const user = userEvent.setup();
    render(
      <OrderBoard
        {...props({
          orders: [
            order({ id: "a", code: "AF-0001", currentStageId: "a1" }),
            order({ id: "b", code: "AF-0002", currentStageId: "a2" }),
          ],
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "线稿" }));
    expect(codes()).toEqual(["AF-0002"]);
  });

  it("置顶订单排在普通订单之前", () => {
    render(
      <OrderBoard
        {...props({
          orders: [
            order({ id: "n", code: "AF-0001", queuePosition: 0 }),
            order({ id: "p", code: "AF-0002", queuePosition: 9, pinnedAt: "2026-11-20T00:00:00Z" }),
          ],
        })}
      />,
    );
    expect(codes()).toEqual(["AF-0002", "AF-0001"]);
  });

  it("交付日期排序在整块网格内生效", () => {
    render(
      <OrderBoard
        {...props({
          sortMode: "deadline",
          orders: [
            order({ id: "late", code: "AF-0001", plannedDeliveryDate: "2026-12-20" }),
            order({ id: "early", code: "AF-0002", plannedDeliveryDate: "2026-11-01" }),
          ],
        })}
      />,
    );
    expect(codes()).toEqual(["AF-0002", "AF-0001"]);
  });

  it("筛完没有结果时给出说明", async () => {
    const user = userEvent.setup();
    render(<OrderBoard {...props({ orders: [order({ code: "AF-0001", currentStageId: "a1" })] })} />);
    await user.click(screen.getByRole("button", { name: "线稿" }));
    expect(within(document.body).getByText("这个条件下没有订单。")).toBeInTheDocument();
  });
});
