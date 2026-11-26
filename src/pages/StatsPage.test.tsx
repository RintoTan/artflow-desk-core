import { MemoryRouter } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CompletedEventRow, StatsReport } from "../bridge/commands";

function report(overrides: Partial<StatsReport> = {}): StatsReport {
  return {
    range: "thisMonth",
    timezone: "Asia/Shanghai",
    fromMonth: "2026-11",
    toMonth: "2026-11",
    months: [
      {
        month: "2026-11",
        created: 3,
        completed: 4,
        cancelled: 1,
        amountCents: 123_456,
        knownOrders: 2,
        unknownOrders: 1,
      },
    ],
    totals: {
      month: "2026-11~2026-11",
      created: 3,
      completed: 4,
      cancelled: 1,
      amountCents: 123_456,
      knownOrders: 2,
      unknownOrders: 1,
    },
    basis: ["口径一", "口径二"],
    ...overrides,
  };
}

const reportFn = vi.fn(async (_range: string) => report());
const completedFn = vi.fn(async (): Promise<CompletedEventRow[]> => []);
const exportSummary = vi.fn(async () => ({ path: "/tmp/s.csv", rows: 2, bytes: 100 }));
const saveDialog = vi.fn(async () => null as string | null);

const financeReportFn = vi.fn(async () => ({
  range: "thisMonth",
  timezone: "Asia/Shanghai",
  fromMonth: "2026-11",
  toMonth: "2026-11",
  lifetime: {
    grossReceivedCents: 0,
    feeTotalCents: 0,
    netReceivedCents: 0,
    refundTotalCents: 0,
    netRetainedCents: 0,
  },
  current: {
    remainingCents: 0,
    overReceivedCents: 0,
    unrecordedOrders: 0,
    unknownAmountOrders: 0,
    planMismatchOrders: 0,
  },
  period: {
    grossReceivedCents: 0,
    feeTotalCents: 0,
    netReceivedCents: 0,
    refundTotalCents: 0,
    netRetainedCents: 0,
  },
  monthly: [],
  annual: [],
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
  byPlatform: [],
  byMethod: [],
  byClient: [],
  byOrderType: [],
  basis: ["口径"],
}));

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    financeStatsApi: { report: financeReportFn },
    statsApi: {
      report: reportFn,
      completedEvents: completedFn,
      exportSummary,
      exportOrders: vi.fn(),
      dashboard: vi.fn(),
    },
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => saveDialog(...(args as [])),
}));

async function setup(initial = "/stats") {
  const { default: StatsPage } = await import("./StatsPage");
  render(
    <MemoryRouter initialEntries={[initial]}>
      <StatsPage />
    </MemoryRouter>,
  );
  await screen.findByText("数据统计");
}

describe("数据统计", () => {
  beforeEach(() => {
    reportFn.mockClear();
    financeReportFn.mockClear();
    exportSummary.mockClear();
    saveDialog.mockClear();
  });

  it("展示时间范围、时区与合计", async () => {
    await setup();
    expect(screen.getByText(/2026-11 ~ 2026-11/)).toBeInTheDocument();
    expect(screen.getByText(/Asia\/Shanghai/)).toBeInTheDocument();
    // 合计卡片与月度明细各出现一次
    expect(screen.getAllByText("¥ 1234.56")).toHaveLength(2);
    expect(screen.getByText("未知金额订单")).toBeInTheDocument();
  });

  it("有未知金额时明确说明不算作 0", async () => {
    await setup();
    expect(screen.getByText(/没有填写金额/)).toBeInTheDocument();
    expect(screen.getByText(/没有被当成 0 元/)).toBeInTheDocument();
  });

  it("切换统计范围会重新查询", async () => {
    const user = userEvent.setup();
    await setup();
    await user.click(screen.getByRole("button", { name: "近 6 个月" }));
    await waitFor(() => expect(reportFn).toHaveBeenCalledWith("last6"));
  });

  it("取消保存对话框时不导出、也不提示成功", async () => {
    const user = userEvent.setup();
    saveDialog.mockResolvedValueOnce(null);
    await setup();

    await user.click(screen.getByRole("button", { name: "导出汇总 CSV" }));

    await waitFor(() => expect(saveDialog).toHaveBeenCalled());
    expect(exportSummary).not.toHaveBeenCalled();
    expect(screen.queryByText(/已导出/)).not.toBeInTheDocument();
  });

  it("选择路径后调用导出并显示结果", async () => {
    const user = userEvent.setup();
    saveDialog.mockResolvedValueOnce("/tmp/s.csv");
    await setup();

    await user.click(screen.getByRole("button", { name: "导出汇总 CSV" }));

    await waitFor(() => expect(exportSummary).toHaveBeenCalledTimes(1));
    expect(exportSummary).toHaveBeenCalledWith({ path: "/tmp/s.csv", range: "thisMonth" });
    expect(await screen.findByText(/已导出 2 行/)).toBeInTheDocument();
  });

  it("导出失败时显示错误且不提示成功", async () => {
    const user = userEvent.setup();
    saveDialog.mockResolvedValueOnce("/tmp/s.csv");
    exportSummary.mockRejectedValueOnce({ code: "IO", message: "磁盘已满" });
    await setup();

    await user.click(screen.getByRole("button", { name: "导出汇总 CSV" }));

    await waitFor(() => expect(screen.getByText(/磁盘已满/)).toBeInTheDocument());
    expect(screen.queryByText(/已导出/)).not.toBeInTheDocument();
  });

  it("带 focus=completed 时列出本月完成事件并可跳转订单", async () => {
    completedFn.mockResolvedValueOnce([
      {
        eventId: 7,
        orderId: "order-9",
        code: "AF-2026-0009",
        title: "完成的单",
        occurredAt: "2026-11-10T02:00:00.000Z",
        localTime: "2026-11-10 10:00",
        stageTitle: "最终调整",
      },
    ]);
    await setup("/stats?range=thisMonth&focus=completed");

    expect(await screen.findByText("本月完成事件")).toBeInTheDocument();
    expect(screen.getByText("AF-2026-0009")).toBeInTheDocument();
    expect(screen.getByText(/最终调整/)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "查看订单" });
    expect(link.getAttribute("href")).toBe("/orders?orderId=order-9");
  });

  it("没有事件时显示空状态而不是空图表", async () => {
    reportFn.mockResolvedValueOnce(
      report({
        months: [
          {
            month: "2026-11",
            created: 0,
            completed: 0,
            cancelled: 0,
            amountCents: 0,
            knownOrders: 0,
            unknownOrders: 0,
          },
        ],
        totals: {
          month: "2026-11~2026-11",
          created: 0,
          completed: 0,
          cancelled: 0,
          amountCents: 0,
          knownOrders: 0,
          unknownOrders: 0,
        },
      }),
    );
    await setup();
    expect(screen.getByText("这个区间内还没有任何事件")).toBeInTheDocument();
  });

  it("默认进入业务统计，不加载财务统计", async () => {
    await setup();
    const business = screen.getByRole("tab", { name: "业务统计" });
    expect(business.getAttribute("aria-selected")).toBe("true");
    expect(financeReportFn).not.toHaveBeenCalled();
  });

  it("切到财务统计时内容回到顶部，页头不吸顶", async () => {
    const user = userEvent.setup();
    const { default: StatsPage } = await import("./StatsPage");
    const { container } = render(
      <MemoryRouter initialEntries={["/stats"]}>
        <div className="main">
          <StatsPage />
        </div>
      </MemoryRouter>,
    );
    await screen.findByText("数据统计");
    const box = container.querySelector(".main") as HTMLElement;
    const head = container.querySelector(".stats-head") as HTMLElement;
    expect(head.className).toBe("stats-head");

    // 滚动不应改变页头：它是普通页头，不跟着滚动收紧
    box.scrollTop = 400;
    box.dispatchEvent(new Event("scroll"));
    expect(head.className).toBe("stats-head");

    await user.click(screen.getByRole("tab", { name: "财务统计" }));
    expect(box.scrollTop).toBe(0);
  });

  it("切到财务统计后单独加载财务数据，业务统计的接口不再重复请求", async () => {
    const user = userEvent.setup();
    await setup();
    const callsBefore = reportFn.mock.calls.length;
    await user.click(screen.getByRole("tab", { name: "财务统计" }));

    await waitFor(() => expect(financeReportFn).toHaveBeenCalledTimes(1));
    expect(screen.getByText("累计（全部历史）")).toBeInTheDocument();
    expect(reportFn.mock.calls.length).toBe(callsBefore);
  });
});
