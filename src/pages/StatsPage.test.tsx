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

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
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
    expect(screen.getByText("这个区间内还没有任何事件。")).toBeInTheDocument();
  });
});
