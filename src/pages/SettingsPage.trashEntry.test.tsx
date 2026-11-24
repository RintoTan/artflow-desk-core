import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

// 这两个面板各自要读后端，本用例只关心设置页里那个入口，先把它们摘掉。
vi.mock("../components/BackupPanel", () => ({ default: () => null }));
vi.mock("../components/AttachmentMaintenancePanel", () => ({ default: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("设置页的回收站入口", () => {
  it("放在「数据维护」里，指向回收站路由，不使用警告样式", async () => {
    const { default: SettingsPage } = await import("./SettingsPage");
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );

    const heading = await screen.findByRole("heading", { name: "数据维护" });
    const section = heading.closest("section");
    expect(section).not.toBeNull();

    const link = screen.getByRole("link", { name: /回收站/ });
    expect(link).toHaveAttribute("href", "/trash");
    expect(section).toContainElement(link);
    expect(link).toHaveTextContent("管理已删除的订单与客户，可以恢复或永久删除");
    // 低频入口：不能借用危险按钮的样式。
    expect(link.className).not.toMatch(/danger/);
  });
});
