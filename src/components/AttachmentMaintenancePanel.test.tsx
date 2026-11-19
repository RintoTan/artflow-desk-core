import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JobsReport, QuarantineReport } from "../bridge/commands";

const calls: Array<{ kind: string; arg?: unknown }> = [];
let quarantine: QuarantineReport;
let jobs: JobsReport;

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    api: {
      ...actual.api,
      maintenanceQuarantine: async () => quarantine,
      maintenanceQuarantineClear: async (names: string[]) => {
        calls.push({ kind: "clear-quarantine", arg: names });
        return { removed: names.length, skippedReferenced: 0, skippedUnsafe: 0, bytesFreed: 120, errors: [] };
      },
      maintenanceJobs: async () => jobs,
      maintenanceJobsPrune: async (input: unknown) => {
        calls.push({ kind: "prune", arg: input });
        return { cutoff: "2026-08-22T00:00:00Z", matched: 3, removed: 3, keptPending: 1, keptRecent: 2 };
      },
    },
  };
});

const { default: Panel } = await import("./AttachmentMaintenancePanel");

beforeEach(() => {
  calls.length = 0;
  quarantine = {
    generation: "gen-test",
    dir: "/tmp/q",
    items: [
      { name: "kept.png", bytes: 10, modifiedAt: "1", referenced: true },
      { name: "orphan-a.png", bytes: 60, modifiedAt: "2", referenced: false },
      { name: "orphan-b.png", bytes: 60, modifiedAt: "3", referenced: false },
    ],
    totalBytes: 130,
    referencedCount: 1,
    removableCount: 2,
    removableBytes: 120,
  };
  jobs = {
    counts: { pending: 1, running: 0, done: 7, failed: 2, total: 10 },
    prunable: 3,
    oldestDoneAt: "2026-01-02T00:00:00Z",
  };
});

describe("附件维护面板", () => {
  it("把仍被引用的隔离文件标出来，并且只把无引用的算成可清理", async () => {
    render(<Panel onError={vi.fn()} />);
    expect(await screen.findByText("隔离文件（quarantine）")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("kept.png")).toBeTruthy());
    expect(screen.getByText(/3 个文件 · 130 B/)).toBeTruthy();
    expect(screen.getByText("1 个（清理时会跳过）")).toBeTruthy();
    expect(screen.getByText(/2 个 · 120 B/)).toBeTruthy();
  });

  it("清理前必须二次确认，取消不删除", async () => {
    const user = userEvent.setup();
    render(<Panel onError={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("kept.png")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: /清理可清理的 2 个文件/ }));
    const dialog = await screen.findByRole("alertdialog", { name: "确认清理隔离文件" });
    expect(within(dialog).getByText(/删除后不可恢复/)).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("确认后只提交无引用的文件名", async () => {
    const user = userEvent.setup();
    render(<Panel onError={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("kept.png")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: /清理可清理的 2 个文件/ }));
    const dialog = await screen.findByRole("alertdialog", { name: "确认清理隔离文件" });
    await user.click(within(dialog).getByRole("button", { name: "确认删除" }));

    await waitFor(() => expect(calls.some((c) => c.kind === "clear-quarantine")).toBe(true));
    expect(calls[0]!.arg).toEqual(["orphan-a.png", "orphan-b.png"]);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("已清理 2 个文件"));
  });

  it("没有可清理文件时按钮禁用，并说明原因", async () => {
    quarantine = { ...quarantine, items: [quarantine.items[0]!], referencedCount: 1, removableCount: 0, removableBytes: 0 };
    render(<Panel onError={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("kept.png")).toBeTruthy());
    expect(screen.getByRole("button", { name: /清理可清理的 0 个文件/ })).toBeDisabled();
  });

  it("作业记录显示状态分布，并强调 pending 不参与清理", async () => {
    render(<Panel onError={vi.fn()} />);
    expect(await screen.findByText(/待处理 1 · 完成 7 · 失败 2/)).toBeTruthy();
    expect(screen.getByText(/待处理记录是崩溃恢复的唯一线索，永不清理/)).toBeTruthy();
  });

  it("清理作业记录需要确认，并按所选天数提交", async () => {
    const user = userEvent.setup();
    render(<Panel onError={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/待处理 1 · 完成 7/)).toBeTruthy());

    await user.selectOptions(screen.getByLabelText("清理早于"), "180");
    await user.click(screen.getByRole("button", { name: "清理历史记录…" }));
    const dialog = await screen.findByRole("alertdialog", { name: "确认清理作业记录" });
    expect(within(dialog).getByText(/早于 180 天/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "确认清理" }));

    await waitFor(() => expect(calls.some((c) => c.kind === "prune")).toBe(true));
    expect(calls[0]!.arg).toEqual({ olderThanDays: 180, dryRun: false });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("已清理 3 条"));
  });

  it("读取失败时只在本模块提示，不占用页面级错误区", async () => {
    const onError = vi.fn();
    vi.spyOn(
      await import("../bridge/commands").then((m) => m.api),
      "maintenanceQuarantine",
    ).mockRejectedValueOnce(new Error("读取失败"));
    render(<Panel onError={onError} />);
    await waitFor(() => expect(screen.getAllByText(/读取失败/).length).toBeGreaterThan(0));
    expect(onError).not.toHaveBeenCalled();
  });
});
