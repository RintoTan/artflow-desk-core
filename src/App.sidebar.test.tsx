import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EnvironmentStatus } from "./bridge/commands";
import { resetThemeForTests } from "./lib/theme";

vi.mock("./bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("./bridge/commands")>("./bridge/commands");
  return {
    ...actual,
    api: { status: async () => ({ qaMode: false } as unknown as EnvironmentStatus) },
    themeApi: {
      get: async () => ({ mode: "arctic", accent: null, storedMode: null }),
      set: async (mode: string, accent: string | null) => ({ mode, accent, storedMode: mode }),
    },
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

describe("侧边栏折叠", () => {
  beforeEach(() => {
    resetThemeForTests();
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("默认展开，折叠后主内容区变宽并保存状态", async () => {
    await renderShell();
    const shell = document.querySelector(".shell");
    expect(shell).not.toHaveClass("shell-sidebar-collapsed");

    await userEvent.click(screen.getByRole("button", { name: "折叠侧边栏" }));

    expect(shell).toHaveClass("shell-sidebar-collapsed");
    expect(screen.getByRole("button", { name: "展开侧边栏" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(window.localStorage.getItem("minidesk.sidebar")).toBe("collapsed");
  });

  it("折叠后导航仍有可读名称与提示", async () => {
    await renderShell();
    await userEvent.click(screen.getByRole("button", { name: "折叠侧边栏" }));

    const orders = screen.getByRole("link", { name: "订单" });
    expect(orders).toHaveAttribute("title", "订单");
    expect(orders).toHaveAccessibleName("订单");
    // 八个导航项都还在（新增「日历」）
    expect(screen.getAllByRole("link")).toHaveLength(8);
  });

  it("每个导航项都有统一的线性图标，描边与尺寸一致", async () => {
    await renderShell();
    const icons = document.querySelectorAll("svg.nav-icon");
    // 8 个导航 + 折叠按钮上的箭头
    expect(icons.length).toBe(9);
    for (const icon of Array.from(icons)) {
      const path = icon.querySelector("path");
      expect(path?.getAttribute("stroke-width") ?? icon.getAttribute("stroke-width")).toBe("1.8");
      expect(icon.getAttribute("aria-hidden")).toBe("true");
    }
    // 每个导航链接都含图标，且图标不抢可访问名称
    for (const link of Array.from(document.querySelectorAll("a.nav-item"))) {
      expect(link.querySelector("svg.nav-icon")).not.toBeNull();
    }
  });

  it("再次点击展开，状态可来回切换", async () => {
    await renderShell();
    await userEvent.click(screen.getByRole("button", { name: "折叠侧边栏" }));
    await userEvent.click(screen.getByRole("button", { name: "展开侧边栏" }));

    expect(document.querySelector(".shell")).not.toHaveClass("shell-sidebar-collapsed");
    expect(window.localStorage.getItem("minidesk.sidebar")).toBe("expanded");
  });

  it("折叠状态在重新挂载后保留", async () => {
    window.localStorage.setItem("minidesk.sidebar", "collapsed");
    await renderShell();
    expect(document.querySelector(".shell")).toHaveClass("shell-sidebar-collapsed");
  });
});
