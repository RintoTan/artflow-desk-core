import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { snapshotMock } = vi.hoisted(() => ({ snapshotMock: vi.fn() }));

function snapshotPayload() {
  return ({

  orderId: "o1",
  orderAmountCents: 100_000,
  planMode: "full" as const,
  planItems: [],
  planTotalCents: 0,
  planMatchesOrder: false,
  records: [
    {
      id: "pay-1",
      orderId: "o1",
      scheduleId: null,
      kind: "full" as const,
      amountCents: 30_000,
      receivedOn: "2026-11-01",
      platformId: null,
      platformName: "米画师",
      feeRateBp: 500,
      feeCents: 1_500,
      netCents: 28_500,
      method: "wechat",
      note: null,
      voidedAt: null,
      voidReason: null,
      createdAt: "2026-11-01T00:00:00.000Z",
    },
  ],
  voidedRecords: [],
  grossReceivedCents: 30_000,
  feeTotalCents: 1_500,
  netReceivedCents: 28_500,
  refunds: [],
  voidedRefunds: [],
  refundTotalCents: 0,
  netRetainedCents: 28_500,
  remainingCents: 70_000,
  overReceivedCents: 0,
  unrecorded: false,
  hasRecordsWithoutPlan: true,
  cancelled: false,
  });
}


vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    paymentsApi: { ...actual.paymentsApi, snapshot: snapshotMock },
  };
});

import CancelOrderDialog, { parseYuan } from "./CancelOrderDialog";

function setup() {
  const onConfirm = vi.fn(async (_payload: unknown) => {});
  const onCancel = vi.fn();
  render(
    <CancelOrderDialog
      open
      orderId="o1"
      orderCode="AF-2026-0001"
      orderTitle="双人插画"
      currentStageTitle="细化"
      expectedRevision={3}
      busy={false}
      newRequestId={() => "req-1"}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />,
  );
  return { onConfirm, onCancel };
}

beforeEach(() => {
  vi.clearAllMocks();
  snapshotMock.mockImplementation(async () => snapshotPayload());
});

describe("取消订单时的退款选择", () => {
  it("不问「有没有退钱」就不让取消", () => {
    setup();
    const confirm = screen.getByRole("button", { name: "确认取消订单" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });

  it("选择没有退款时提交空退款列表", async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await user.click(screen.getByLabelText("没有退款"));
    await user.click(screen.getByRole("button", { name: "确认取消订单" }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm.mock.calls[0]?.[0] as unknown).toMatchObject({
      orderId: "o1",
      expectedRevision: 3,
      refundDecision: "none",
      refunds: [],
    });
  });

  it("选择有退款但金额为空时，按钮不可用并给出提示", async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await user.click(screen.getByLabelText("已经退款给客户"));

    const confirm = screen.getByRole("button", { name: "确认取消订单" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("请先填一笔有效的退款金额");

    await user.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("金额格式不对时不通过", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByLabelText("已经退款给客户"));
    const amount = screen.getByLabelText(/退款金额/) as HTMLInputElement;
    await user.type(amount, "12.345");
    expect(screen.getByText(/最多两位小数/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "确认取消订单" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("填了有效退款就按分提交，并带上关联的原收款", async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await user.click(screen.getByLabelText("已经退款给客户"));

    const amount = screen.getByLabelText(/退款金额/) as HTMLInputElement;
    await user.clear(amount);
    await user.type(amount, "200.50");
    await user.selectOptions(screen.getByLabelText("关联原收款"), "pay-1");

    await waitFor(() => expect(screen.getByText(/11-01/)).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "确认取消订单" }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    const payload = onConfirm.mock.calls[0]?.[0] as unknown as {
      refundDecision: string;
      refunds: Array<Record<string, unknown>>;
    };
    expect(payload.refundDecision).toBe("record");
    expect(payload.refunds).toHaveLength(1);
    expect(payload.refunds[0]).toMatchObject({ amountCents: 20_050, paymentRecordId: "pay-1" });
  });

  it("可以补第二笔退款", async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await user.click(screen.getByLabelText("已经退款给客户"));
    const first = screen.getByLabelText(/退款金额/) as HTMLInputElement;
    await user.type(first, "100");

    await user.click(screen.getByRole("button", { name: "再加一笔退款" }));
    const amounts = screen.getAllByLabelText(/退款金额/) as HTMLInputElement[];
    expect(amounts).toHaveLength(2);
    await user.type(amounts[1] as HTMLInputElement, "50");

    await user.click(screen.getByRole("button", { name: "确认取消订单" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    const payload = onConfirm.mock.calls[0]?.[0] as unknown as { refunds: Array<{ amountCents: number }> };
    expect(payload.refunds.map((r) => r.amountCents)).toEqual([10_000, 5_000]);
  });

  it("后端拒绝时留在对话框里显示原因", async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    onConfirm.mockImplementationOnce(async () => {
      throw { code: "INVALID", message: "退款日期不能晚于今天" };
    });
    await user.click(screen.getByLabelText("已经退款给客户"));
    await user.type(screen.getByLabelText(/退款金额/), "100");
    await user.click(screen.getByRole("button", { name: "确认取消订单" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("不能晚于今天"));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("保留订单时不提交任何东西", async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = setup();
    await user.click(screen.getByRole("button", { name: "保留订单" }));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("parseYuan", () => {
  it("只接受正数、最多两位小数", () => {
    expect(parseYuan("200")).toBe(20_000);
    expect(parseYuan("200.5")).toBe(20_050);
    expect(parseYuan("200.50")).toBe(20_050);
    expect(parseYuan("0")).toBeNull();
    expect(parseYuan("")).toBeNull();
    expect(parseYuan("1.234")).toBeNull();
    expect(parseYuan("-5")).toBeNull();
    expect(parseYuan("abc")).toBeNull();
  });
});
