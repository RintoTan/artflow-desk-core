import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ThemeInfo } from "../bridge/commands";
import { activeGuard, guardLabel, resetUnsavedGuards } from "../lib/unsavedRegistry";
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
      storageStatus: async () => ({
        root: "/data/root",
        defaultRoot: "/data/root",
        pointerPath: "/data/root.json",
        custom: false,
      }),
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
  // 设置页里有指向回收站的 Link，需要路由上下文。
  render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
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
    // label 现在是函数：一个页面里可能同时有主题/图标/时区三份草稿
    const guard = activeGuard();
    expect(guard).not.toBeNull();
    expect(guardLabel(guard!)).toContain("主题");
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
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    await screen.findByText("外观");

    await userEvent.click(screen.getByRole("button", { name: "恢复默认主题" }));
    // 覆盖当前草稿属于有后果的操作，先在确认框里点「恢复默认」。
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "恢复默认" }));

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

  it("恢复默认主题可以取消，取消后草稿保持不变", async () => {
    themeInfo = { mode: "dark", accent: "#7b5cff", storedMode: "dark" };
    resetThemeForTests();
    await loadTheme();
    const { default: SettingsPage } = await import("./SettingsPage");
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    await screen.findByText("外观");

    await userEvent.click(screen.getByRole("button", { name: "恢复默认主题" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "保留当前设置" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(currentChoice().mode).toBe("dark");
    expect(currentChoice().accent).toBe("#7b5cff");
  });

  it("全页只有一处保存入口，模块按页头 + 双栏 + 保存栏组织", async () => {
    await renderSettings();
    expect(screen.getAllByRole("button", { name: "保存设置" })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "通用设置" })).toBeInTheDocument();
    expect(document.querySelector(".settings-grid")).not.toBeNull();
    expect(document.querySelectorAll(".settings-savebar")).toHaveLength(1);
  });

  it("时区可以按中文城市搜索并选中，非法值禁止保存", async () => {
    const user = userEvent.setup();
    await renderSettings();

    const input = screen.getByRole("combobox");
    await user.clear(input);
    await user.type(input, "东京");

    const list = await screen.findByRole("listbox", { name: "时区候选" });
    expect(list).toHaveTextContent("日本标准时间");
    await user.click(within(list).getByRole("option", { name: /日本标准时间/ }));

    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("Asia/Tokyo");

    await user.clear(screen.getByRole("combobox"));
    await user.type(screen.getByRole("combobox"), "Mars/Base");
    expect(screen.getByText(/不是有效的 IANA 时区/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存设置" })).toBeDisabled();
  });
});
