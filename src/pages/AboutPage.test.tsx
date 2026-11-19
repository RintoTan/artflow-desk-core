import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EnvironmentStatus } from "../bridge/commands";

let status: EnvironmentStatus;
let statusError: Error | null = null;

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    api: {
      ...actual.api,
      status: async () => {
        if (statusError) throw statusError;
        return status;
      },
    },
  };
});

const { default: AboutPage } = await import("./AboutPage");

function baseStatus(patch: Partial<EnvironmentStatus> = {}): EnvironmentStatus {
  return {
    appVersion: "0.1.0",
    firstRun: false,
    generation: "gen-abc123def456",
    schemaVersion: 7,
    upgradedFrom: null,
    rootPath: "/Users/test/Library/Application Support/dev.artflow.minidesk.qa/seeded",
    qaMode: true,
    qaScenario: "seeded",
    sqliteVersion: "3.50.4",
    journalMode: "wal",
    workingTimezone: "Asia/Shanghai",
    systemTimezone: "Asia/Shanghai",
    lockHeld: true,
    orders: 14,
    clients: 3,
    templates: 3,
    attachments: 7,
    pendingCleanup: 0,
    highWater: [{ year: 2026, lastAllocated: 14 }],
    integrity: "ok",
    ...patch,
  };
}

beforeEach(() => {
  statusError = null;
  status = baseStatus();
});

describe("关于软件页面", () => {
  it("展示软件定位，并明确桌面端与 Web 端是独立产品", async () => {
    render(<AboutPage />);
    expect(await screen.findByRole("heading", { name: "关于软件" })).toBeTruthy();
    expect(screen.getByText(/面向独立画师的本地优先桌面委托管理工具/)).toBeTruthy();
    expect(screen.getByText(/不依赖云同步/)).toBeTruthy();
    expect(screen.getByText(/工程、数据与发布彼此独立，不共享数据库/)).toBeTruthy();
  });

  it("版本号来自后端状态，不在页面里写死", async () => {
    status = baseStatus({ appVersion: "9.9.9" });
    render(<AboutPage />);
    expect(await screen.findByText("v9.9.9")).toBeTruthy();
    expect(screen.queryByText("v0.1.0")).toBeNull();
  });

  it("开发与归属：已知信息展示，未知信息标「待补充」", async () => {
    render(<AboutPage />);
    const owners = await screen.findByRole("region", { name: "开发与归属" });
    expect(within(owners).getAllByText("RINTO").length).toBe(3); // 开发者 / 维护者 / 版权
    expect(within(owners).getByText("ArtFlow Desk")).toBeTruthy();
    expect(within(owners).getByText("许可证")).toBeTruthy();
    expect(within(owners).getAllByText("待补充").length).toBe(2); // 许可证 + 官网/联系方式
  });

  it("七个功能模块都有介绍，且不出现开发术语", async () => {
    render(<AboutPage />);
    const modules = await screen.findByRole("region", { name: "功能模块" });
    for (const title of [
      "工作台",
      "订单管理",
      "客户管理",
      "流程模板",
      "日历排期",
      "历史统计",
      "系统设置",
    ]) {
      expect(within(modules).getByRole("heading", { name: title })).toBeTruthy();
    }
    const text = modules.textContent ?? "";
    for (const jargon of ["Rust", "SQLite", "IPC", "Schema", "Migration"]) {
      expect(text).not.toContain(jargon);
    }
  });

  it("使用指引覆盖七个主题，且默认只展开第一个", async () => {
    render(<AboutPage />);
    const guides = await screen.findByRole("region", { name: "使用指引" });
    const details = guides.querySelectorAll("details");
    expect(details.length).toBe(7);
    expect(details[0]?.open).toBe(true);
    expect(details[1]?.open).toBe(false);
  });

  it("指引可展开与收起", async () => {
    const user = userEvent.setup();
    render(<AboutPage />);
    const guides = await screen.findByRole("region", { name: "使用指引" });
    const summary = within(guides).getByText("数据备份与恢复");
    await user.click(summary);
    const detail = summary.closest("details");
    expect(detail?.open).toBe(true);
    await user.click(summary);
    expect(summary.closest("details")?.open).toBe(false);
  });

  it("数据环境保留原页面的真实状态字段", async () => {
    render(<AboutPage />);
    await waitFor(() => expect(screen.getAllByText("gen-abc123def456").length).toBeGreaterThan(0));
    const env = screen.getByRole("region", { name: "数据环境" });
    for (const label of [
      "运行模式",
      "应用版本",
      "数据库结构",
      "数据代际",
      "SQLite",
      "日志模式",
      "写入锁",
      "工作时区",
      "系统时区",
    ]) {
      expect(within(env).getByText(label)).toBeTruthy();
    }
    expect(screen.getByText("/Users/test/Library/Application Support/dev.artflow.minidesk.qa/seeded")).toBeTruthy();
    expect(within(env).getByText("订单")).toBeTruthy();
    expect(within(env).getAllByText("14").length).toBeGreaterThan(0); // 订单数 + 高水位
    expect(within(env).getByText("AF-2026-0015")).toBeTruthy();
    expect(screen.getByText(/完整性 正常/)).toBeTruthy();
  });

  it("QA 环境有两处醒目标识，正式环境没有", async () => {
    render(<AboutPage />);
    expect(await screen.findByTestId("qa-badge")).toBeTruthy();
    expect(screen.getByText(/QA 测试环境：数据目录与正式台账完全隔离/)).toBeTruthy();
    expect(screen.getByText(/QA 测试环境 · 预置场景（与正式数据隔离）/)).toBeTruthy();
  });

  it("正式环境下不显示 QA 标识", async () => {
    status = baseStatus({
      qaMode: false,
      qaScenario: null,
      rootPath: "/Users/test/Library/Application Support/dev.artflow.minidesk",
    });
    render(<AboutPage />);
    await waitFor(() => expect(screen.getByText("正式应用")).toBeTruthy());
    expect(screen.queryByTestId("qa-badge")).toBeNull();
    expect(screen.queryByText(/QA 测试环境：数据目录与正式台账完全隔离/)).toBeNull();
    expect(screen.getByText(/正式构建/)).toBeTruthy();
  });

  it("状态查询失败时明确报错，不猜测环境", async () => {
    statusError = new Error("数据目录不可读");
    render(<AboutPage />);
    await waitFor(() => expect(screen.getByText("无法读取数据环境")).toBeTruthy());
    expect(await screen.findByText(/数据目录不可读/)).toBeTruthy();
    expect(screen.queryByTestId("qa-badge")).toBeNull();
    expect(screen.queryByText("正式应用")).toBeNull();
    // 版本区不能假装读到了
    expect(screen.getAllByText("读取中…").length).toBeGreaterThan(0);
  });

  it("首次启动会说明已初始化正式数据库", async () => {
    status = baseStatus({ firstRun: true, qaMode: false, qaScenario: null });
    render(<AboutPage />);
    expect(await screen.findByText(/本次是首次启动，已初始化正式数据库/)).toBeTruthy();
  });

  it("没有编号时不渲染空表", async () => {
    status = baseStatus({ highWater: [] });
    render(<AboutPage />);
    expect(await screen.findByText("尚无已分配的订单编号。")).toBeTruthy();
    expect(screen.queryByText("下一编号")).toBeNull();
  });
});
