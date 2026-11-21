import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TrashOrder, TrashSnapshot } from "../bridge/commands";

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  cleanupStatus: vi.fn(),
  retryCleanup: vi.fn(),
  restoreOrder: vi.fn(),
  restoreClient: vi.fn(),
  purgeOrder: vi.fn(),
  purgeClient: vi.fn(),
  empty: vi.fn(),
}));

vi.mock("../bridge/commands", () => ({
  trashApi: {
    snapshot: mocks.snapshot,
    cleanupStatus: mocks.cleanupStatus,
    retryCleanup: mocks.retryCleanup,
    restoreOrder: mocks.restoreOrder,
    restoreClient: mocks.restoreClient,
    purgeOrder: mocks.purgeOrder,
    purgeClient: mocks.purgeClient,
    empty: mocks.empty,
  },
  describeError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

const TrashPage = (await import("./TrashPage")).default;

function order(over: Partial<TrashOrder>): TrashOrder {
  return {
    id: "o1",
    code: "AF-2026-0001",
    title: "组内订单",
    deletedAt: "2026-11-20T10:00:00+08:00",
    workState: "inProgress",
    originalClientName: null,
    attachmentCount: 0,
    ...over,
  };
}

function snapshot(over: Partial<TrashSnapshot> = {}): TrashSnapshot {
  return {
    groups: [
      {
        clientId: "c1",
        clientName: "林小满",
        deletedAt: "2026-11-20T10:00:00+08:00",
        orders: [
          order({ id: "o1", code: "AF-2026-0001", attachmentCount: 4 }),
          order({ id: "o2", code: "AF-2026-0002", title: "第二单" }),
        ],
      },
    ],
    looseOrders: [
      order({
        id: "o3",
        code: "AF-2026-0003",
        title: "独立订单",
        originalClientName: "陈叙",
        workState: "completed",
        deletedAt: "2026-11-19T10:00:00+08:00",
      }),
    ],
    groupCount: 1,
    looseOrderCount: 1,
    totalOrderCount: 3,
    ...over,
  };
}

const cleanStatus = { failed: 0, oldestCreatedAt: null };
const purgeOk = {
  ordersPurged: 1,
  attachmentsRemoved: 1,
  filesRegistered: 2,
  cleanup: { cleaned: 2, pending: 0, pendingPaths: [] },
};
const purgePartial = {
  ordersPurged: 1,
  attachmentsRemoved: 1,
  filesRegistered: 2,
  cleanup: { cleaned: 1, pending: 1, pendingPaths: ["attachments/originals/x.png"] },
};
const groupPurgeOk = { clientId: "c1", clientsPurged: 1, ordersPurged: 2, attachmentsRemoved: 4, filesRegistered: 8, cleanup: { cleaned: 8, pending: 0, pendingPaths: [] } };

function arrange(snap: TrashSnapshot = snapshot()) {
  mocks.snapshot.mockResolvedValue(snap);
  mocks.cleanupStatus.mockResolvedValue(cleanStatus);
}

function renderPage() {
  return render(
    <MemoryRouter>
      <TrashPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.snapshot.mockResolvedValue(snapshot());
  mocks.cleanupStatus.mockResolvedValue(cleanStatus);
  mocks.restoreOrder.mockResolvedValue({ orderId: "o3", ordersRestored: 1 });
  mocks.restoreClient.mockResolvedValue({ clientId: "c1", ordersRestored: 2, clientsRestored: 1 });
  mocks.purgeOrder.mockResolvedValue(purgeOk);
  mocks.purgeClient.mockResolvedValue(groupPurgeOk);
  mocks.retryCleanup.mockResolvedValue(cleanStatus);
});

describe("回收站操作", () => {
  it("独立订单可以直接恢复，不需要确认框", async () => {
    const user = userEvent.setup();
    arrange();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "恢复订单" }));

    await waitFor(() => expect(mocks.restoreOrder).toHaveBeenCalledWith("o3"));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(await screen.findByText("已恢复订单 AF-2026-0003")).toBeInTheDocument();
  });

  it("客户组内部不提供单独恢复入口", async () => {
    arrange();
    renderPage();

    await screen.findByText("组内订单");
    const groupOrders = document.querySelector(".trash-orders");
    expect(groupOrders).not.toBeNull();
    const withinGroup = within(groupOrders as HTMLElement);
    expect(withinGroup.queryByRole("button", { name: "恢复订单" })).not.toBeInTheDocument();
    expect(withinGroup.queryByRole("button", { name: "永久删除" })).not.toBeInTheDocument();
  });

  it("客户组整批恢复需要确认，确认后按批次恢复", async () => {
    const user = userEvent.setup();
    arrange();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "整批恢复" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("将恢复客户「林小满」及其 2 个订单");
    expect(mocks.restoreClient).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "整批恢复" }));
    await waitFor(() => expect(mocks.restoreClient).toHaveBeenCalledWith("c1"));
    expect(await screen.findByText(/已恢复客户「林小满」及其 2 个订单/)).toBeInTheDocument();
  });

  it("永久删除订单使用强确认，并展示附件记录数", async () => {
    const user = userEvent.setup();
    arrange();
    renderPage();

    await screen.findByRole("heading", { name: "独立订单" });
    const loose = document.querySelectorAll(".trash-orders")[1] as HTMLElement;
    await user.click(within(loose).getByRole("button", { name: "永久删除" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("永久删除？");
    expect(dialog).toHaveTextContent("无法恢复");
    expect(document.querySelector(".modal")).not.toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "永久删除" }));
    await waitFor(() => expect(mocks.purgeOrder).toHaveBeenCalledWith("o3"));
    expect(await screen.findByText("已永久删除，附件文件已清理")).toBeInTheDocument();
  });

  it("客户组永久删除展示影响范围，附件数量用「项附件」", async () => {
    const user = userEvent.setup();
    arrange();
    renderPage();

    await screen.findByText("林小满");
    const head = document.querySelector(".trash-group-head") as HTMLElement;
    await user.click(within(head).getByRole("button", { name: "永久删除" }));
    const dialog = await screen.findByRole("alertdialog");

    expect(dialog).toHaveTextContent("客户「林小满」、2 个订单、4 项附件");
    expect(dialog).not.toHaveTextContent("个附件文件");
  });

  it("附件清理未完成时如实提示，不说全部完成", async () => {
    const user = userEvent.setup();
    mocks.purgeOrder.mockResolvedValueOnce(purgePartial);
    arrange();
    renderPage();

    await screen.findByRole("heading", { name: "独立订单" });
    const loose = document.querySelectorAll(".trash-orders")[1] as HTMLElement;
    await user.click(within(loose).getByRole("button", { name: "永久删除" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "永久删除" }));

    expect(
      await screen.findByText(/1 个附件文件未清理/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/附件文件已清理$/)).not.toBeInTheDocument();
  });

  it("INTEGRITY 错误显示专用文案，且不触发重新读取", async () => {
    const user = userEvent.setup();
    mocks.purgeClient.mockRejectedValueOnce(
      Object.assign(new Error("批次不一致"), { code: "INTEGRITY" }),
    );
    arrange();
    renderPage();

    const callsBefore = mocks.snapshot.mock.calls.length;
    await screen.findByText("林小满");
    const head = document.querySelector(".trash-group-head") as HTMLElement;
    await user.click(within(head).getByRole("button", { name: "永久删除" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "永久删除" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "数据完整性检查未通过，操作已中止。建议先导出备份再联系支持。",
    );
    expect(mocks.snapshot.mock.calls.length).toBe(callsBefore);
  });

  it("空回收站不显示清空按钮", async () => {
    arrange(
      snapshot({ groups: [], looseOrders: [], groupCount: 0, looseOrderCount: 0, totalOrderCount: 0 }),
    );
    renderPage();

    expect(await screen.findByText("回收站是空的")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "清空回收站…" })).not.toBeInTheDocument();
  });
});

describe("清空回收站", () => {
  it("三个数字直接取自 snapshot，输入完全匹配才启用确认", async () => {
    const user = userEvent.setup();
    arrange();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "清空回收站…" }));
    const dialog = await screen.findByRole("alertdialog");

    const counts = dialog.querySelector(".purge-counts") as HTMLElement;
    const rows = within(counts).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("客户组1 个");
    expect(rows[1]).toHaveTextContent("独立订单1 个");
    expect(rows[2]).toHaveTextContent("涉及订单总数3 个");

    const confirm = within(dialog).getByRole("button", { name: "永久删除" });
    expect(confirm).toBeDisabled();

    const input = within(dialog).getByLabelText("清空确认文字") as HTMLInputElement;
    // 末尾多一个空格必须仍然禁用：不做 trim。
    fireEvent.change(input, { target: { value: "清空回收站 " } });
    expect(confirm).toBeDisabled();

    fireEvent.change(input, { target: { value: "清空回收站" } });
    expect(confirm).toBeEnabled();
  });

  it("部分失败时关闭对话框、展示结果条，并可重试未完成批次", async () => {
    const user = userEvent.setup();
    mocks.empty
      .mockResolvedValueOnce({
        batches: [
          { label: "客户「甲」+1 单", ok: true, ordersPurged: 1, filesRegistered: 2, cleanupPending: 0, error: null },
          { label: "客户「乙」+2 单", ok: false, ordersPurged: 0, filesRegistered: 0, cleanupPending: 0, error: "injected" },
        ],
        purgedBatches: 1,
        failedBatches: 1,
        ordersPurged: 1,
        filesRegistered: 2,
        cleanupPending: 0,
      })
      .mockResolvedValueOnce({
        batches: [
          { label: "客户「乙」+2 单", ok: true, ordersPurged: 2, filesRegistered: 4, cleanupPending: 0, error: null },
        ],
        purgedBatches: 1,
        failedBatches: 0,
        ordersPurged: 2,
        filesRegistered: 4,
        cleanupPending: 0,
      });
    arrange();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "清空回收站…" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("清空确认文字"), {
      target: { value: "清空回收站" },
    });
    await user.click(within(dialog).getByRole("button", { name: "永久删除" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    const result = await screen.findByRole("status", { name: "" }).catch(() => null);
    void result;
    expect(screen.getByText(/数据库：已永久删除 1 批、共 1 个订单/)).toBeInTheDocument();
    expect(screen.getByText(/1 批失败：客户「乙」\+2 单（injected）/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重试未完成" }));
    await waitFor(() => expect(mocks.empty).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByText(/数据库：已永久删除 1 批、共 2 个订单/)).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "重试未完成" })).not.toBeInTheDocument();
  });
});

describe("清空结果的数据库维度与全局附件状态", () => {
  const okBatch = (label: string, orders: number, pending = 0) => ({
    label,
    ok: true,
    ordersPurged: orders,
    filesRegistered: orders * 2,
    cleanupPending: pending,
    error: null,
  });
  const failBatch = (label: string) => ({
    label,
    ok: false,
    ordersPurged: 0,
    filesRegistered: 0,
    cleanupPending: 0,
    error: "injected",
  });
  const emptyResult = (batches: unknown[], orders: number) => ({
    batches,
    purgedBatches: batches.filter((b) => (b as { ok: boolean }).ok).length,
    failedBatches: batches.filter((b) => !(b as { ok: boolean }).ok).length,
    ordersPurged: orders,
    filesRegistered: 0,
    cleanupPending: 0,
  });

  async function runEmptyOnce(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: "清空回收站…" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("清空确认文字"), {
      target: { value: "清空回收站" },
    });
    await user.click(within(dialog).getByRole("button", { name: "永久删除" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  }

  it("批次全部成功、但全局仍有附件任务失败时，不能说「全部完成」", async () => {
    const user = userEvent.setup();
    mocks.empty.mockResolvedValueOnce(
      emptyResult([okBatch("客户「甲」+1 单", 1, 2), okBatch("订单 AF-2026-0009", 1, 0)], 2),
    );
    arrange();
    mocks.cleanupStatus.mockResolvedValue({ failed: 2, oldestCreatedAt: null });
    renderPage();

    await runEmptyOnce(user);

    expect(screen.getByText(/数据库：已永久删除 2 批、共 2 个订单/)).toBeInTheDocument();
    expect(
      screen.getByText(/附件清理：当前全局仍有 2 个清理任务失败/),
    ).toBeInTheDocument();
    expect(screen.queryByText("全部完成。")).not.toBeInTheDocument();
  });

  it("批次失败与附件失败同时存在时，两种信息都显示", async () => {
    const user = userEvent.setup();
    mocks.empty.mockResolvedValueOnce(
      emptyResult([okBatch("客户「甲」+1 单", 1, 3), failBatch("客户「乙」+2 单")], 1),
    );
    arrange();
    mocks.cleanupStatus.mockResolvedValue({ failed: 3, oldestCreatedAt: null });
    renderPage();

    await runEmptyOnce(user);

    expect(screen.getByText(/1 批失败：客户「乙」\+2 单（injected）/)).toBeInTheDocument();
    expect(
      screen.getByText(/附件清理：当前全局仍有 3 个清理任务失败/),
    ).toBeInTheDocument();
    expect(screen.queryByText("全部完成。")).not.toBeInTheDocument();
  });

  it("附件状态使用全局口径：其他订单遗留的失败任务也会被计入", async () => {
    const user = userEvent.setup();
    // 本次清空自己没留下待清理任务，但库里还有别的 5 个失败任务。
    mocks.empty.mockResolvedValueOnce(emptyResult([okBatch("客户「甲」+1 单", 1, 0)], 1));
    arrange();
    mocks.cleanupStatus.mockResolvedValue({ failed: 5, oldestCreatedAt: null });
    renderPage();

    await runEmptyOnce(user);

    expect(
      screen.getByText(/附件清理：当前全局仍有 5 个清理任务失败/),
    ).toBeInTheDocument();
    expect(screen.queryByText("全部完成。")).not.toBeInTheDocument();
  });

  it("第一次清空留下失败附件、第二次重试批次后，仍不能显示全部完成", async () => {
    const user = userEvent.setup();
    mocks.empty
      .mockResolvedValueOnce(
        emptyResult([okBatch("客户「甲」+1 单", 1, 2), failBatch("客户「乙」+2 单")], 1),
      )
      .mockResolvedValueOnce(emptyResult([okBatch("客户「乙」+2 单", 2, 0)], 2));
    arrange();
    // 严格按时间线给值：初次 0 → 第一次清空后 2 → 第二次清空后仍是 2。
    // 若有人删掉 reload，第二次断言就会因为停在旧值而失败。
    mocks.cleanupStatus
      .mockResolvedValueOnce({ failed: 0, oldestCreatedAt: null })
      .mockResolvedValueOnce({ failed: 2, oldestCreatedAt: null })
      .mockResolvedValueOnce({ failed: 2, oldestCreatedAt: null });
    renderPage();

    await runEmptyOnce(user);
    expect(mocks.cleanupStatus).toHaveBeenCalledTimes(2);
    expect(
      screen.getByText(/附件清理：当前全局仍有 2 个清理任务失败/),
    ).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "重试未完成" }));
    await waitFor(() => expect(mocks.empty).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mocks.cleanupStatus).toHaveBeenCalledTimes(3));

    expect(screen.getByText(/数据库：已永久删除 1 批、共 2 个订单/)).toBeInTheDocument();
    expect(
      screen.getByText(/附件清理：当前全局仍有 2 个清理任务失败/),
    ).toBeInTheDocument();
    expect(screen.queryByText("全部完成。")).not.toBeInTheDocument();
  });

  it("手动重试附件清理成功后，才允许显示全部完成", async () => {
    const user = userEvent.setup();
    mocks.empty.mockResolvedValueOnce(emptyResult([okBatch("客户「甲」+1 单", 1, 2)], 1));
    arrange();
    mocks.cleanupStatus.mockResolvedValue({ failed: 2, oldestCreatedAt: null });
    mocks.retryCleanup.mockResolvedValue({ failed: 0, oldestCreatedAt: null });
    renderPage();

    await runEmptyOnce(user);
    expect(screen.queryByText("全部完成。")).not.toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "重试附件清理" }));

    await waitFor(() => expect(screen.getByText("全部完成。")).toBeInTheDocument());
    expect(screen.queryByText(/当前全局仍有/)).not.toBeInTheDocument();
  });

  it("初始状态读取成功、清空后的重读失败时，不显示全部完成", async () => {
    const user = userEvent.setup();
    mocks.empty.mockResolvedValueOnce(emptyResult([okBatch("客户「甲」+1 单", 1, 0)], 1));
    arrange();
    // 第一次（挂载）成功 0；清空后的第二次失败。
    mocks.cleanupStatus
      .mockResolvedValueOnce({ failed: 0, oldestCreatedAt: null })
      .mockRejectedValueOnce(new Error("状态不可用"));
    renderPage();

    await runEmptyOnce(user);

    expect(screen.getByText(/数据库：已永久删除 1 批、共 1 个订单/)).toBeInTheDocument();
    expect(screen.getByText(/附件清理状态暂时不可用/)).toBeInTheDocument();
    expect(screen.queryByText("全部完成。")).not.toBeInTheDocument();
    expect(screen.queryByText(/当前全局仍有/)).not.toBeInTheDocument();
  });

  it("清空后状态仍在读取中时，不拿旧数字显示全部完成", async () => {
    const user = userEvent.setup();
    mocks.empty.mockResolvedValueOnce(emptyResult([okBatch("客户「甲」+1 单", 1, 0)], 1));
    arrange();

    let resolveStatus: (value: { failed: number; oldestCreatedAt: null }) => void = () => {};
    mocks.cleanupStatus
      .mockResolvedValueOnce({ failed: 0, oldestCreatedAt: null })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
      );
    renderPage();

    await runEmptyOnce(user);

    // 新状态尚未返回：数据库结果已出，但绝不能显示「全部完成」。
    expect(screen.getByText(/数据库：已永久删除 1 批、共 1 个订单/)).toBeInTheDocument();
    expect(screen.queryByText("全部完成。")).not.toBeInTheDocument();

    resolveStatus({ failed: 2, oldestCreatedAt: null });
    await waitFor(() =>
      expect(screen.getByText(/附件清理：当前全局仍有 2 个清理任务失败/)).toBeInTheDocument(),
    );
    expect(screen.queryByText("全部完成。")).not.toBeInTheDocument();
  });

  it("手动附件重试失败后，不再展示旧的全局数字", async () => {
    const user = userEvent.setup();
    mocks.empty.mockResolvedValueOnce(emptyResult([okBatch("客户「甲」+1 单", 1, 0)], 1));
    arrange();
    mocks.cleanupStatus.mockResolvedValue({ failed: 2, oldestCreatedAt: null });
    mocks.retryCleanup.mockRejectedValueOnce(new Error("重试失败"));
    renderPage();

    await runEmptyOnce(user);
    expect(
      screen.getByText(/附件清理：当前全局仍有 2 个清理任务失败/),
    ).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "重试附件清理" }));

    await waitFor(() =>
      expect(screen.getByText(/附件清理状态暂时不可用/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/当前全局仍有/)).not.toBeInTheDocument();
    expect(screen.queryByText("全部完成。")).not.toBeInTheDocument();
  });

  it("清空执行期间重复点击只会调用一次 empty", async () => {
    const user = userEvent.setup();
    let finish: (value: unknown) => void = () => {};
    mocks.empty.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    arrange();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "清空回收站…" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("清空确认文字"), {
      target: { value: "清空回收站" },
    });
    const confirm = within(dialog).getByRole("button", { name: "永久删除" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => expect(mocks.empty).toHaveBeenCalledTimes(1));

    finish(emptyResult([okBatch("客户「甲」+1 单", 1, 0)], 1));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });
});

describe("恢复路径的完整性异常", () => {
  it("restoreClient 返回 INTEGRITY 时显示专用文案", async () => {
    const user = userEvent.setup();
    mocks.restoreClient.mockRejectedValueOnce(
      Object.assign(new Error("批次不一致"), { code: "INTEGRITY" }),
    );
    arrange();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "整批恢复" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "整批恢复" }));

    expect(await screen.findByText(/数据完整性检查未通过，操作已中止/)).toBeInTheDocument();
  });
});

describe("重试失败后的可见反馈与恢复入口", () => {
  const okBatch = (label: string, orders: number) => ({
    label,
    ok: true,
    ordersPurged: orders,
    filesRegistered: orders * 2,
    cleanupPending: 0,
    error: null,
  });
  const failBatch = (label: string) => ({
    label,
    ok: false,
    ordersPurged: 0,
    filesRegistered: 0,
    cleanupPending: 0,
    error: "injected",
  });
  const resultOf = (batches: unknown[]) => ({
    batches,
    purgedBatches: batches.filter((b) => (b as { ok: boolean }).ok).length,
    failedBatches: batches.filter((b) => !(b as { ok: boolean }).ok).length,
    ordersPurged: 1,
    filesRegistered: 0,
    cleanupPending: 0,
  });

  async function clearOnce(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: "清空回收站…" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("清空确认文字"), {
      target: { value: "清空回收站" },
    });
    await user.click(within(dialog).getByRole("button", { name: "永久删除" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  }

  it("「重试未完成」失败时，错误在结果条可见，且按钮恢复可用", async () => {
    const user = userEvent.setup();
    mocks.empty
      .mockResolvedValueOnce(resultOf([okBatch("客户「甲」+1 单", 1), failBatch("客户「乙」+2 单")]))
      .mockRejectedValueOnce(new Error("重试失败原因"));
    arrange();
    renderPage();

    await clearOnce(user);
    await user.click(await screen.findByRole("button", { name: "重试未完成" }));

    // 确认框已关闭，错误只能出现在结果条里。
    expect(await screen.findByText(/重试未成功：重试失败原因/)).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "重试未完成" });
    expect(retry).toBeEnabled();
    expect(screen.getByText(/1 批失败：客户「乙」\+2 单/)).toBeInTheDocument();
  });

  it("附件重试失败后提供「重新读取状态」，读取成功即恢复重试入口", async () => {
    const user = userEvent.setup();
    mocks.empty.mockResolvedValueOnce(resultOf([okBatch("客户「甲」+1 单", 1)]));
    arrange();
    mocks.cleanupStatus.mockResolvedValue({ failed: 2, oldestCreatedAt: null });
    mocks.retryCleanup.mockRejectedValueOnce(new Error("重试不可用"));
    renderPage();

    await clearOnce(user);
    await user.click(await screen.findByRole("button", { name: "重试附件清理" }));

    expect(await screen.findByText(/附件清理状态暂时不可用/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试附件清理" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重新读取状态" }));

    // 重新读取成功后，全局状态与重试入口都回来。
    expect(await screen.findByRole("button", { name: "重试附件清理" })).toBeInTheDocument();
    expect(screen.getByText(/当前全局仍有 2 个清理任务失败/)).toBeInTheDocument();
    expect(screen.queryByText(/附件清理状态暂时不可用/)).not.toBeInTheDocument();
  });

  it("重新读取仍然失败时，继续显示状态不可用", async () => {
    const user = userEvent.setup();
    mocks.empty.mockResolvedValueOnce(resultOf([okBatch("客户「甲」+1 单", 1)]));
    arrange();
    mocks.cleanupStatus
      .mockResolvedValueOnce({ failed: 2, oldestCreatedAt: null })
      .mockResolvedValueOnce({ failed: 2, oldestCreatedAt: null })
      .mockRejectedValue(new Error("仍然不可用"));
    mocks.retryCleanup.mockRejectedValueOnce(new Error("重试不可用"));
    renderPage();

    await clearOnce(user);
    await user.click(await screen.findByRole("button", { name: "重试附件清理" }));
    await screen.findByText(/附件清理状态暂时不可用/);

    await user.click(screen.getByRole("button", { name: "重新读取状态" }));

    expect(await screen.findByText(/仍然不可用/)).toBeInTheDocument();
    expect(screen.queryByText("全部完成。")).not.toBeInTheDocument();
  });
});

describe("刷新期间的清空入口保护", () => {
  it("清空成功后快照仍在读取时，清空按钮不可用；数据回来再恢复", async () => {
    const user = userEvent.setup();
    mocks.empty.mockResolvedValueOnce({
      batches: [
        { label: "客户「甲」+1 单", ok: true, ordersPurged: 1, filesRegistered: 2, cleanupPending: 0, error: null },
      ],
      purgedBatches: 1,
      failedBatches: 0,
      ordersPurged: 1,
      filesRegistered: 2,
      cleanupPending: 0,
    });
    arrange();

    let resolveSnapshot: (value: TrashSnapshot) => void = () => {};
    // 挂载时正常返回，清空后的那次读取先挂起。
    mocks.snapshot
      .mockResolvedValueOnce(snapshot())
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
      );
    renderPage();

    await user.click(await screen.findByRole("button", { name: "清空回收站…" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("清空确认文字"), {
      target: { value: "清空回收站" },
    });
    await user.click(within(dialog).getByRole("button", { name: "永久删除" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());

    // 新快照未返回：按钮必须消失，不能拿旧数据再开一次清空。
    expect(screen.queryByRole("button", { name: "清空回收站…" })).not.toBeInTheDocument();
    expect(screen.getByText("正在读取回收站…")).toBeInTheDocument();

    resolveSnapshot(snapshot());
    expect(await screen.findByRole("button", { name: "清空回收站…" })).toBeEnabled();
  });

  it("结果条把两段说明收在同一个纵向文本块里，按钮不挤压正文", async () => {
    const user = userEvent.setup();
    mocks.empty.mockResolvedValueOnce({
      batches: [
        { label: "客户「甲」+1 单", ok: true, ordersPurged: 1, filesRegistered: 2, cleanupPending: 3, error: null },
        { label: "客户「乙」+2 单", ok: false, ordersPurged: 0, filesRegistered: 0, cleanupPending: 0, error: "injected" },
      ],
      purgedBatches: 1,
      failedBatches: 1,
      ordersPurged: 1,
      filesRegistered: 2,
      cleanupPending: 3,
    });
    arrange();
    mocks.cleanupStatus.mockResolvedValue({ failed: 3, oldestCreatedAt: null });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "清空回收站…" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("清空确认文字"), {
      target: { value: "清空回收站" },
    });
    await user.click(within(dialog).getByRole("button", { name: "永久删除" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());

    const result = document.querySelector(".trash-result") as HTMLElement;
    const copy = result.querySelector(".trash-result-copy") as HTMLElement;
    expect(copy).not.toBeNull();
    expect(within(copy).getByText(/数据库：已永久删除/)).toBeInTheDocument();
    expect(within(copy).getByText(/附件清理：当前全局仍有 3 个/)).toBeInTheDocument();

    // 按钮是文本块的兄弟节点，不能挤在段落之间。
    const retry = within(result).getByRole("button", { name: "重试未完成" });
    expect(copy).not.toContainElement(retry);
    expect(result.firstElementChild).toBe(copy);
  });
});

/** 挂起的 Promise：用来把「恢复进行中」这一瞬间固定住，再观察按钮状态。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 两张独立订单的快照：用于验证 A 恢复期间 B 也被锁住。 */
function twoLooseSnapshot() {
  return snapshot({
    looseOrders: [
      order({ id: "o3", code: "AF-2026-0003", title: "独立订单", originalClientName: "陈叙" }),
      order({ id: "o4", code: "AF-2026-0004", title: "另一张独立订单" }),
    ],
    looseOrderCount: 2,
    totalOrderCount: 4,
  });
}

describe("恢复的全局锁（O1）", () => {
  it("独立订单 A 恢复挂起时，独立订单 B 的按钮禁用", async () => {
    const user = userEvent.setup();
    arrange(twoLooseSnapshot());
    const gate = deferred<{ orderId: string; ordersRestored: number }>();
    mocks.restoreOrder.mockReturnValueOnce(gate.promise);
    renderPage();

    const buttons = await screen.findAllByRole("button", { name: "恢复订单" });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[0]!);

    await waitFor(() => expect(buttons[1]).toBeDisabled());
    gate.resolve({ orderId: "o3", ordersRestored: 1 });
    await screen.findByText("已恢复订单 AF-2026-0003");
  });

  it("独立订单恢复挂起时，客户组整批恢复按钮禁用", async () => {
    const user = userEvent.setup();
    arrange(twoLooseSnapshot());
    const gate = deferred<{ orderId: string; ordersRestored: number }>();
    mocks.restoreOrder.mockReturnValueOnce(gate.promise);
    renderPage();

    await user.click((await screen.findAllByRole("button", { name: "恢复订单" }))[0]!);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "整批恢复" })).toBeDisabled(),
    );
    gate.resolve({ orderId: "o3", ordersRestored: 1 });
    await screen.findByText("已恢复订单 AF-2026-0003");
  });

  it("客户组整批恢复挂起时，其他恢复入口全部禁用，执行中那组显示「正在恢复…」", async () => {
    const user = userEvent.setup();
    arrange(twoLooseSnapshot());
    const gate = deferred<{ clientId: string; ordersRestored: number; clientsRestored: number }>();
    mocks.restoreClient.mockReturnValueOnce(gate.promise);
    renderPage();

    await user.click(await screen.findByRole("button", { name: "整批恢复" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "整批恢复" }));

    // 执行中的客户组那一行换成进行中文案，其余入口保持原文案但禁用。
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "正在恢复…" })).toBeInTheDocument(),
    );
    for (const button of screen.getAllByRole("button", { name: "恢复订单" })) {
      expect(button).toBeDisabled();
    }

    gate.resolve({ clientId: "c1", ordersRestored: 2, clientsRestored: 1 });
    expect(await screen.findByText(/已恢复客户「林小满」及其 2 个订单/)).toBeInTheDocument();
  });

  it("执行中的那一行显示「正在恢复…」，其他行保留「恢复订单」", async () => {
    const user = userEvent.setup();
    arrange(twoLooseSnapshot());
    const gate = deferred<{ orderId: string; ordersRestored: number }>();
    mocks.restoreOrder.mockReturnValueOnce(gate.promise);
    renderPage();

    const buttons = await screen.findAllByRole("button", { name: "恢复订单" });
    await user.click(buttons[0]!);

    const running = await screen.findByRole("button", { name: "正在恢复…" });
    expect(running).toBeDisabled();
    expect(screen.getByRole("button", { name: "恢复订单" })).toBeDisabled();

    gate.resolve({ orderId: "o3", ordersRestored: 1 });
    await screen.findByText("已恢复订单 AF-2026-0003");
  });

  it("恢复成功后所有恢复入口恢复可用", async () => {
    const user = userEvent.setup();
    arrange(twoLooseSnapshot());
    const gate = deferred<{ orderId: string; ordersRestored: number }>();
    mocks.restoreOrder.mockReturnValueOnce(gate.promise);
    renderPage();

    await user.click((await screen.findAllByRole("button", { name: "恢复订单" }))[0]!);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "整批恢复" })).toBeDisabled(),
    );

    gate.resolve({ orderId: "o3", ordersRestored: 1 });
    await screen.findByText("已恢复订单 AF-2026-0003");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "整批恢复" })).toBeEnabled();
      // 恢复成功会重新读取快照；剩下的订单仍可再次恢复。
      const remaining = screen.queryAllByRole("button", { name: "恢复订单" });
      for (const button of remaining) expect(button).toBeEnabled();
      expect(screen.queryByRole("button", { name: "正在恢复…" })).toBeNull();
    });
  });

  it("恢复失败后所有恢复入口恢复可用，错误照旧可见", async () => {
    const user = userEvent.setup();
    arrange(twoLooseSnapshot());
    const gate = deferred<{ orderId: string; ordersRestored: number }>();
    mocks.restoreOrder.mockReturnValueOnce(gate.promise);
    renderPage();

    await user.click((await screen.findAllByRole("button", { name: "恢复订单" }))[0]!);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "整批恢复" })).toBeDisabled(),
    );

    gate.reject(new Error("无法恢复：订单已被永久删除"));
    await screen.findByText(/无法恢复：订单已被永久删除/);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "整批恢复" })).toBeEnabled();
      const remaining = screen.queryAllByRole("button", { name: "恢复订单" });
      for (const button of remaining) expect(button).toBeEnabled();
    });
  });

  it("禁用状态下重复点击不会再次触发恢复接口", async () => {
    const user = userEvent.setup();
    arrange(twoLooseSnapshot());
    const gate = deferred<{ orderId: string; ordersRestored: number }>();
    mocks.restoreOrder.mockReturnValueOnce(gate.promise);
    renderPage();

    const buttons = await screen.findAllByRole("button", { name: "恢复订单" });
    await user.click(buttons[0]!);
    await waitFor(() => expect(buttons[1]).toBeDisabled());

    // 直接对禁用按钮派发点击：即使绕过 userEvent 的禁用判断，也不得发出第二个请求。
    fireEvent.click(buttons[1]!);
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(mocks.restoreOrder).toHaveBeenCalledTimes(1));

    gate.resolve({ orderId: "o3", ordersRestored: 1 });
    await screen.findByText("已恢复订单 AF-2026-0003");
    expect(mocks.restoreOrder).toHaveBeenCalledTimes(1);
  });
});

/** 两个客户组 + 一张独立订单：验证客户组之间的互斥，以及组恢复结束后的解锁。 */
function twoGroupsSnapshot() {
  return snapshot({
    groups: [
      {
        clientId: "c1",
        clientName: "林小满",
        deletedAt: "2026-11-20T10:00:00+08:00",
        orders: [order({ id: "o1", code: "AF-2026-0001" })],
      },
      {
        clientId: "c2",
        clientName: "陈叙",
        deletedAt: "2026-11-19T10:00:00+08:00",
        orders: [order({ id: "o2", code: "AF-2026-0002" })],
      },
    ],
    looseOrders: [
      order({
        id: "o3",
        code: "AF-2026-0003",
        title: "独立订单",
        originalClientName: "周迟",
        workState: "completed",
      }),
    ],
    groupCount: 2,
    looseOrderCount: 1,
    totalOrderCount: 3,
  });
}

/** 取某个客户组所在的行，避免把对话框里的同名按钮算进来。 */
function groupRow(clientName: string): HTMLElement {
  const toggle = screen.getByTitle(clientName);
  const row = toggle.closest("li");
  if (!(row instanceof HTMLElement)) throw new Error(`找不到客户组 ${clientName} 所在行`);
  return row;
}

async function confirmGroupRestore(user: ReturnType<typeof userEvent.setup>, clientName: string) {
  // 快照是异步读取的：等这一组渲染出来再动手，否则会在"正在读取回收站…"阶段点空。
  await screen.findByTitle(clientName);
  const row = groupRow(clientName);
  await user.click(within(row).getByRole("button", { name: "整批恢复" }));
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "整批恢复" }));
}

describe("客户组恢复的互斥与解锁（O1 补充）", () => {
  it("客户组 A 恢复挂起时，客户组 B 与独立订单的恢复入口都禁用", async () => {
    const user = userEvent.setup();
    arrange(twoGroupsSnapshot());
    const gate = deferred<{ clientId: string; ordersRestored: number; clientsRestored: number }>();
    mocks.restoreClient.mockReturnValueOnce(gate.promise);
    renderPage();

    await confirmGroupRestore(user, "林小满");

    // A 是执行中的那一组：文案换成进行中，并且同样禁用。
    await waitFor(() =>
      expect(within(groupRow("林小满")).getByRole("button", { name: "正在恢复…" })).toBeDisabled(),
    );
    // B 保持原文案，但不可点击——这才是"部分按钮可点、部分被静默忽略"被消除的证据。
    expect(within(groupRow("陈叙")).getByRole("button", { name: "整批恢复" })).toBeDisabled();
    for (const button of screen.getAllByRole("button", { name: "恢复订单" })) {
      expect(button).toBeDisabled();
    }

    gate.resolve({ clientId: "c1", ordersRestored: 1, clientsRestored: 1 });
    expect(await screen.findByText(/已恢复客户「林小满」/)).toBeInTheDocument();
  });

  it("客户组整批恢复成功后，所有恢复入口重新可用", async () => {
    const user = userEvent.setup();
    arrange(twoGroupsSnapshot());
    const gate = deferred<{ clientId: string; ordersRestored: number; clientsRestored: number }>();
    mocks.restoreClient.mockReturnValueOnce(gate.promise);
    renderPage();

    await confirmGroupRestore(user, "林小满");
    await waitFor(() =>
      expect(within(groupRow("陈叙")).getByRole("button", { name: "整批恢复" })).toBeDisabled(),
    );

    gate.resolve({ clientId: "c1", ordersRestored: 1, clientsRestored: 1 });
    await screen.findByText(/已恢复客户「林小满」/);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "正在恢复…" })).toBeNull();
      expect(within(groupRow("林小满")).getByRole("button", { name: "整批恢复" })).toBeEnabled();
      expect(within(groupRow("陈叙")).getByRole("button", { name: "整批恢复" })).toBeEnabled();
      for (const button of screen.getAllByRole("button", { name: "恢复订单" })) {
        expect(button).toBeEnabled();
      }
    });
  });

  it("客户组整批恢复失败后，所有恢复入口重新可用，错误仍然可见", async () => {
    const user = userEvent.setup();
    arrange(twoGroupsSnapshot());
    const gate = deferred<{ clientId: string; ordersRestored: number; clientsRestored: number }>();
    mocks.restoreClient.mockReturnValueOnce(gate.promise);
    renderPage();

    await confirmGroupRestore(user, "林小满");
    await waitFor(() =>
      expect(within(groupRow("陈叙")).getByRole("button", { name: "整批恢复" })).toBeDisabled(),
    );

    gate.reject(new Error("数据完整性检查未通过，操作已中止。"));
    expect(await screen.findByText(/数据完整性检查未通过，操作已中止。/)).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "正在恢复…" })).toBeNull();
      expect(within(groupRow("林小满")).getByRole("button", { name: "整批恢复" })).toBeEnabled();
      expect(within(groupRow("陈叙")).getByRole("button", { name: "整批恢复" })).toBeEnabled();
      for (const button of screen.getAllByRole("button", { name: "恢复订单" })) {
        expect(button).toBeEnabled();
      }
    });
    // 解锁不等于清掉错误：失败原因必须还在界面上。
    expect(screen.getByText(/数据完整性检查未通过，操作已中止。/)).toBeInTheDocument();
  });
});
