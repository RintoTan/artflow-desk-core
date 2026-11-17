import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

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

/** 安装一个假的 ResizeObserver：用指定宽度回调一次，模拟窄容器 */
function installWidth(width: number) {
  class FakeObserver {
    constructor(private cb: ResizeObserverCallback) {}
    observe() {
      this.cb([{ contentRect: { width } }] as unknown as ResizeObserverEntry[], {} as ResizeObserver);
    }
    disconnect() {}
    unobserve() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeObserver;
}

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

describe("窄容器下的两排模式", () => {
  const months = Array.from({ length: 12 }, (_, i) =>
    bucket(`2026-${String(i + 1).padStart(2, "0")}`, i + 2, 1, 0),
  );

  afterEach(() => {
    delete (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver;
  });

  it("窄容器切成两排，每排六个月，且不横向滚动", async () => {
    installWidth(430);
    await setup(reportOf(months));
    const frame = document.querySelector(".chart-frame")!;
    expect(frame.getAttribute("data-mode")).toBe("split");
    const rows = frame.querySelectorAll(".chart-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelectorAll(".chart-col")).toHaveLength(6);
    expect(rows[1]!.querySelectorAll(".chart-col")).toHaveLength(6);
    // 顺序从旧到新，不重不漏
    const labels = Array.from(frame.querySelectorAll(".chart-label")).map((n) => n.textContent);
    expect(labels).toEqual(months.map((m) => m.month.slice(2)));
  });

  it("两排共用同一刻度范围，柱高可直接比较", async () => {
    installWidth(430);
    await setup(reportOf(months));
    const axes = Array.from(document.querySelectorAll(".chart-axis")).map((axis) =>
      Array.from(axis.querySelectorAll(".chart-tick")).map((n) => n.textContent),
    );
    expect(axes).toHaveLength(2);
    expect(axes[0]).toEqual(axes[1]);
    // 两排共享刻度：跨排的柱高之比必须等于数值之比
    const created = Array.from(document.querySelectorAll<HTMLElement>(".bar-created")).map((bar) =>
      Number.parseFloat(bar.style.height || "0"),
    );
    // months[5].created = 7，months[11].created = 13
    expect(created[5]! / created[11]!).toBeCloseTo(7 / 13, 3);
    // 两排都不应出现"各自归一化"导致的 100%
    expect(Math.max(...created)).toBeCloseTo((13 / 20) * 100, 3);
  });

  it("宽容器仍是单排十二个月", async () => {
    installWidth(900);
    await setup(reportOf(months));
    const frame = document.querySelector(".chart-frame")!;
    expect(frame.getAttribute("data-mode")).toBe("single");
    expect(frame.querySelectorAll(".chart-row")).toHaveLength(1);
    expect(frame.querySelectorAll(".chart-col")).toHaveLength(12);
  });
});

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
