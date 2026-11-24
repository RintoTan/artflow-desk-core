import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OrderFinanceView, PaymentRecordView, PlanItemView, RefundView } from "../bridge/commands";

const { snapshotMock, savePlanMock, createRecordMock, updateRecordMock, voidRecordMock } = vi.hoisted(
  () => ({
    snapshotMock: vi.fn(),
    savePlanMock: vi.fn(),
    createRecordMock: vi.fn(),
    updateRecordMock: vi.fn(),
    voidRecordMock: vi.fn(),
  }),
);
const { refundCreateMock, refundUpdateMock, refundVoidMock } = vi.hoisted(() => ({
  refundCreateMock: vi.fn(),
  refundUpdateMock: vi.fn(),
  refundVoidMock: vi.fn(),
}));
const { platformsMock, quoteMock } = vi.hoisted(() => ({
  platformsMock: vi.fn(),
  quoteMock: vi.fn(),
}));

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    paymentsApi: {
      snapshot: snapshotMock,
      savePlan: savePlanMock,
      createRecord: createRecordMock,
      updateRecord: updateRecordMock,
      voidRecord: voidRecordMock,
      quoteFee: quoteMock,
    },
    refundsApi: {
      create: refundCreateMock,
      update: refundUpdateMock,
      void: refundVoidMock,
    },
    financeApi: { ...actual.financeApi, platforms: platformsMock },
  };
});

import OrderFinancePanel from "./OrderFinancePanel";

function plan(over: Partial<PlanItemView> = {}): PlanItemView {
  return {
    id: "s1",
    kind: "deposit",
    amountCents: 30_000,
    expectedDate: null,
    sortPosition: 0,
    receivedCents: 0,
    outstandingCents: 30_000,
    status: "unpaid",
    ...over,
  };
}

function record(over: Partial<PaymentRecordView> = {}): PaymentRecordView {
  return {
    id: "r1",
    orderId: "o1",
    scheduleId: null,
    kind: "full",
    amountCents: 30_000,
    receivedOn: "2026-11-01",
    platformId: null,
    platformName: null,
    feeRateBp: null,
    feeCents: 0,
    netCents: 30_000,
    method: null,
    note: null,
    voidedAt: null,
    voidReason: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    ...over,
  };
}

function refund(over: Partial<RefundView> = {}): RefundView {
  return {
    id: "f1",
    orderId: "o1",
    paymentRecordId: "r1",
    amountCents: 20_000,
    refundedOn: "2026-11-20",
    method: null,
    note: null,
    voidedAt: null,
    voidReason: null,
    createdAt: "2026-11-20T00:00:00.000Z",
    unmatched: false,
    ...over,
  };
}

function view(over: Partial<OrderFinanceView> = {}): OrderFinanceView {
  return {
    orderId: "o1",
    orderAmountCents: 100_000,
    planMode: "none",
    planItems: [],
    planTotalCents: 0,
    planMatchesOrder: false,
    records: [],
    voidedRecords: [],
    refunds: [],
    voidedRefunds: [],
    grossReceivedCents: 0,
    feeTotalCents: 0,
    netReceivedCents: 0,
    refundTotalCents: 0,
    netRetainedCents: 0,
    remainingCents: 100_000,
    overReceivedCents: 0,
    unrecorded: true,
    hasRecordsWithoutPlan: false,
    cancelled: false,
    ...over,
  };
}

async function setup(initial: OrderFinanceView, platforms: unknown[] = []) {
  snapshotMock.mockImplementation(async () => initial);
  platformsMock.mockImplementation(async () => platforms);
  const onError = vi.fn();
  const onNotice = vi.fn();
  render(<OrderFinancePanel orderId="o1" cancelled={initial.cancelled} onError={onError} onNotice={onNotice} />);
  await waitFor(() => expect(snapshotMock).toHaveBeenCalled());
  return { onNotice };
}

beforeEach(() => {
  vi.clearAllMocks();
  quoteMock.mockImplementation(async () => ({ amountCents: 0, feeRateBp: null, suggestedFeeCents: null }));
});

describe("财务概览", () => {
  it("净到账与净留存分开显示，不混成一个「收入」", async () => {
    await setup(
      view({
        records: [record({ amountCents: 30_000, feeCents: 300, netCents: 29_700 })],
        refunds: [refund()],
        grossReceivedCents: 30_000,
        feeTotalCents: 300,
        netReceivedCents: 29_700,
        refundTotalCents: 20_000,
        netRetainedCents: 9_700,
        remainingCents: 70_000,
        unrecorded: false,
      }),
    );
    expect(screen.getByText("净到账")).toBeTruthy();
    expect(screen.getByText("净留存")).toBeTruthy();
    expect(screen.getByText("¥ 297.00")).toBeTruthy();
    expect(screen.getByText("¥ 97.00")).toBeTruthy();
  });

  it("订单金额未知时显示破折号，不显示 ¥ 0.00", async () => {
    await setup(view({ orderAmountCents: null, remainingCents: null }));
    const total = screen.getByText("订单总额").parentElement as HTMLElement;
    expect(total.textContent).toContain("—");
    expect(total.textContent).not.toContain("¥ 0.00");
  });

  it("金额为 0 时如实显示 ¥ 0.00", async () => {
    await setup(view({ orderAmountCents: 0, remainingCents: 0, unrecorded: false, planMatchesOrder: false }));
    const total = screen.getByText("订单总额").parentElement as HTMLElement;
    expect(total.textContent).toContain("¥ 0.00");
  });

  it("净留存为负时提示可能漏记了历史收款", async () => {
    await setup(
      view({
        refunds: [refund({ amountCents: 5_000, unmatched: true })],
        refundTotalCents: 5_000,
        netRetainedCents: -5_000,
        remainingCents: 100_000,
        unrecorded: false,
      }),
    );
    expect(screen.getByText(/退款金额超过当前已记录的净到账/)).toBeTruthy();
  });
});

describe("四种空态", () => {
  it("未记录收款信息时明确说明「不代表没有付款」", async () => {
    await setup(view({ unrecorded: true }));
    expect(screen.getByText("尚未记录收款信息")).toBeTruthy();
    expect(screen.getByText(/不代表客户实际上没有付款/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "设置付款计划" })).toBeTruthy();
  });

  it("有独立收款时单独说明，不归类成定金尾款", async () => {
    await setup(
      view({
        unrecorded: false,
        hasRecordsWithoutPlan: true,
        records: [record()],
        grossReceivedCents: 30_000,
        netReceivedCents: 30_000,
        remainingCents: 70_000,
      }),
    );
    expect(screen.getByText("存在独立收款记录")).toBeTruthy();
    expect(screen.getByText(/不会被算进定金或尾款/)).toBeTruthy();
  });

  it("计划与订单金额不一致时给出差额和调整入口", async () => {
    await setup(
      view({
        planMode: "full",
        planItems: [plan({ kind: "full", amountCents: 90_000, outstandingCents: 90_000 })],
        planTotalCents: 90_000,
        planMatchesOrder: false,
        unrecorded: false,
        remainingCents: 100_000,
      }),
    );
    const block = screen.getByText("付款计划需要调整").parentElement as HTMLElement;
    expect(block.textContent).toContain("¥ 1,000.00");
    expect(block.textContent).toContain("¥ 900.00");
    expect(block.textContent).toContain("¥ 100.00");
    expect(within(block).getByRole("button", { name: "调整付款计划" })).toBeTruthy();
  });

  it("多个空态可以同时出现", async () => {
    await setup(
      view({
        orderAmountCents: null,
        remainingCents: null,
        unrecorded: true,
        hasRecordsWithoutPlan: true,
        records: [record()],
        grossReceivedCents: 30_000,
        netReceivedCents: 30_000,
      }),
    );
    expect(screen.getByText("尚未记录收款信息")).toBeTruthy();
    expect(screen.getByText("订单金额尚未设置")).toBeTruthy();
    expect(screen.getByText("存在独立收款记录")).toBeTruthy();
  });
});

describe("付款计划", () => {
  it("定金尾款按订单总额算尾款并提交整套计划", async () => {
    const user = userEvent.setup();
    // 未记录状态里才有「设置付款计划」入口。
    await setup(view({ unrecorded: true }));
    await user.click(screen.getByRole("button", { name: "设置付款计划" }));
    await user.click(screen.getByRole("tab", { name: "定金 + 尾款" }));
    await user.type(screen.getByLabelText("定金（元）"), "300");
    expect(screen.getByText("¥ 700.00")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "保存计划" }));

    await waitFor(() => expect(savePlanMock).toHaveBeenCalledTimes(1));
    expect(savePlanMock.mock.calls[0]?.[0]).toMatchObject({
      orderId: "o1",
      confirmDetach: false,
      items: [
        { kind: "deposit", amountCents: 30_000 },
        { kind: "final", amountCents: 70_000 },
      ],
    });
  });

  it("订单金额未知时不能建计划", async () => {
    await setup(view({ orderAmountCents: null, remainingCents: null }));
    const button = screen.getByRole("button", { name: "设置付款计划" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("删除有关联流水的计划项要先确认，确认后带 confirmDetach", async () => {
    const user = userEvent.setup();
    savePlanMock.mockImplementationOnce(async () => {
      throw { code: "CONFLICT", message: "有 1 笔收款流水关联在将被移除的计划上，确认解除关联后才能保存（流水不会被删除）" };
    });
    await setup(
      view({
        unrecorded: false,
        planMode: "deposit_final",
        planItems: [
          plan({ id: "s1", kind: "deposit", amountCents: 30_000, receivedCents: 30_000, outstandingCents: 0, status: "settled" }),
          plan({ id: "s2", kind: "final", amountCents: 70_000, outstandingCents: 70_000 }),
        ],
        planTotalCents: 100_000,
        planMatchesOrder: true,
        records: [record({ scheduleId: "s1" })],
        grossReceivedCents: 30_000,
        netReceivedCents: 30_000,
        remainingCents: 70_000,
      }),
    );
    await user.click(screen.getByRole("button", { name: "编辑计划" }));
    await user.click(screen.getByRole("tab", { name: "全款" }));
    await user.click(screen.getByRole("button", { name: "保存计划" }));

    const confirm = await screen.findByRole("dialog", { name: "解除计划关联" });
    expect(confirm.textContent).toContain("不会被删除");
    expect(confirm.textContent).toContain("¥ 300.00");
    await user.click(within(confirm).getByRole("button", { name: "确认解除并保存" }));

    await waitFor(() => expect(savePlanMock).toHaveBeenCalledTimes(2));
    expect(savePlanMock.mock.calls[1]?.[0]).toMatchObject({ confirmDetach: true });
  });
});

describe("收款", () => {
  it("费率未配置时不预填手续费，并提示必须手动填", async () => {
    const user = userEvent.setup();
    await setup(view({ unrecorded: false }), [
      { id: "p1", name: "米画师", feeRateBp: null, archived: false, sortPosition: 0, createdAt: "", updatedAt: "" },
    ]);
    await user.click(screen.getByRole("button", { name: "记录收款" }));
    await user.selectOptions(screen.getByLabelText("收款平台"), "p1");
    await user.type(screen.getByLabelText("到账金额（元）"), "300");

    expect(screen.getByText(/不会替你按 0% 计算/)).toBeTruthy();
    expect((screen.getByLabelText("实际手续费（元）") as HTMLInputElement).value).toBe("");
  });

  it("没填手续费时不提交", async () => {
    const user = userEvent.setup();
    await setup(view({ unrecorded: false }));
    await user.click(screen.getByRole("button", { name: "记录收款" }));
    await user.type(screen.getByLabelText("到账金额（元）"), "300");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(createRecordMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("实际手续费");
  });
});

describe("退款", () => {
  it("未关联退款显示核验不了，并提供关联入口", async () => {
    await setup(
      view({
        unrecorded: false,
        records: [record()],
        refunds: [refund({ paymentRecordId: null, unmatched: true })],
        refundTotalCents: 20_000,
        grossReceivedCents: 30_000,
        netReceivedCents: 30_000,
        netRetainedCents: 10_000,
        remainingCents: 70_000,
      }),
    );
    expect(screen.getByText(/核验不了可退款余额/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "关联原收款" })).toBeTruthy();
  });

  it("已关联的退款不再提供「未关联」选项", async () => {
    const user = userEvent.setup();
    await setup(
      view({
        unrecorded: false,
        records: [record()],
        refunds: [refund()],
        refundTotalCents: 20_000,
        grossReceivedCents: 30_000,
        netReceivedCents: 30_000,
        netRetainedCents: 10_000,
        remainingCents: 70_000,
      }),
    );
    const edits = screen.getAllByRole("button", { name: "编辑" });
    await user.click(edits[edits.length - 1] as HTMLElement);
    const select = screen.getByLabelText("原收款") as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).not.toContain("");
    expect(screen.getByText(/只能更换原收款，不能改回未关联/)).toBeTruthy();
  });

  it("作废退款必须填原因", async () => {
    const user = userEvent.setup();
    await setup(
      view({
        unrecorded: false,
        refunds: [refund()],
        refundTotalCents: 20_000,
        netRetainedCents: -20_000,
        remainingCents: 100_000,
      }),
    );
    await user.click(screen.getByRole("button", { name: "作废" }));
    await user.click(screen.getByRole("button", { name: "确认作废" }));
    expect(refundVoidMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("作废原因");
  });
});

describe("取消订单后的只读态", () => {
  it("收款与计划只读，退款仍可记录", async () => {
    await setup(
      view({
        cancelled: true,
        unrecorded: false,
        planMode: "full",
        planItems: [plan({ kind: "full", amountCents: 100_000, outstandingCents: 100_000 })],
        planTotalCents: 100_000,
        planMatchesOrder: true,
        records: [record()],
        grossReceivedCents: 30_000,
        netReceivedCents: 30_000,
        remainingCents: 70_000,
      }),
    );
    expect(screen.queryByRole("button", { name: "记录收款" })).toBeNull();
    expect(screen.queryByRole("button", { name: "编辑计划" })).toBeNull();
    expect(screen.getAllByText("只读").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("button", { name: "记录退款" })).toBeTruthy();
    expect(screen.getByText(/取消前未收差额/)).toBeTruthy();
  });
});
