import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ThemeInfo } from "../bridge/commands";
import { activeGuard, resetUnsavedGuards } from "../lib/unsavedRegistry";
import { currentChoice, loadTheme, resetThemeForTests } from "../lib/theme";

let themeInfo: ThemeInfo = { mode: "arctic", accent: null, storedMode: null };
const themeSet = vi.fn(async (mode: string, accent: string | null) => {
  themeInfo = { mode, accent, storedMode: mode };
  return themeInfo;
});

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    api: {
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
      get: async () => themeInfo,
      set: (mode: string, accent: string | null) => themeSet(mode, accent),
    },
  };
});

async function renderSettings() {
  const { default: SettingsPage } = await import("./SettingsPage");
  render(<SettingsPage />);
  await screen.findByText("外观");
  // "Arctic Blue（默认浅色）" 同时出现在按钮和状态行里，按角色确认按钮存在即可
  await screen.findByRole("button", { name: "Arctic Blue（默认浅色）" });
}

describe("设置页主题编辑", () => {
  beforeEach(() => {
    resetThemeForTests();
    resetUnsavedGuards();
    themeInfo = { mode: "arctic", accent: null, storedMode: null };
    themeSet.mockClear();
    document.documentElement.removeAttribute("data-theme");
  });

  afterEach(() => {
    resetThemeForTests();
    resetUnsavedGuards();
  });

  it("切换模式只是预览，不写库", async () => {
    await renderSettings();
    await userEvent.click(screen.getByRole("button", { name: "深色" }));

    // 主题真正生效由 App 负责（见 App.theme.test.tsx），这里只看预览状态与草稿
    await waitFor(() => expect(currentChoice().mode).toBe("dark"));
    expect(themeSet).not.toHaveBeenCalled();
    // 有草稿，关窗/离页保护应当接管
    expect(activeGuard()?.label).toContain("主题");
  });

  it("保存后写库并清掉草稿", async () => {
    await renderSettings();
    await userEvent.click(screen.getByRole("button", { name: "深色" }));
    await userEvent.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() => expect(themeSet).toHaveBeenCalledWith("dark", null));
    await waitFor(() => expect(activeGuard()).toBeNull());
  });

  it("放弃修改回到已保存主题", async () => {
    await renderSettings();
    await userEvent.click(screen.getByRole("button", { name: "深色" }));
    await userEvent.click(screen.getByRole("button", { name: "放弃修改" }));

    await waitFor(() => expect(currentChoice().mode).toBe("arctic"));
    expect(themeSet).not.toHaveBeenCalled();
    expect(activeGuard()).toBeNull();
  });

  it("恢复默认主题：预览回 Arctic Blue 且仍需要保存", async () => {
    themeInfo = { mode: "dark", accent: "#7b5cff", storedMode: "dark" };
    resetThemeForTests();
    await loadTheme(); // 模拟 App 启动时把已保存主题读进来
    const { default: SettingsPage } = await import("./SettingsPage");
    render(<SettingsPage />);
    await screen.findByText("外观");

    await userEvent.click(screen.getByRole("button", { name: "恢复默认主题" }));

    await waitFor(() => expect(currentChoice().mode).toBe("arctic"));
    expect(currentChoice().accent).toBeNull();
    expect(activeGuard()).not.toBeNull();
  });

  it("非法强调色给出明确提示，不影响已保存主题", async () => {
    await renderSettings();
    const input = screen.getByLabelText("强调色十六进制");
    await userEvent.clear(input);
    await userEvent.type(input, "不是颜色");

    expect(await screen.findByRole("alert")).toHaveTextContent("#rrggbb");
    expect(themeSet).not.toHaveBeenCalled();
  });

  it("浅色强调色会给出对比度警告", async () => {
    await renderSettings();
    const input = screen.getByLabelText("强调色十六进制");
    fireEvent.change(input, { target: { value: "#ffe9a8" } });

    const notice = await screen.findByText(/对比度/);
    expect(notice).toHaveClass("notice-warn");
  });
});
