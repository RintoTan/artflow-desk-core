import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MigratePreview, MigrateReport, StorageStatus } from "../bridge/commands";

const status: StorageStatus = {
  root: "/Users/me/Library/Application Support/dev.artflow.minidesk",
  defaultRoot: "/Users/me/Library/Application Support/dev.artflow.minidesk",
  pointerPath: "/Users/me/Library/Application Support/dev.artflow.minidesk/root.json",
  custom: false,
};

const preview: MigratePreview = {
  sourceRoot: status.root,
  targetRoot: "/Volumes/Art/work",
  files: 812,
  bytes: 48 * 1024 * 1024,
  generations: ["gen-a", "gen-b"],
  hasBackups: true,
  hasQuarantineEvidence: true,
  availableBytes: 200 * 1024 * 1024,
  requiredBytes: 60 * 1024 * 1024,
  fits: true,
};

const report: MigrateReport = {
  sourceRoot: status.root,
  targetRoot: "/Volumes/Art/work",
  files: 812,
  bytes: 48 * 1024 * 1024,
  generations: ["gen-a", "gen-b"],
  copiedFiles: 812,
  verifiedFiles: 812,
  snapshotPath: "/old/backups/pre-migrate-20261124-020000.zip",
  switched: true,
};

const storageStatus = vi.fn(async () => status);
const storagePreview = vi.fn(async (_target: string) => preview);
const storageMigrate = vi.fn(async (_target: string) => report);
const storageUseDefault = vi.fn(async () => {});
const restartApp = vi.fn(async () => {});
const openDialog = vi.fn(async () => "/Volumes/Art/work" as string | null);

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialog }));

vi.mock("../bridge/commands", async () => {
  const actual = await importActual();
  return {
    ...actual,
    api: { ...actual.api, storageStatus, storagePreview, storageMigrate, storageUseDefault, restartApp },
  };
});

async function importActual() {
  return await vi.importActual<typeof import("../bridge/commands")>("../bridge/commands");
}

async function setup() {
  const { default: StorageLocationPanel } = await import("./StorageLocationPanel");
  const onError = vi.fn();
  render(<StorageLocationPanel onError={onError} />);
  return { onError, panel: within(screen.getByTestId("storage-location")) };
}

beforeEach(() => {
  storageStatus.mockClear();
  storagePreview.mockClear();
  storageMigrate.mockClear();
  storageUseDefault.mockClear();
  restartApp.mockClear();
  openDialog.mockClear();
  storageStatus.mockImplementation(async () => status);
  storagePreview.mockImplementation(async () => preview);
  storageMigrate.mockImplementation(async () => report);
  openDialog.mockImplementation(async () => "/Volumes/Art/work");
});

describe("数据存储位置", () => {
  it("显示当前位置并标出这是默认位置", async () => {
    const { panel } = await setup();
    await waitFor(() =>
      expect(panel.getAllByText(status.root, { exact: false }).length).toBeGreaterThan(0),
    );
    expect(panel.getByText("默认位置 · 使用中")).toBeTruthy();
    // 默认位置时不该出现「切回默认」
    expect(panel.queryByRole("button", { name: "切回默认位置" })).toBeNull();
  });

  it("选择目录后先给预览，列出全部代际与空间要求", async () => {
    const user = userEvent.setup();
    const { panel } = await setup();
    await waitFor(() => expect(storageStatus).toHaveBeenCalled());

    await user.click(panel.getByRole("button", { name: /选择新位置/ }));
    const previewBox = await screen.findByTestId("storage-preview");
    expect(storagePreview).toHaveBeenCalledWith("/Volumes/Art/work");
    expect(previewBox.textContent).toContain("812");
    expect(previewBox.textContent).toContain("2 个");
    expect(previewBox.textContent).toContain("1.2 倍");
  });

  it("空间不足时不允许迁移", async () => {
    storagePreview.mockImplementation(async () => ({ ...preview, fits: false, availableBytes: 1 }));
    const user = userEvent.setup();
    const { panel } = await setup();
    await waitFor(() => expect(storageStatus).toHaveBeenCalled());

    await user.click(panel.getByRole("button", { name: /选择新位置/ }));
    const box = await screen.findByTestId("storage-preview");
    expect(box.textContent).toContain("空间不足");
    expect(
      (within(box).getByRole("button", { name: "迁移到此处" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("确认后执行迁移，报告里给出校验数量并要求重启", async () => {
    const user = userEvent.setup();
    const { panel } = await setup();
    await waitFor(() => expect(storageStatus).toHaveBeenCalled());

    await user.click(panel.getByRole("button", { name: /选择新位置/ }));
    await user.click(await screen.findByRole("button", { name: "迁移到此处" }));
    await user.click(screen.getByRole("button", { name: "开始迁移" }));

    await waitFor(() => expect(storageMigrate).toHaveBeenCalledWith("/Volumes/Art/work"));
    const result = await screen.findByTestId("storage-report");
    expect(result.textContent).toContain("812");
    expect(result.textContent).toContain("/Volumes/Art/work");
    expect(result.textContent).toContain("不会自动删除");

    await user.click(within(result).getByRole("button", { name: "重启应用以使用新位置" }));
    expect(restartApp).toHaveBeenCalledTimes(1);
  });

  it("迁移失败时保留对话框并显示原因，不出现成功报告", async () => {
    storageMigrate.mockImplementation(async () => {
      throw new Error("目标位置空间不足");
    });
    const user = userEvent.setup();
    const { onError, panel } = await setup();
    await waitFor(() => expect(storageStatus).toHaveBeenCalled());

    await user.click(panel.getByRole("button", { name: /选择新位置/ }));
    await user.click(await screen.findByRole("button", { name: "迁移到此处" }));
    await user.click(screen.getByRole("button", { name: "开始迁移" }));

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(screen.queryByTestId("storage-report")).toBeNull();
    expect(screen.getByRole("alertdialog").textContent).toContain("空间不足");
  });

  it("自定义位置下切回默认要先警告数据可能不是最新", async () => {
    storageStatus.mockImplementation(async () => ({ ...status, custom: true, root: "/Volumes/Art/work" }));
    const user = userEvent.setup();
    const { panel } = await setup();
    await waitFor(() => expect(panel.getByText("自定义位置 · 使用中")).toBeTruthy());

    await user.click(panel.getByRole("button", { name: "切回默认位置" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("不会自动合并");

    await user.click(within(dialog).getByRole("button", { name: "切回默认位置" }));
    await waitFor(() => expect(storageUseDefault).toHaveBeenCalledTimes(1));
  });
});
