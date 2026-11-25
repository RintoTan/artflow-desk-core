import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FinanceStatsReport } from "../bridge/commands";

const { reportMock } = vi.hoisted(() => ({ reportMock: vi.fn() }));

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    financeStatsApi: { report: reportMock },
  };
});

import FinanceStatsPanel from "./FinanceStatsPanel";

function totals(over: Partial<FinanceStatsReport["lifetime"]> = {}) {
  return {
    grossReceivedCents: 100_000,
    feeTotalCents: 1_000,
    netReceivedCents: 99_000,
    refundTotalCents: 20_000,
    netRetainedCents: 79_000,
    ...over,
  };
}

function report(over: Partial<FinanceStatsReport> = {}): FinanceStatsReport {
  return {
    range: "all",
    timezone: "Asia/Shanghai",
    fromMonth: "2025-11",
    toMonth: "2026-11",
    lifetime: totals(),
    current: {
      remainingCents: 70_000,
      overReceivedCents: 0,
      unrecordedOrders: 0,
      unknownAmountOrders: 0,
      planMismatchOrders: 0,
    },
    period: totals(),
    monthly: [
      {
        month: "2025-11",
        grossReceivedCents: 100_000,
        feeTotalCents: 1_000,
        netReceivedCents: 99_000,
        refundTotalCents: 0,
        netRetainedCents: 99_000,
      },
      {
        month: "2025-12",
        grossReceivedCents: 0,
        feeTotalCents: 0,
        netReceivedCents: 0,
        refundTotalCents: 20_000,
        netRetainedCents: -20_000,
      },
    ],
    annual: [
      { year: "2025", grossReceivedCents: 100_000, feeTotalCents: 1_000, netReceivedCents: 99_000 },
    ],
    expected: {
      overdueCents: 0,
      overdueCount: 0,
      months: [],
      unscheduledCents: 0,
      unscheduledCount: 0,
      beyondCents: 0,
      beyondCount: 0,
      noPlanOrders: 0,
    },
    byPlatform: [
      {
        platformName: "米画师",
        count: 1,
        grossReceivedCents: 100_000,
        feeTotalCents: 1_000,
        netReceivedCents: 99_000,
      },
    ],
    byMethod: [
      { method: "wechat", count: 1, grossReceivedCents: 100_000, feeTotalCents: 1_000, netReceivedCents: 99_000 },
    ],
    byClient: [
      {
        clientId: "c1",
        displayName: "客户甲",
        orders: 1,
        orderAmountCents: 120_000,
        unknownAmountOrders: 0,
        grossReceivedCents: 100_000,
        feeTotalCents: 1_000,
        netReceivedCents: 99_000,
        refundTotalCents: 20_000,
        netRetainedCents: 79_000,
        remainingCents: 20_000,
        overReceivedCents: 0,
        unrecordedOrders: 0,
      },
    ],
    byOrderType: [
      {
        orderType: "插画",
        orders: 1,
        orderAmountCents: 120_000,
        unknownAmountOrders: 0,
        grossReceivedCents: 100_000,
        feeTotalCents: 1_000,
        netReceivedCents: 99_000,
        refundTotalCents: 20_000,
        netRetainedCents: 79_000,
      },
    ],
    basis: ["实际到账按收款日期归属月份。"],
    ...over,
  };
}

async function setup(payload: FinanceStatsReport, range = "all") {
  reportMock.mockImplementation(async () => payload);
  const onRangeChange = vi.fn();
  render(
    <MemoryRouter>
      <FinanceStatsPanel range={range} onRangeChange={onRangeChange} />
    </MemoryRouter>,
  );
  await waitFor(() => expect(reportMock).toHaveBeenCalled());
  return { onRangeChange };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("财务统计面板", () => {
  it("累计金额直接用后端返回值，不在前端相加", async () => {
    await setup(report());
    // 同一笔数字会在累计、区间、平台分组里各出现一次，这里只验证它出现了。
    expect(screen.getAllByText("¥ 1,000.00").length).toBeGreaterThan(0); // 到账
    expect(screen.getAllByText("¥ 990.00").length).toBeGreaterThan(0); // 净到账
    expect(screen.getAllByText("¥ 790.00").length).toBeGreaterThan(0); // 净留存
  });

  it("未记录收款信息单独提示，且说明不代表没付钱", async () => {
    await setup(
      report({
        current: {
          remainingCents: 0,
          overReceivedCents: 0,
          unrecordedOrders: 3,
          unknownAmountOrders: 1,
          planMismatchOrders: 0,
        },
      }),
    );
    expect(screen.getByText("3 单")).toBeTruthy();
    expect(screen.getByText(/不代表客户没有付款/)).toBeTruthy();
  });

  it("只有退款的月份，净留存显示负数并带精确 tooltip", async () => {
    await setup(report());
    const december = screen.getByText("净留存 -¥ 200.00");
    expect(december.className).toContain("is-negative");
    expect(december.getAttribute("title")).toContain("退款 ¥ 200.00");
  });

  it("没有任何流水时给空态，而不是空白图", async () => {
    await setup(
      report({
        lifetime: totals({
          grossReceivedCents: 0,
          feeTotalCents: 0,
          netReceivedCents: 0,
          refundTotalCents: 0,
          netRetainedCents: 0,
        }),
        monthly: [],
        annual: [],
        byPlatform: [],
        byMethod: [],
        byOrderType: [],
      }),
    );
    expect(screen.getByText("当前没有已记录的收款流水。")).toBeTruthy();
    expect(screen.getByText("还没有可用于统计的年度收款")).toBeTruthy();
    expect(screen.getByText("没有可用于统计的有效订单金额。")).toBeTruthy();
  });

  it("切换范围会回调上层，由上层统一改 URL", async () => {
    const user = userEvent.setup();
    const { onRangeChange } = await setup(report(), "thisMonth");
    await user.click(screen.getByRole("button", { name: "近 12 个月" }));
    expect(onRangeChange).toHaveBeenCalledWith("last12");
  });

  it("快速切换时旧请求不许覆盖新结果", async () => {
    const slow = report({ lifetime: totals({ grossReceivedCents: 111 }) });
    const fast = report({ lifetime: totals({ grossReceivedCents: 222 }) });
    let releaseSlow: (value: FinanceStatsReport) => void = () => {};
    reportMock
      .mockImplementationOnce(
        () => new Promise<FinanceStatsReport>((resolve) => {
          releaseSlow = resolve;
        }),
      )
      .mockImplementationOnce(async () => fast);

    const onRangeChange = vi.fn();
    const { rerender } = render(
      <MemoryRouter>
        <FinanceStatsPanel range="all" onRangeChange={onRangeChange} />
      </MemoryRouter>,
    );
    rerender(
      <MemoryRouter>
        <FinanceStatsPanel range="last6" onRangeChange={onRangeChange} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("¥ 2.22")).toBeTruthy());

    // 旧的慢请求此刻才回来：不许把界面改回 111
    releaseSlow(slow);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.getByText("¥ 2.22")).toBeTruthy();
    expect(screen.queryByText("¥ 1.11")).toBeNull();
  });

  it("请求失败时保留上一份数据并提示", async () => {
    reportMock.mockImplementationOnce(async () => report());
    const onRangeChange = vi.fn();
    const { rerender } = render(
      <MemoryRouter>
        <FinanceStatsPanel range="all" onRangeChange={onRangeChange} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getAllByText("¥ 1,000.00").length).toBeGreaterThan(0));

    reportMock.mockImplementationOnce(async () => {
      throw { code: "DB", message: "数据库操作失败：database is locked" };
    });
    reportMock.mockImplementation(async () => report());
    rerender(
      <MemoryRouter>
        <FinanceStatsPanel range="last6" onRangeChange={onRangeChange} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getAllByText("¥ 1,000.00").length).toBeGreaterThan(0);
  });

  it("按客户表格用稳定身份显示，并给出累计口径说明", async () => {
    await setup(report());
    expect(screen.getByText("按客户（累计）")).toBeTruthy();
    expect(screen.getByText(/同名客户不会合并/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "客户甲" })).toBeTruthy();
  });
});
