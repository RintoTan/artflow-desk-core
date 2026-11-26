import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EnvironmentStatus } from "./bridge/commands";

const status = vi.fn(async () => ({ qaMode: true } as unknown as EnvironmentStatus));

vi.mock("./bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("./bridge/commands")>(
    "./bridge/commands",
  );
  return { ...actual, api: { status } };
});

async function renderShell() {
  const { default: App } = await import("./App");
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <App />,
        children: [{ index: true, element: <p>内容区</p> }],
      },
    ],
    { initialEntries: ["/"] },
  );
  render(<RouterProvider router={router} />);
}

describe("QA 模式标识", () => {
  beforeEach(() => {
    status.mockClear();
  });

  it("QA 模式下外壳显示隔离横幅", async () => {
    status.mockImplementation(async () => ({ qaMode: true } as unknown as EnvironmentStatus));
    await renderShell();
    const banner = await screen.findByRole("status");
    expect(banner).toHaveTextContent("QA 测试环境");
    expect(banner).toHaveTextContent("完全隔离");
  });

  it("横幅同时显示场景与真实数据量", async () => {
    status.mockImplementation(
      async () =>
        ({
          qaMode: true,
          qaScenario: "seeded",
          orders: 72,
          clients: 30,
          templates: 10,
        }) as unknown as EnvironmentStatus,
    );
    await renderShell();
    const banner = await screen.findByRole("status");
    expect(banner).toHaveTextContent("预置场景");
    expect(banner).toHaveTextContent("当前 72 单");
    expect(banner).toHaveTextContent("30 客户");
    expect(banner).toHaveTextContent("10 模板");
  });

  it("空白场景里已有数据时额外标注，不冒充空白", async () => {
    status.mockImplementation(
      async () =>
        ({
          qaMode: true,
          qaScenario: "clean",
          orders: 72,
          clients: 30,
          templates: 10,
        }) as unknown as EnvironmentStatus,
    );
    await renderShell();
    const banner = await screen.findByRole("status");
    expect(banner).toHaveTextContent("空白场景 · 已导入数据");
  });

  it("正式模式下没有横幅", async () => {
    status.mockImplementation(async () => ({ qaMode: false } as unknown as EnvironmentStatus));
    await renderShell();
    await waitFor(() => expect(status).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("状态查询失败也不会挡住界面", async () => {
    status.mockImplementation(async () => {
      throw { code: "DB", message: "boom" };
    });
    await renderShell();
    expect(await screen.findByText("内容区")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("版本信息入口", () => {
  it("左下角常驻入口，点击打开版本弹窗", async () => {
    status.mockImplementation(async () => ({ qaMode: false, appVersion: "0.1.2", schemaVersion: 14 } as unknown as EnvironmentStatus));
    await renderShell();
    const user = userEvent.setup();

    const entry = screen.getByRole("button", { name: "版本信息" });
    expect(within(entry).getByText("ArtFlow Desk Core")).toBeInTheDocument();

    await user.click(entry);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText("0.1.2")).toBeInTheDocument());
    expect(within(dialog).getByText("v14")).toBeInTheDocument();
  });
});
