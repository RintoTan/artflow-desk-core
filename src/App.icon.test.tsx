import { act, render, screen, waitFor } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EnvironmentStatus, IconInfo, ThemeInfo } from "./bridge/commands";
import { resetIconForTests, setIconPreview } from "./lib/appIcon";
import { persistTheme, resetThemeForTests, setPreview } from "./lib/theme";

let iconInfo: IconInfo = { variant: "orbit", storedVariant: null, defaultVariant: "orbit" };
const iconGet = vi.fn(async () => iconInfo);

let themeInfo: ThemeInfo = { mode: "arctic", accent: null, storedMode: null };

vi.mock("./bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("./bridge/commands")>("./bridge/commands");
  return {
    ...actual,
    api: { status: async () => ({ qaMode: false } as unknown as EnvironmentStatus) },
    themeApi: {
      get: async () => themeInfo,
      set: async (mode: string, accent: string | null) => {
        themeInfo = { mode, accent, storedMode: mode };
        return themeInfo;
      },
    },
    iconApi: { get: () => iconGet(), set: async () => iconInfo },
  };
});

async function renderShell() {
  const { default: App } = await import("./App");
  const router = createMemoryRouter(
    [{ path: "/", element: <App />, children: [{ index: true, element: <p>内容区</p> }] }],
    { initialEntries: ["/"] },
  );
  render(<RouterProvider router={router} />);
  await screen.findByText("内容区");
}

function brand() {
  return document.querySelector<HTMLImageElement>(".brand-mark");
}

type Controller = { setDark: (dark: boolean) => void };

function installMatchMedia(initialDark: boolean): Controller {
  let dark = initialDark;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  window.matchMedia = ((query: string) => ({
    get matches() {
      return dark;
    },
    media: query,
    onchange: null,
    addEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) => listeners.delete(fn),
    addListener: (fn: (event: MediaQueryListEvent) => void) => listeners.add(fn),
    removeListener: (fn: (event: MediaQueryListEvent) => void) => listeners.delete(fn),
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

  return {
    setDark(next: boolean) {
      dark = next;
      for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
    },
  };
}

beforeEach(() => {
  iconInfo = { variant: "orbit", storedVariant: null, defaultVariant: "orbit" };
  themeInfo = { mode: "arctic", accent: null, storedMode: null };
  iconGet.mockClear();
  resetIconForTests();
  resetThemeForTests();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  resetIconForTests();
  resetThemeForTests();
});

function brandAppearance() {
  return brand()?.dataset.iconAppearance;
}

describe("品牌图标跟随主题明暗", () => {
  it("深色主题用深色版，浅色主题用浅色版", async () => {
    installMatchMedia(false);
    themeInfo = { mode: "dark", accent: null, storedMode: "dark" };
    await renderShell();
    await waitFor(() => expect(brandAppearance()).toBe("dark"));
  });

  it("主题预览立刻换图标，不写库", async () => {
    installMatchMedia(false);
    await renderShell();
    await waitFor(() => expect(brandAppearance()).toBe("light"));

    act(() => setPreview({ mode: "dark", accent: null }));
    await waitFor(() => expect(brandAppearance()).toBe("dark"));

    act(() => setPreview({ mode: "arctic", accent: null }));
    await waitFor(() => expect(brandAppearance()).toBe("light"));
  });

  it("跟随系统时，系统外观变化会同步换图标", async () => {
    themeInfo = { mode: "system", accent: null, storedMode: "system" };
    const media = installMatchMedia(false);
    await renderShell();
    await waitFor(() => expect(brandAppearance()).toBe("light"));

    act(() => media.setDark(true));
    await waitFor(() => expect(brandAppearance()).toBe("dark"));

    act(() => media.setDark(false));
    await waitFor(() => expect(brandAppearance()).toBe("light"));
  });

  it("手动指定主题后，系统外观变化不能改掉图标明暗", async () => {
    const media = installMatchMedia(false);
    await renderShell();
    await waitFor(() => expect(brandAppearance()).toBe("light"));

    await act(async () => {
      await persistTheme({ mode: "arctic", accent: null });
    });
    await waitFor(() => expect(brandAppearance()).toBe("light"));

    act(() => media.setDark(true));
    act(() => media.setDark(false));
    expect(brandAppearance()).toBe("light");
  });
});

describe("品牌图标跟随设置", () => {
  it("启动时按已保存的变体渲染左上角图标", async () => {
    iconInfo = { variant: "layers", storedVariant: "layers", defaultVariant: "orbit" };
    await renderShell();

    await waitFor(() => expect(brand()?.dataset.iconVariant).toBe("layers"));
    expect(brand()?.getAttribute("src") ?? "").toContain("svg");
    expect(brand()?.getAttribute("alt")).toBe("");
    expect(brand()?.getAttribute("aria-hidden")).toBe("true");
  });

  it("设置页的预览会立刻反映到品牌图标", async () => {
    await renderShell();
    await waitFor(() => expect(brand()?.dataset.iconVariant).toBe("orbit"));

    act(() => setIconPreview("wave-a"));
    await waitFor(() => expect(brand()?.dataset.iconVariant).toBe("wave-a"));
    // 只换图，不动主题
    expect(document.documentElement.getAttribute("data-theme")).toBe("arctic");
  });

  it("图标取不到时回退 orbit，界面照常可用", async () => {
    iconGet.mockRejectedValueOnce({ code: "DB", message: "读不到" });
    await renderShell();
    await waitFor(() => expect(brand()?.dataset.iconVariant).toBe("orbit"));
    expect(screen.getByText("内容区")).toBeInTheDocument();
  });
});
