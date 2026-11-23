import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DataResetInput, ResetReport } from "../bridge/commands";

const dataReset = vi.fn(async (_input: DataResetInput) => report({}));
const restartApp = vi.fn(async () => {});

function report(over: Partial<ResetReport>): ResetReport {
  return {
    items: [
      { option: "business", status: "ok", reason: null, detail: "已切换到新代际 gen-new" },
      { option: "backups", status: "ok", reason: null, detail: "删除 2 项" },
    ],
    overall: "all_ok",
    newGeneration: "gen-new",
    oldGeneration: "gen-old",
    oldGenerationPath: "/data/generations/gen-old",
    oldGenerationBytes: 1536,
    snapshotPath: "/data/backups/pre-reset-20261124-010203.zip",
    ...over,
  };
}

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    api: { ...actual.api, dataReset, restartApp },
  };
});

async function setup() {
  const { default: DataResetPanel } = await import("./DataResetPanel");
  const onError = vi.fn();
  render(<DataResetPanel onError={onError} />);
  return { onError, panel: within(screen.getByTestId("data-reset")) };
}

beforeEach(() => {
  dataReset.mockClear();
  restartApp.mockClear();
  dataReset.mockImplementation(async () => report({}));
});

describe("数据重置面板", () => {
  it("六项默认不勾选，没选就不能执行", async () => {
    const { panel } = await setup();
    const boxes = panel.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.length).toBe(6);
    for (const box of boxes) expect(box.checked).toBe(false);

    const button = panel.getByRole("button", { name: /请先选择/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("取消确认不会调用命令", async () => {
    const user = userEvent.setup();
    const { panel } = await setup();

    await user.click(panel.getByRole("checkbox", { name: /业务数据包/ }));
    await user.click(panel.getByRole("button", { name: /重置选中的 1 项/ }));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(dataReset).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("确认后按勾选传参，并显示三项结论与逐项结果", async () => {
    const user = userEvent.setup();
    const { panel } = await setup();

    await user.click(panel.getByRole("checkbox", { name: /业务数据包/ }));
    await user.click(panel.getByRole("checkbox", { name: /本地备份文件/ }));
    await user.click(panel.getByRole("button", { name: /重置选中的 2 项/ }));
    await user.click(screen.getByRole("button", { name: "确认重置" }));

    await waitFor(() => expect(dataReset).toHaveBeenCalledTimes(1));
    expect(dataReset.mock.calls[0]![0]).toMatchObject({
      business: true,
      backups: true,
      settings: false,
      logs: false,
      quarantine: false,
      reminder: false,
    });

    const result = await screen.findByTestId("reset-report");
    expect(within(result).getByText("全部成功")).toBeTruthy();
    expect(within(result).getByText("业务数据包")).toBeTruthy();
    expect(within(result).getByText("本地备份文件")).toBeTruthy();
    // 旧代际与占用必须告知
    expect(result.textContent).toContain("/data/generations/gen-old");
    expect(result.textContent).toContain("1.5 KB");
  });

  it("业务数据成功时提示必须重启，并给出重启入口", async () => {
    const user = userEvent.setup();
    const { panel } = await setup();

    await user.click(panel.getByRole("checkbox", { name: /业务数据包/ }));
    await user.click(panel.getByRole("button", { name: /重置选中的 1 项/ }));
    await user.click(screen.getByRole("button", { name: "确认重置" }));

    const restart = await screen.findByRole("button", { name: "重启应用以使用新数据" });
    expect(screen.getByText(/当前窗口仍在读取旧数据/)).toBeTruthy();

    await user.click(restart);
    expect(restartApp).toHaveBeenCalledTimes(1);
  });

  it("部分成功不会被说成成功，失败项可单独重试", async () => {
    dataReset.mockImplementation(async () =>
      report({
        overall: "partial",
        newGeneration: null,
        snapshotPath: null,
        items: [
          { option: "business", status: "ok", reason: null, detail: null },
          {
            option: "backups",
            status: "failed",
            reason: "2 项未能删除：/data/backups/a.zip：Permission denied",
            detail: null,
          },
          { option: "logs", status: "skipped", reason: "已中止", detail: null },
        ],
      }),
    );

    const user = userEvent.setup();
    const { panel } = await setup();
    await user.click(panel.getByRole("checkbox", { name: /本地备份文件/ }));
    await user.click(panel.getByRole("button", { name: /重置选中的 1 项/ }));
    await user.click(screen.getByRole("button", { name: "确认重置" }));

    const result = await screen.findByTestId("reset-report");
    expect(within(result).getByText("部分成功")).toBeTruthy();
    expect(within(result).queryByText("全部成功")).toBeNull();
    expect(result.textContent).toContain("失败");
    expect(result.textContent).toContain("未执行");

    dataReset.mockClear();
    await user.click(within(result).getByRole("button", { name: /仅重试失败的 1 项/ }));
    await waitFor(() => expect(dataReset).toHaveBeenCalledTimes(1));
    expect(dataReset.mock.calls[0]![0].only).toEqual(["backups"]);
    // 重试不能把已经成功的项再执行一遍
    expect(dataReset.mock.calls[0]![0].business).toBe(false);
  });

  it("隔离区带专门的风险提示，并在确认框里再出现一次", async () => {
    const user = userEvent.setup();
    const { panel } = await setup();

    expect(panel.getByText("清理后将失去崩溃恢复的比对线索。")).toBeTruthy();
    await user.click(panel.getByRole("checkbox", { name: /附件隔离区/ }));
    await user.click(panel.getByRole("button", { name: /重置选中的 1 项/ }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("清理后将失去崩溃恢复的比对线索");
  });

  it("全部失败时明确显示失败，而不是部分成功", async () => {
    dataReset.mockImplementation(async () =>
      report({
        overall: "all_failed",
        newGeneration: null,
        snapshotPath: null,
        items: [
          { option: "business", status: "failed", reason: "快照写入失败", detail: null },
          { option: "backups", status: "skipped", reason: "已中止", detail: null },
        ],
      }),
    );

    const user = userEvent.setup();
    const { panel } = await setup();
    await user.click(panel.getByRole("checkbox", { name: /业务数据包/ }));
    await user.click(panel.getByRole("button", { name: /重置选中的 1 项/ }));
    await user.click(screen.getByRole("button", { name: "确认重置" }));

    const result = await screen.findByTestId("reset-report");
    expect(within(result).getByText("全部失败")).toBeTruthy();
    expect(within(result).getByText("快照写入失败")).toBeTruthy();
  });
});
