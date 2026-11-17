import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { OrderView, StageView } from "../bridge/commands";
import OrderBoard from "./OrderBoard";

function stages(titles: string[], current: number): StageView[] {
  return titles.map((title, i) => ({
    id: `s-${title}`,
    title,
    position: i,
    isCurrent: i === current,
  }));
}

function order(partial: Partial<OrderView> = {}): OrderView {
  const titles = ["草稿", "线稿", "上色"];
  return {
    id: "o1",
    code: "AF-2026-0001",
    title: "双人插画",
    clientId: "c1",
    clientName: "林小满",
    commissionType: null,
    source: "米画师",
    amountCents: 88000,
    note: null,
    status: "active",
    workState: "inProgress",
    currentStageId: "s-线稿",
    currentStageTitle: "线稿",
    currentStageIndex: 1,
    stageCount: 3,
    stages: stages(titles, 1),
    queuePosition: 0,
    plannedStartDate: null,
    plannedDeliveryDate: "2026-11-20",
    deadlineState: "scheduled",
    startedAt: "2026-11-01T00:00:00Z",
    completedAt: null,
    cancelledAt: null,
    revision: 2,
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
    ...partial,
  };
}

/** 三列都要有订单：空列不会被渲染，否则没法把卡片拖到"没人"的阶段。 */
function threeOrders() {
  return [
    order({ id: "o1", currentStageId: "s-草稿", currentStageTitle: "草稿", currentStageIndex: 0, stages: stages(["草稿", "线稿", "上色"], 0) }),
    order({ id: "o2", code: "AF-2026-0002", currentStageId: "s-线稿", currentStageTitle: "线稿", currentStageIndex: 1 }),
    order({ id: "o3", code: "AF-2026-0003", currentStageId: "s-上色", currentStageTitle: "上色", currentStageIndex: 2, stages: stages(["草稿", "线稿", "上色"], 2) }),
  ];
}

function baseProps(overrides: Partial<Parameters<typeof OrderBoard>[0]> = {}) {
  return {
    orders: threeOrders(),
    busy: false,
    onOpen: vi.fn(),
    onApply: vi.fn(async () => {}),
    formatMoney: (cents: number | null) => (cents === null ? "未知" : `¥${cents / 100}`),
    formatDate: (value: string | null) => value ?? "未排期",
    onError: vi.fn(),
    ...overrides,
  };
}

/** jsdom 没有真实 DataTransfer，手工造一个最小实现。 */
function drop(target: HTMLElement, orderId: string) {
  const store: Record<string, string> = { "text/minidesk-order": orderId };
  fireEvent.drop(target, {
    dataTransfer: {
      getData: (key: string) => store[key] ?? "",
      setData: (key: string, value: string) => {
        store[key] = value;
      },
      effectAllowed: "move",
    },
  });
}

describe("OrderBoard 真实交互", () => {
  it("按阶段名分列，列头显示数量与已知金额合计", () => {
    render(<OrderBoard {...baseProps()} />);
    expect(screen.getByText("草稿")).toBeInTheDocument();
    expect(screen.getByText("线稿")).toBeInTheDocument();
    expect(screen.getAllByText(/1 · ¥880/)).toHaveLength(3);
  });

  it("拖到下一阶段后先出确认框，取消则零写入", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn(async () => {});
    render(<OrderBoard {...baseProps({ onApply })} />);

    drop(screen.getByText("线稿").closest(".board-col") as HTMLElement, "o1");
    const dialog = await screen.findByRole("dialog", { name: "确认阶段变更" });
    expect(dialog).toHaveTextContent("推进阶段");
    expect(dialog).toHaveTextContent("线稿");

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("确认后只提交一次候选动作，并带上解析出的目标阶段 ID", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn(async () => {});
    render(<OrderBoard {...baseProps({ onApply })} />);

    drop(screen.getByText("线稿").closest(".board-col") as HTMLElement, "o1");
    await user.click(screen.getByRole("button", { name: "确认变更" }));

    expect(onApply).toHaveBeenCalledTimes(1);
    const [submittedOrder, plan] = onApply.mock.calls[0] as unknown as [
      OrderView,
      { kind: string; targetStageId: string },
    ];
    expect(submittedOrder.id).toBe("o1");
    expect(plan).toMatchObject({ kind: "advance", targetStageId: "s-线稿" });
  });

  it("跨两个阶段直接拒绝，不弹确认框", async () => {
    const onApply = vi.fn(async () => {});
    const onError = vi.fn();
    render(<OrderBoard {...baseProps({ onApply, onError })} />);

    drop(screen.getByText("上色").closest(".board-col") as HTMLElement, "o1");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("不能跳过中间阶段"));
  });

  it("终态订单不进阶段列，而是单独列出", () => {
    render(
      <OrderBoard
        {...baseProps({
          orders: [order({ status: "complete", workState: "completed" })],
        })}
      />,
    );
    expect(screen.getByText(/已结束（1）/)).toBeInTheDocument();
    expect(document.querySelectorAll(".board-col")).toHaveLength(0);
  });

  it("金额未知的订单计入数量但不计入合计", () => {
    render(
      <OrderBoard
        {...baseProps({
          orders: [
            order({ id: "o1", amountCents: 10000 }),
            order({ id: "o2", code: "AF-2026-0002", amountCents: null }),
            order({ id: "o3", code: "AF-2026-0003", amountCents: null }),
            order({ id: "o4", code: "AF-2026-0004", amountCents: null }),
          ],
        })}
      />,
    );
    // 四张单都在"线稿"列：数量 4，已知合计只有 100，未知 3 张单独标注。
    expect(screen.getByText(/4 · ¥100/)).toBeInTheDocument();
    expect(screen.getByText(/\+3 未知/)).toBeInTheDocument();
  });
});
