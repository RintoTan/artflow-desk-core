import { MemoryRouter } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { DashboardMetrics } from "../bridge/commands";

const METRICS: DashboardMetrics = {
  activeTotal: 5,
  queued: 2,
  inProgress: 3,
  dueSoon: 1,
  dueToday: 1,
  overdue: 2,
  unscheduled: 1,
  completedThisMonth: 4,
  cancelledThisMonth: 1,
  createdThisMonth: 3,
  timezone: "Asia/Shanghai",
  today: "2026-11-17",
  month: "2026-11",
};

const dashboard = vi.fn(async () => METRICS);

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    statsApi: { dashboard },
  };
});

async function setup() {
  const { default: DashboardPage } = await import("./DashboardPage");
  render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
  await screen.findByText("工作台");
}

function cardByLabel(label: string): HTMLElement {
  const node = screen.getByText(label).closest("a");
  if (!node) throw new Error(`找不到卡片：${label}`);
  return node as HTMLElement;
}

describe("工作台", () => {
  it("展示时区与今天的日期", async () => {
    await setup();
    expect(screen.getByText(/2026-11-17/)).toBeInTheDocument();
    expect(screen.getByText(/Asia\/Shanghai/)).toBeInTheDocument();
  });

  it("八个指标都显示真实数字", async () => {
    await setup();
    expect(cardByLabel("活动订单")).toHaveTextContent("5");
    expect(cardByLabel("排队中")).toHaveTextContent("2");
    expect(cardByLabel("制作中")).toHaveTextContent("3");
    expect(cardByLabel("三日内到期")).toHaveTextContent("1");
    expect(cardByLabel("今天到期")).toHaveTextContent("1");
    expect(cardByLabel("已逾期")).toHaveTextContent("2");
    expect(cardByLabel("未排期")).toHaveTextContent("1");
    expect(cardByLabel("本月完成次数")).toHaveTextContent("4");
  });

  it("卡片链接到对应筛选，本月完成次数进入完成事件明细", async () => {
    await setup();
    expect(cardByLabel("已逾期").getAttribute("href")).toBe("/orders?status=active&risk=overdue");
    expect(cardByLabel("排队中").getAttribute("href")).toBe("/orders?status=active&work=queued");
    expect(cardByLabel("未排期").getAttribute("href")).toBe(
      "/orders?status=active&risk=unscheduled",
    );
    expect(cardByLabel("本月完成次数").getAttribute("href")).toBe(
      "/stats?range=thisMonth&focus=completed",
    );
  });

  it("有临期订单时给出关注提示", async () => {
    await setup();
    expect(screen.getByText("4 项需要关注")).toBeInTheDocument();
  });

  it("明确说明提醒不会改变队列顺序", async () => {
    await setup();
    expect(screen.getByText(/不会自动调整活动队列顺序/)).toBeInTheDocument();
  });

  it("读取失败时显示错误而不是空白卡片", async () => {
    dashboard.mockRejectedValueOnce({ code: "DB", message: "数据库不可用" });
    const { default: DashboardPage } = await import("./DashboardPage");
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByText("无法读取工作台")).toBeInTheDocument(),
    );
    expect(screen.getByText(/数据库不可用/)).toBeInTheDocument();
  });
});
