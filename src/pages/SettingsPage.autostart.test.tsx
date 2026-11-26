import { render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AutostartStatus } from "../bridge/commands";

const bridge = vi.hoisted(() => ({
  status: { enabled: false, supported: true, detail: "未注册登录启动项" } as AutostartStatus,
  setCalls: [] as boolean[],
  // 后端「没写成」的情形：返回 enabled=false 并说明原因。
  setOverride: null as null | ((enabled: boolean) => AutostartStatus),
}));

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>("../bridge/commands");
  return {
    ...actual,
    api: {
      storageStatus: async () => ({
        root: "/data/root",
        defaultRoot: "/data/root",
        pointerPath: "/data/root.json",
        custom: false,
      }),
      autostartGet: async () => bridge.status,
      autostartSet: async (enabled: boolean) => {
        bridge.setCalls.push(enabled);
        if (bridge.setOverride) return bridge.setOverride(enabled);
        bridge.status = { enabled, supported: true, detail: enabled ? "/Users/x/Library/LaunchAgents/dev.artflow.minidesk.plist" : "未注册登录启动项" };
        return bridge.status;
      },
      timezoneGet: async () => ({
        workingTimezone: "Asia/Shanghai",
        systemTimezone: "Asia/Shanghai",
        sameAsSystem: true,
      }),
      timezoneSet: async (name: string) => ({
        workingTimezone: name,
        systemTimezone: "Asia/Shanghai",
        sameAsSystem: name === "Asia/Shanghai",
      }),
    },
    themeApi: {
      get: async () => ({ mode: "arctic", accent: null, storedMode: null }),
      set: async (mode: string, accent: string | null) => ({ mode, accent, storedMode: mode }),
    },
  };
});

vi.mock("../components/BackupPanel", () => ({ default: () => null }));
vi.mock("../components/AttachmentMaintenancePanel", () => ({ default: () => null }));

beforeEach(() => {
  bridge.setCalls = [];
  bridge.setOverride = null;
  bridge.status = { enabled: false, supported: true, detail: "未注册登录启动项" };
});

async function open() {
  const { default: SettingsPage } = await import("./SettingsPage");
  const { container } = render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
  const toggle = await within(container).findByRole("switch", { name: "登录时自动启动" });
  return { toggle, container };
}

describe("登录时自动启动", () => {
  it("默认关闭，开启后按系统返回的状态显示", async () => {
    const user = userEvent.setup();
    const { toggle } = await open();
    // 开关在读到系统状态之前是禁用的：等它可用再点。
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveTextContent("已关闭");

    await user.click(toggle);

    expect(bridge.setCalls).toEqual([true]);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(toggle).toHaveTextContent("已开启");
  });

  it("后端没写成时不显示成已开启，并把原因说出来", async () => {
    const user = userEvent.setup();
    const { toggle, container } = await open();
    await waitFor(() => expect(toggle).toBeEnabled());
    bridge.setOverride = () => ({
      enabled: false,
      supported: true,
      detail: "写入登录启动项失败：permission denied",
    });

    await user.click(toggle);

    // 结论在错误条里，具体原因在状态说明里，两处不重复同一句话。
    const alert = await within(container).findByText(/自动启动没有生效/);
    expect(alert).toHaveAttribute("role", "alert");
    expect(within(container).getByText(/permission denied/)).toHaveClass("hint");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveTextContent("已关闭");
  });

  it("当前平台不支持时按钮禁用并说明", async () => {
    bridge.status = { enabled: false, supported: false, detail: "当前系统不支持自动启动" };
    const { toggle, container } = await open();
    expect(toggle).toBeDisabled();
    expect(within(container).getByText(/当前系统不支持自动启动/)).toBeInTheDocument();
  });
});
