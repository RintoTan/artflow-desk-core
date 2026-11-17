import { act, render, screen, waitFor } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EnvironmentStatus, IconInfo } from "./bridge/commands";
import { resetIconForTests, setIconPreview } from "./lib/appIcon";
import { resetThemeForTests } from "./lib/theme";

let iconInfo: IconInfo = { variant: "orbit", storedVariant: null, defaultVariant: "orbit" };
const iconGet = vi.fn(async () => iconInfo);

vi.mock("./bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("./bridge/commands")>("./bridge/commands");
  return {
    ...actual,
    api: { status: async () => ({ qaMode: false } as unknown as EnvironmentStatus) },
    themeApi: {
      get: async () => ({ mode: "arctic", accent: null, storedMode: null }),
      set: async () => ({ mode: "arctic", accent: null, storedMode: null }),
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

beforeEach(() => {
  iconInfo = { variant: "orbit", storedVariant: null, defaultVariant: "orbit" };
  iconGet.mockClear();
  resetIconForTests();
  resetThemeForTests();
});

afterEach(() => {
  resetIconForTests();
  resetThemeForTests();
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
