import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RouterProvider, createMemoryRouter, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge/commands", () => ({
  trashApi: {
    snapshot: async () => ({
      groups: [],
      looseOrders: [],
      groupCount: 0,
      looseOrderCount: 0,
      totalOrderCount: 0,
    }),
    cleanupStatus: async () => ({ failed: 0, oldestCreatedAt: null }),
    retryCleanup: async () => ({ failed: 0, oldestCreatedAt: null }),
  },
  describeError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

const TrashPage = (await import("./TrashPage")).default;

function SettingsMarker() {
  const navigate = useNavigate();
  return (
    <div>
      <p>SETTINGS_MARKER</p>
      <button type="button" onClick={() => navigate(-1)}>
        测试用后退
      </button>
    </div>
  );
}

const routes = [
  { path: "/settings", element: <SettingsMarker /> },
  { path: "/trash", element: <TrashPage /> },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("回收站的返回导航", () => {
  it("从设置进入时，点「返回设置」回到设置页", async () => {
    const router = createMemoryRouter(routes, {
      initialEntries: [{ pathname: "/settings" }, { pathname: "/trash", state: { from: "settings" } }],
      initialIndex: 1,
    });
    render(<RouterProvider router={router} />);

    await screen.findByRole("heading", { name: "回收站" });
    fireEvent.click(screen.getByRole("button", { name: "← 返回设置" }));

    expect(await screen.findByText("SETTINGS_MARKER")).toBeInTheDocument();
  });

  it("系统级后退也能回到设置页（说明是 push 进去的，历史里有上一页）", async () => {
    const router = createMemoryRouter(routes, {
      initialEntries: [{ pathname: "/settings" }, { pathname: "/trash", state: { from: "settings" } }],
      initialIndex: 1,
    });
    render(<RouterProvider router={router} />);

    await screen.findByRole("heading", { name: "回收站" });

    await act(async () => {
      await router.navigate(-1);
    });

    expect(await screen.findByText("SETTINGS_MARKER")).toBeInTheDocument();
  });

  it("直接访问时返回仍可用，并且不会把自己留在历史里", async () => {
    const router = createMemoryRouter(routes, {
      initialEntries: [{ pathname: "/trash" }],
    });
    render(<RouterProvider router={router} />);

    await screen.findByRole("heading", { name: "回收站" });
    fireEvent.click(screen.getByRole("button", { name: "← 返回设置" }));

    await screen.findByText("SETTINGS_MARKER");

    // 用的是 replace：从设置页再后退，不该回到回收站。
    fireEvent.click(screen.getByRole("button", { name: "测试用后退" }));
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "回收站" })).not.toBeInTheDocument();
    });
    expect(screen.getByText("SETTINGS_MARKER")).toBeInTheDocument();
  });
});
