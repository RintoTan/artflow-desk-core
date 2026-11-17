import { render, screen, waitFor } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EnvironmentStatus, ThemeInfo } from "./bridge/commands";
import { persistTheme, resetThemeForTests } from "./lib/theme";

let themeInfo: ThemeInfo = { mode: "arctic", accent: null, storedMode: null };
const themeSet = vi.fn(async (mode: string, accent: string | null) => {
  themeInfo = { mode, accent, storedMode: mode };
  return themeInfo;
});
const themeGet = vi.fn(async () => themeInfo);

vi.mock("./bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("./bridge/commands")>("./bridge/commands");
  return {
    ...actual,
    api: { status: async () => ({ qaMode: false } as unknown as EnvironmentStatus) },
    themeApi: {
      get: () => themeGet(),
      set: (mode: string, accent: string | null) => themeSet(mode, accent),
    },
  };
});

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
    removeEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) =>
      listeners.delete(fn),
    addListener: (fn: (event: MediaQueryListEvent) => void) => listeners.add(fn),
    removeListener: (fn: (event: MediaQueryListEvent) => void) => listeners.delete(fn),
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

  return {
    setDark(next: boolean) {
      dark = next;
      for (const listener of listeners) {
        listener({ matches: next } as MediaQueryListEvent);
      }
    },
  };
}

async function renderShell() {
  const { default: App } = await import("./App");
  const router = createMemoryRouter(
    [{ path: "/", element: <App />, children: [{ index: true, element: <p>内容区</p> }] }],
    { initialEntries: ["/"] },
  );
  render(<RouterProvider router={router} />);
  await screen.findByText("内容区");
}

function themeAttr() {
  return document.documentElement.getAttribute("data-theme");
}

describe("主题生效", () => {
  beforeEach(() => {
    resetThemeForTests();
    themeInfo = { mode: "arctic", accent: null, storedMode: null };
    themeSet.mockClear();
    themeGet.mockClear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("style");
  });

  afterEach(() => {
    resetThemeForTests();
  });

  it("默认是 Arctic Blue", async () => {
    installMatchMedia(false);
    await renderShell();
    await waitFor(() => expect(themeAttr()).toBe("arctic"));
  });

  it("保存为深色后立刻生效，且不被系统浅色覆盖", async () => {
    const media = installMatchMedia(false);
    await renderShell();
    await waitFor(() => expect(themeAttr()).toBe("arctic"));

    await persistTheme({ mode: "dark", accent: null });
    await waitFor(() => expect(themeAttr()).toBe("dark"));

    media.setDark(true);
    media.setDark(false);
    expect(themeAttr()).toBe("dark");
  });

  it("跟随系统时，系统切换会实时改变外观", async () => {
    themeInfo = { mode: "system", accent: null, storedMode: "system" };
    const media = installMatchMedia(false);
    await renderShell();
    await waitFor(() => expect(themeAttr()).toBe("arctic"));

    media.setDark(true);
    await waitFor(() => expect(themeAttr()).toBe("dark"));

    media.setDark(false);
    await waitFor(() => expect(themeAttr()).toBe("arctic"));
  });

  it("自定义强调色写入 CSS 变量，恢复默认会清掉", async () => {
    installMatchMedia(false);
    await renderShell();
    await waitFor(() => expect(themeAttr()).toBe("arctic"));

    await persistTheme({ mode: "arctic", accent: "#7B5CFF" });
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#7b5cff"),
    );

    await persistTheme({ mode: "arctic", accent: null });
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--accent")).toBe(""),
    );
  });

  it("后端保存的主题在启动时被读出来", async () => {
    themeInfo = { mode: "dark", accent: "#123456", storedMode: "dark" };
    installMatchMedia(false);
    await renderShell();

    await waitFor(() => expect(themeAttr()).toBe("dark"));
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#123456");
  });

  it("配置损坏（未知模式）时回退到 Arctic Blue，不写回库", async () => {
    themeInfo = { mode: "arctic", accent: null, storedMode: "solarized" };
    installMatchMedia(true);
    await renderShell();

    await waitFor(() => expect(themeAttr()).toBe("arctic"));
    expect(themeSet).not.toHaveBeenCalled();
  });
});
