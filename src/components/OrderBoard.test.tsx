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

/** 阶段名现在同时出现在导航 chip 与列头，取列必须按列头定位。 */
function columnEl(title: string): HTMLElement {
  const cols = Array.from(document.querySelectorAll<HTMLElement>(".board-col"));
  const hit = cols.find(
    (col) => col.querySelector(".board-col-title")?.textContent?.trim() === title,
  );
  if (!hit) throw new Error(`找不到阶段列：${title}`);
  return hit;
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
    expect(columnEl("草稿")).toBeTruthy();
    expect(columnEl("线稿")).toBeTruthy();
    expect(screen.getAllByText(/1 · ¥880/)).toHaveLength(3);
  });

  it("拖到下一阶段后先出确认框，取消则零写入", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn(async () => {});
    render(<OrderBoard {...baseProps({ onApply })} />);

    drop(columnEl("线稿"), "o1");
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("推进阶段");
    expect(dialog).toHaveTextContent("线稿");

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("确认后只提交一次候选动作，并带上解析出的目标阶段 ID", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn(async () => {});
    render(<OrderBoard {...baseProps({ onApply })} />);

    drop(columnEl("线稿"), "o1");
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

    drop(columnEl("上色"), "o1");
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

  it("空阶段也能作为放置目标：列存在但没有卡片", () => {
    render(<OrderBoard {...baseProps({ orders: [order()] })} />);
    // 只有一张单，但它自己的后续阶段都作为空列出现，可以拖过去。
    const titles = Array.from(document.querySelectorAll(".board-col-title")).map(
      (n) => n.textContent,
    );
    expect(titles).toEqual(["草稿", "线稿", "上色"]);
    expect(document.querySelectorAll(".board-empty")).toHaveLength(2);
  });

  it("键盘可达：卡片上的「→ 下一阶段」按钮能打开同一个确认框", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn(async () => {});
    render(<OrderBoard {...baseProps({ onApply })} />);

    // o1 在草稿列，下一阶段是线稿。
    await user.click(screen.getAllByRole("button", { name: "→ 线稿" })[0]!);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("线稿");

    await user.click(screen.getByRole("button", { name: "确认变更" }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("Esc 取消确认框且零写入", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn(async () => {});
    render(<OrderBoard {...baseProps({ onApply })} />);

    drop(columnEl("线稿"), "o1");
    await screen.findByRole("alertdialog");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
  });
});
