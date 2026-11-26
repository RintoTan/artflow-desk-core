import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EnvironmentStatus } from "../bridge/commands";

const state = vi.hoisted(() => ({
  status: undefined as EnvironmentStatus | undefined,
  statusFn: vi.fn(),
}));

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>("../bridge/commands");
  return {
    ...actual,
    api: {
      ...actual.api,
      status: () => state.statusFn(),
    },
  };
});

const { default: VersionDialog } = await import("./VersionDialog");

function env(overrides: Partial<EnvironmentStatus> = {}): EnvironmentStatus {
  return {
    appVersion: "0.1.2",
    firstRun: false,
    generation: "gen-1",
    schemaVersion: 14,
    upgradedFrom: 13,
    rootPath: "/tmp/root",
    sqliteVersion: "3.54.1",
    journalMode: "wal",
    workingTimezone: "Asia/Shanghai",
    systemTimezone: "Asia/Shanghai",
    lockHeld: true,
    orders: 1,
    clients: 1,
    templates: 1,
    attachments: 0,
    pendingCleanup: 0,
    highWater: [],
    integrity: "ok",
    qaMode: false,
    ...overrides,
  } as EnvironmentStatus;
}

function row(label: string): string {
  const dt = screen.getByText(label);
  const dd = dt.parentElement?.querySelector("dd");
  return dd?.textContent ?? "";
}

beforeEach(() => {
  state.statusFn = vi.fn(async () => env());
  state.status = undefined;
  vi.stubGlobal("__BUILD_ID__", "f18de06");
  delete (globalThis as { __RELEASE_LABEL__?: string }).__RELEASE_LABEL__;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("版本信息弹窗", () => {
  it("显示名称、版本、渠道、SHA、Schema、平台、开发者与归属", async () => {
    render(<VersionDialog open onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "ArtFlow Desk Core" })).toBeInTheDocument());

    expect(row("应用版本")).toBe("0.1.2");
    expect(row("发布渠道")).toBe("Production");
    expect(row("Git SHA")).toBe("f18de06");
    // 显示的是实际打开的库版本，不是程序支持的目标版本
    expect(row("数据库结构")).toBe("v14");
    expect(row("运行平台")).toMatch(/macOS|Windows|Linux|未知/);
    expect(row("开发者")).toBe("RINTO");
    expect(row("项目归属")).toBe("ArtFlow Desk Core");
  });

  it("Schema 用后端读到的实际版本，而不是固定常量", async () => {
    state.statusFn = vi.fn(async () => env({ schemaVersion: 13, upgradedFrom: null }));
    render(<VersionDialog open onClose={() => {}} />);
    await waitFor(() => expect(row("数据库结构")).toBe("v13"));
  });

  it("QA 环境与发布标记分开显示，不互相顶替", async () => {
    vi.stubGlobal("__RELEASE_LABEL__", "v0.1.2-demo.1");
    state.statusFn = vi.fn(async () => env({ qaMode: true }));
    render(<VersionDialog open onClose={() => {}} />);

    await waitFor(() => expect(row("发布渠道")).toBe("QA 测试环境"));
    expect(row("发布标记")).toBe("v0.1.2-demo.1");
    // 发布标记不改变应用版本
    expect(row("应用版本")).toBe("0.1.2");
  });

  it("关闭按钮与 Esc 都能关掉", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(<VersionDialog open onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "关闭版本信息" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    rerender(<VersionDialog open onClose={onClose} />);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("读不到运行状态时给错误提示，不显示假数据", async () => {
    state.statusFn = vi.fn(async () => {
      throw new Error("环境未就绪");
    });
    render(<VersionDialog open onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/环境未就绪|读取/);
    expect(row("应用版本")).toBe("读取中…");
  });

  it("模块介绍与关于页共用同一份文案", async () => {
    render(<VersionDialog open onClose={() => {}} />);
    const modules = screen.getByRole("region", { name: "功能模块" });
    expect(within(modules).getByText("订单信息")).toBeInTheDocument();
    expect(within(modules).getByText("客户管理")).toBeInTheDocument();
  });

  it("未打开时不渲染任何内容", () => {
    render(<VersionDialog open={false} onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
