import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
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
