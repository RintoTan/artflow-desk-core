import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { MonthBucket, StatsReport } from "../bridge/commands";

function bucket(month: string, created: number, completed: number, cancelled: number): MonthBucket {
  return { month, created, completed, cancelled, amountCents: 0, knownOrders: 0, unknownOrders: 0 };
}

function reportOf(months: MonthBucket[]): StatsReport {
  return {
    range: "last12",
    timezone: "Asia/Shanghai",
    fromMonth: months[0]!.month,
    toMonth: months[months.length - 1]!.month,
    months,
    totals: {
      month: "x",
      created: months.reduce((n, m) => n + m.created, 0),
      completed: months.reduce((n, m) => n + m.completed, 0),
      cancelled: months.reduce((n, m) => n + m.cancelled, 0),
      amountCents: 0,
      knownOrders: 0,
      unknownOrders: 0,
    },
    basis: [],
  };
}

let REPORT = reportOf([bucket("2026-11", 10, 2, 1)]);

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    statsApi: {
      report: async () => REPORT,
      completedEvents: async () => [],
      dashboard: vi.fn(),
      exportSummary: vi.fn(),
      exportOrders: vi.fn(),
    },
  };
});

async function setup(report: StatsReport) {
  REPORT = report;
  const { default: StatsPage } = await import("./StatsPage");
  render(
    <MemoryRouter>
      <StatsPage />
    </MemoryRouter>,
  );
  // 全零时没有图表，所以只等页面本身渲染完
  await waitFor(() => expect(document.body.textContent).toContain("月度趋势"));
}

function chart() {
  return document.querySelector(".chart")!;
}

describe("月度趋势图", () => {
  it("Y 轴在滚动容器之外，且刻度是 0/中值/上界", async () => {
    await setup(reportOf([bucket("2026-10", 4, 1, 0), bucket("2026-11", 10, 2, 1)]));
    const axis = document.querySelector(".chart-axis")!;
    expect(document.querySelector(".chart-scroll")!.contains(axis)).toBe(false);
    expect(
      Array.from(axis.querySelectorAll(".chart-tick")).map((n) => n.textContent),
    ).toEqual(["0", "5", "10"]);
  });

  it("6 个月以内每个非零值都带标签", async () => {
    await setup(
      reportOf([
        bucket("2026-09", 3, 0, 0),
        bucket("2026-10", 0, 0, 0),
        bucket("2026-11", 5, 2, 1),
      ]),
    );
    const labels = Array.from(chart().querySelectorAll(".bar-value")).map((n) => n.textContent);
    // 3 / 5 / 2 / 1，零值不标
    expect(labels).toEqual(["3", "5", "2", "1"]);
  });

  it("超过 6 个月时只标每月最大值", async () => {
    const months = Array.from({ length: 12 }, (_, i) =>
      // created 从 2 起：避免与 completed=1 并列时两列都算"最大"
      bucket(`2026-${String(i + 1).padStart(2, "0")}`, i + 2, 1, 0),
    );
    await setup(reportOf(months));
    const cols = chart().querySelectorAll(".chart-col");
    expect(cols).toHaveLength(12);
    cols.forEach((col) => {
      expect(col.querySelectorAll(".bar-value")).toHaveLength(1);
    });
    // 每列标的都是新建值（该列最大）
    expect(
      Array.from(chart().querySelectorAll(".bar-value")).map((n) => n.textContent),
    ).toEqual(months.map((m) => String(m.created)));
  });

  it("零值不画成有高度的柱子，也不标数字", async () => {
    await setup(reportOf([bucket("2026-10", 3, 0, 0), bucket("2026-11", 1, 0, 0)]));
    const zeros = chart().querySelectorAll(".bar-zero");
    expect(zeros.length).toBe(4); // 2 个月 × (完成 0 + 取消 0)
    zeros.forEach((node) => {
      expect((node as HTMLElement).style.height).toBe("");
      expect(node.closest(".bar-slot")!.querySelector(".bar-value")).toBeNull();
    });
  });

  it("全零时显示空状态，不摆一个空图表", async () => {
    await setup(reportOf([bucket("2026-10", 0, 0, 0), bucket("2026-11", 0, 0, 0)]));
    expect(document.querySelector(".chart-frame")).toBeNull();
    expect(screen.getByText("这个区间内还没有任何事件。")).toBeInTheDocument();
  });

  it("每列可聚焦，可访问名带三个数字", async () => {
    await setup(reportOf([bucket("2026-10", 4, 1, 0), bucket("2026-11", 10, 2, 1)]));
    const cols = chart().querySelectorAll(".chart-col");
    cols.forEach((col) => {
      expect(col.getAttribute("tabindex")).toBe("0");
      expect(col.getAttribute("aria-label")).toMatch(/^2026-1\d：新建 \d+、完成 \d+、取消 \d+$/);
    });
  });

  it("聚焦出现数值气泡，Esc 收起", async () => {
    const user = userEvent.setup();
    await setup(reportOf([bucket("2026-10", 4, 1, 0), bucket("2026-11", 10, 2, 1)]));

    await user.tab();
    await user.tab();
    const cols = chart().querySelectorAll<HTMLElement>(".chart-col");
    cols[1]!.focus();

    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent("2026-11");
    expect(tip).toHaveTextContent("新建");
    expect(tip.parentElement).toBe(document.body);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("柱色走主题令牌，不再写死颜色", async () => {
    await setup(reportOf([bucket("2026-11", 1, 1, 1)]));
    const classes = Array.from(chart().querySelectorAll(".bar")).map((n) => n.className);
    expect(classes).toEqual(["bar bar-created", "bar bar-completed", "bar bar-cancelled"]);
    // 具体色值由 styles.chart.test.ts 核算对比度
  });
});
