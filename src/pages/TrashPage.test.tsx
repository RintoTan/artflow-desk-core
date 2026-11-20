import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PurgeCleanupStatus, TrashOrder, TrashSnapshot } from "../bridge/commands";

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  cleanupStatus: vi.fn(),
  retryCleanup: vi.fn(),
}));

vi.mock("../bridge/commands", () => ({
  trashApi: {
    snapshot: mocks.snapshot,
    cleanupStatus: mocks.cleanupStatus,
    retryCleanup: mocks.retryCleanup,
  },
  describeError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

const TrashPage = (await import("./TrashPage")).default;

function order(over: Partial<TrashOrder>): TrashOrder {
  return {
    id: "o1",
    code: "AF-2026-0001",
    title: "订单",
    deletedAt: "2026-11-20T10:00:00+08:00",
    workState: "queued",
    originalClientName: null,
    attachmentCount: 0,
    ...over,
  };
}

function snapshot(over: Partial<TrashSnapshot>): TrashSnapshot {
  return {
    groups: [],
    looseOrders: [],
    groupCount: 0,
    looseOrderCount: 0,
    totalOrderCount: 0,
    ...over,
  };
}

const noCleanup: PurgeCleanupStatus = { failed: 0, oldestCreatedAt: null };

function arrange(snap: TrashSnapshot, cleanup: PurgeCleanupStatus | Error = noCleanup) {
  mocks.snapshot.mockResolvedValue(snap);
  if (cleanup instanceof Error) {
    mocks.cleanupStatus.mockRejectedValue(cleanup);
  } else {
    mocks.cleanupStatus.mockResolvedValue(cleanup);
  }
}

function renderPage() {
  // 页面里用了 useNavigate/useLocation，渲染需要路由上下文。
  return render(
    <MemoryRouter>
      <TrashPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("回收站展示", () => {
  it("读取中先给加载文案，不闪现空态", async () => {
    mocks.snapshot.mockReturnValue(new Promise(() => {}));
    mocks.cleanupStatus.mockReturnValue(new Promise(() => {}));
    renderPage();

    expect(screen.getByText("正在读取回收站…")).toBeInTheDocument();
    expect(screen.queryByText("回收站是空的")).not.toBeInTheDocument();
  });

  it("三段统计与列表一致，独立订单显示原客户", async () => {
    arrange(
      snapshot({
        groups: [
          {
            clientId: "c1",
            clientName: "Rinto",
            deletedAt: "2026-11-20T10:00:00+08:00",
            orders: [
              order({ id: "o1", code: "AF-2026-0041", title: "角色立绘", workState: "inProgress" }),
              order({
                id: "o2",
                code: "AF-2026-0042",
                title: "场景插画",
                workState: "queued",
                deletedAt: "2026-11-18T09:00:00+08:00",
                attachmentCount: 2,
              }),
            ],
          },
        ],
        looseOrders: [
          order({
            id: "o3",
            code: "AF-2026-0055",
            title: "封面",
            workState: "completed",
            deletedAt: "2026-11-19T12:00:00+08:00",
            originalClientName: "Alice",
            attachmentCount: 1,
          }),
        ],
        groupCount: 1,
        looseOrderCount: 1,
        totalOrderCount: 3,
      }),
    );
    renderPage();

    expect(await screen.findByText(/1 个客户组/)).toBeInTheDocument();
    expect(screen.getByText(/1 个独立订单/)).toBeInTheDocument();
    expect(screen.getByText(/共 3 个订单/)).toBeInTheDocument();

    // 只有一个客户组时自动展开。
    expect(screen.getByText("角色立绘")).toBeInTheDocument();
    expect(screen.getByText("制作中")).toBeInTheDocument();
    expect(screen.getByText("排队中")).toBeInTheDocument();

    // 独立订单：原客户 + 状态 + 附件记录数。
    expect(screen.getByText("原客户：Alice")).toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(screen.getByText("1 项附件")).toBeInTheDocument();
    expect(screen.getByText("2 项附件")).toBeInTheDocument();
  });

  it("组内订单与客户组同日时省略日期，不同日单独显示", async () => {
    arrange(
      snapshot({
        groups: [
          {
            clientId: "c1",
            clientName: "Rinto",
            deletedAt: "2026-11-20T10:00:00+08:00",
            orders: [
              order({ id: "o1", title: "同日订单", deletedAt: "2026-11-20T09:00:00+08:00" }),
              order({ id: "o2", title: "早先删除", deletedAt: "2026-11-18T09:00:00+08:00" }),
            ],
          },
        ],
        groupCount: 1,
        totalOrderCount: 2,
      }),
    );
    renderPage();

    // 组头一处 + 早先删除的那单一处，同日的订单不再重复。
    expect(await screen.findAllByText(/删除于 2026-11-20/)).toHaveLength(1);
    expect(screen.getByText(/删除于 2026-11-18/)).toBeInTheDocument();
  });

  it("多个客户组默认折叠，点击后展开", async () => {
    arrange(
      snapshot({
        groups: [
          {
            clientId: "c1",
            clientName: "甲",
            deletedAt: "2026-11-20T10:00:00+08:00",
            orders: [order({ id: "o1", title: "甲的单" })],
          },
          {
            clientId: "c2",
            clientName: "乙",
            deletedAt: "2026-11-19T10:00:00+08:00",
            orders: [order({ id: "o2", title: "乙的单" })],
          },
        ],
        groupCount: 2,
        totalOrderCount: 2,
      }),
    );
    renderPage();

    expect(await screen.findByText("甲")).toBeInTheDocument();
    // 名称过长时单行省略，完整名称留在 title 里。
    expect(screen.getByRole("button", { name: /甲/ })).toHaveAttribute("title", "甲");
    expect(screen.queryByText("甲的单")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /甲/ }));
    expect(screen.getByText("甲的单")).toBeInTheDocument();
    // 只展开被点击的那一组。
    expect(screen.queryByText("乙的单")).not.toBeInTheDocument();
  });

  it("没有订单的客户组仍然展示，并说明名下没有订单", async () => {
    arrange(
      snapshot({
        groups: [
          { clientId: "c1", clientName: "空客户", deletedAt: "2026-11-20T10:00:00+08:00", orders: [] },
        ],
        groupCount: 1,
        totalOrderCount: 0,
      }),
    );
    renderPage();

    expect(await screen.findByText("空客户")).toBeInTheDocument();
    expect(screen.getByText(/无关联订单/)).toBeInTheDocument();
    expect(screen.getByText("该客户名下没有订单。")).toBeInTheDocument();
    // 有客户组就不算空回收站。
    expect(screen.queryByText("回收站是空的")).not.toBeInTheDocument();
  });

  it("只有客户组与独立订单都为 0 时才显示空态，且不显示零统计", async () => {
    arrange(snapshot({}));
    renderPage();

    expect(await screen.findByText("回收站是空的")).toBeInTheDocument();
    // 副标题不再重复页头那句话。
    expect(screen.getByText("现在没有任何已删除的记录。")).toBeInTheDocument();
    // 空态下不渲染「0 个客户组 · 0 个独立订单 · 共 0 个订单」。
    expect(screen.queryByText(/个客户组/)).not.toBeInTheDocument();
  });

  it("列表读取失败时给出错误与重试，不显示空态", async () => {
    mocks.snapshot.mockRejectedValue(new Error("读取失败"));
    mocks.cleanupStatus.mockResolvedValue(noCleanup);
    renderPage();

    expect(await screen.findByText("读取失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新读取" })).toBeInTheDocument();
    expect(screen.queryByText("回收站是空的")).not.toBeInTheDocument();

    mocks.snapshot.mockResolvedValue(snapshot({}));
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    expect(await screen.findByText("回收站是空的")).toBeInTheDocument();
  });

  it("清理状态读取失败不影响列表展示", async () => {
    arrange(
      snapshot({
        looseOrders: [order({ id: "o3", code: "AF-2026-0055", title: "封面" })],
        looseOrderCount: 1,
        totalOrderCount: 1,
      }),
      new Error("状态不可用"),
    );
    renderPage();

    expect(await screen.findByText("封面")).toBeInTheDocument();
    expect(screen.getByText(/附件清理状态暂时不可用：状态不可用/)).toBeInTheDocument();
  });

  it("有清理失败时提示并可重试，重试期间禁止重复点击", async () => {
    arrange(snapshot({}), { failed: 2, oldestCreatedAt: "2026-11-20T00:00:00+08:00" });

    let finish: (value: PurgeCleanupStatus) => void = () => {};
    mocks.retryCleanup.mockReturnValue(
      new Promise<PurgeCleanupStatus>((resolve) => {
        finish = resolve;
      }),
    );

    renderPage();

    expect(await screen.findByText(/有 2 个附件文件尚未成功清理/)).toBeInTheDocument();
    expect(screen.getByText(/对应的订单记录已永久删除/)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "重试附件清理" });
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByRole("button", { name: "正在重试…" })).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "正在重试…" }));
    expect(mocks.retryCleanup).toHaveBeenCalledTimes(1);

    finish({ failed: 0, oldestCreatedAt: null });
    await waitFor(() =>
      expect(screen.queryByText(/尚未成功清理/)).not.toBeInTheDocument(),
    );
  });
});
