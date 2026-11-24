import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { summaryMock } = vi.hoisted(() => ({ summaryMock: vi.fn() }));

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return { ...actual, financeStatsApi: { ...actual.financeStatsApi, clientSummary: summaryMock } };
});

import ClientFinancePanel from "./ClientFinancePanel";

function row(over: Record<string, number> = {}) {
  return {
    clientId: "c1",
    displayName: "客户甲",
    orders: 2,
    orderAmountCents: 150_000,
    unknownAmountOrders: 0,
    grossReceivedCents: 100_000,
    feeTotalCents: 1_000,
    netReceivedCents: 99_000,
    refundTotalCents: 10_000,
    netRetainedCents: 89_000,
    remainingCents: 50_000,
    overReceivedCents: 0,
    unrecordedOrders: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  summaryMock.mockImplementation(async () => row());
});

describe("客户财务概览", () => {
  it("三个主指标分开显示，合同金额与到账不混为一谈", async () => {
    render(<ClientFinancePanel clientId="c1" />);
    await waitFor(() => expect(screen.getByText("¥ 1,500.00")).toBeTruthy());
    expect(screen.getByText("累计委托金额")).toBeTruthy();
    expect(screen.getByText("¥ 1,000.00")).toBeTruthy();
    expect(screen.getByText("¥ 500.00")).toBeTruthy();
    expect(screen.getByText(/合同金额，不等于已收到的钱/)).toBeTruthy();
  });

  it("净留存为负时标红而不是截断", async () => {
    summaryMock.mockImplementation(async () => row({ netRetainedCents: -5_000 }));
    render(<ClientFinancePanel clientId="c1" />);
    await waitFor(() => expect(screen.getByText("-¥ 50.00")).toBeTruthy());
  });

  it("未记录收款信息单独说明，不暗示客户没付钱", async () => {
    summaryMock.mockImplementation(async () => row({ unrecordedOrders: 3, unknownAmountOrders: 1 }));
    render(<ClientFinancePanel clientId="c1" />);
    await waitFor(() =>
      expect(screen.getByText(/3 单未记录收款信息（不代表客户没付款）/)).toBeTruthy(),
    );
    expect(screen.getByText(/1 单金额未知/)).toBeTruthy();
  });

  it("财务读取失败时单独报错并可重试，不影响其它内容", async () => {
    const user = userEvent.setup();
    summaryMock.mockImplementationOnce(async () => {
      throw { code: "DB", message: "数据库操作失败：database is locked" };
    });
    render(<ClientFinancePanel clientId="c1" />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("database is locked"));

    await user.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.getByText("¥ 1,500.00")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
