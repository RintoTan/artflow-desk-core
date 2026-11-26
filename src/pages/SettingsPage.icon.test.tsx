import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IconInfo, ThemeInfo } from "../bridge/commands";
import { resetIconForTests } from "../lib/appIcon";
import { activeGuard, guardLabel, resetUnsavedGuards } from "../lib/unsavedRegistry";
import { resetThemeForTests } from "../lib/theme";

let iconInfo: IconInfo = { variant: "orbit", storedVariant: null, defaultVariant: "orbit" };
const iconSet = vi.fn(async (variant: string) => {
  iconInfo = { variant, storedVariant: variant, defaultVariant: "orbit" };
  return iconInfo;
});
const iconGet = vi.fn(async () => iconInfo);

const themeInfo: ThemeInfo = { mode: "arctic", accent: null, storedMode: null };
const themeSet = vi.fn(async (_mode?: string, _accent?: string | null) => themeInfo);

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
      autostartGet: async () => ({
        enabled: false,
        supported: true,
        detail: "未注册登录启动项",
      }),
      timezoneGet: async () => ({
        workingTimezone: "Asia/Shanghai",
        systemTimezone: "Asia/Shanghai",
        sameAsSystem: true,
      }),
      timezoneSet: async (tz: string) => ({
        workingTimezone: tz,
        systemTimezone: "Asia/Shanghai",
        sameAsSystem: tz === "Asia/Shanghai",
      }),
    },
    themeApi: {
      get: async () => themeInfo,
      set: (mode: string, accent: string | null) => themeSet(mode, accent),
    },
    iconApi: { get: () => iconGet(), set: (variant: string) => iconSet(variant) },
  };
});

/** jsdom 没有 matchMedia；系统外观固定为浅色，测试只关心主题草稿的联动 */
function installMatchMedia() {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

async function renderSettings() {
  const mod = await import("../lib/appIcon");
  await mod.loadIcon();
  const { default: SettingsPage } = await import("./SettingsPage");
  const { MemoryRouter } = await import("react-router-dom");
  render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
  await screen.findByRole("group", { name: "应用图标" });
}

function card(name: string) {
  return screen.getByRole("button", { name: new RegExp(`应用图标 ${name}`) });
}

beforeEach(() => {
  installMatchMedia();
  iconInfo = { variant: "orbit", storedVariant: null, defaultVariant: "orbit" };
  iconSet.mockClear();
  iconGet.mockClear();
  themeSet.mockClear();
  resetUnsavedGuards();
  resetThemeForTests();
  resetIconForTests();
});

afterEach(() => {
  resetUnsavedGuards();
});

describe("设置页的应用图标", () => {
  it("三张卡片都渲染，默认选中 Orbit", async () => {
    await renderSettings();
    expect(card("Orbit")).toHaveAttribute("aria-pressed", "true");
    expect(card("Layers")).toHaveAttribute("aria-pressed", "false");
    expect(card("Wave A")).toHaveAttribute("aria-pressed", "false");
    // 预览用的是真实 SVG，而不是色块占位
    const art = card("Orbit").querySelector("img");
    expect(art).not.toBeNull();
    expect(art?.getAttribute("src") ?? "").toContain("svg");
  });

  it("点卡片只是预览，不写库，并且进入未保存状态", async () => {
    await renderSettings();
    await userEvent.click(card("Layers"));

    expect(card("Layers")).toHaveAttribute("aria-pressed", "true");
    expect(card("Orbit")).toHaveAttribute("aria-pressed", "false");
    expect(iconSet).not.toHaveBeenCalled();
    expect(guardLabel(activeGuard()!)).toContain("应用图标");
    // 按钮从"没有草稿"变成可保存
    expect(screen.getByRole("button", { name: "保存设置" })).toBeEnabled();
  });

  it("保存后写库，卡片状态变成已保存", async () => {
    await renderSettings();
    await userEvent.click(card("Wave A"));
    await userEvent.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() => expect(iconSet).toHaveBeenCalledWith("wave-a"));
    expect(await screen.findByText("设置已保存。")).toBeInTheDocument();
    expect(activeGuard()).toBeNull();
  });

  it("放弃修改回到已保存的图标", async () => {
    await renderSettings();
    await userEvent.click(card("Layers"));
    await userEvent.click(screen.getByRole("button", { name: "放弃修改" }));

    expect(card("Orbit")).toHaveAttribute("aria-pressed", "true");
    expect(iconSet).not.toHaveBeenCalled();
  });

  it("恢复默认图标选中 Orbit，且仍需要保存", async () => {
    iconInfo = { variant: "layers", storedVariant: "layers", defaultVariant: "orbit" };
    await renderSettings();
    await userEvent.click(card("Wave A"));
    await userEvent.click(screen.getByRole("button", { name: "恢复默认图标" }));

    expect(card("Orbit")).toHaveAttribute("aria-pressed", "true");
    expect(iconSet).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "保存设置" })).toBeEnabled();
  });

  it("保存失败时保留草稿并提示，不假装成功", async () => {
    iconSet.mockRejectedValueOnce({ code: "DB", message: "数据库只读" });
    await renderSettings();
    await userEvent.click(card("Layers"));
    await userEvent.click(screen.getByRole("button", { name: "保存设置" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("数据库只读");
    expect(card("Layers")).toHaveAttribute("aria-pressed", "true");
    expect(activeGuard()).not.toBeNull();
  });

  it("主题与图标可以各自成草稿，标签会一起列出来", async () => {
    await renderSettings();
    await userEvent.click(screen.getByRole("button", { name: "深色" }));
    await userEvent.click(card("Layers"));
    const label = guardLabel(activeGuard()!);
    expect(label).toContain("主题");
    expect(label).toContain("应用图标");
  });

  it("卡片主图跟着主题明暗走：默认浅色，点深色立刻换深色版", async () => {
    await renderSettings();
    const art = () => card("Orbit").querySelector<HTMLImageElement>(".icon-card-art");
    expect(art()?.dataset.iconAppearance).toBe("light");

    await userEvent.click(screen.getByRole("button", { name: "深色" }));
    expect(art()?.dataset.iconAppearance).toBe("dark");

    // 放弃主题草稿后回到浅色
    await userEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    expect(art()?.dataset.iconAppearance).toBe("light");
  });

  it("每张卡都给出浅色/深色两个静态预览", async () => {
    await renderSettings();
    for (const name of ["Orbit", "Layers", "Wave A"]) {
      const minis = Array.from(card(name).querySelectorAll(".icon-card-mini"));
      expect(minis).toHaveLength(2);
      expect(minis.map((el) => (el as HTMLImageElement).dataset.iconAppearance)).toEqual([
        "light",
        "dark",
      ]);
    }
    // 只是展示：主题模式仍然只有那一组三个按钮，没有多出第二套开关
    expect(
      screen.getAllByRole("button", { name: /^(Arctic Blue（默认浅色）|深色|跟随系统)$/ }),
    ).toHaveLength(3);
  });

  it("明确标示 Dock 图标不会随设置变化", async () => {
    await renderSettings();
    expect(screen.getByText(/macOS Dock 图标与安装包图标不随此设置变化/)).toBeInTheDocument();
  });
});
