import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BackupPreview, BackupStatus } from "../bridge/commands";

const calls: Array<{ kind: string; arg?: unknown }> = [];
let status: BackupStatus;
let preview: BackupPreview;
let inspectError: Error | null = null;
let restoreError: Error | null = null;
let restoreWarnings: string[] | undefined;
let dialogSave: string | null = "/tmp/out.zip";
let dialogOpen: string | null = "/tmp/in.zip";

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    api: {
      ...actual.api,
      backupStatus: async () => status,
      backupCreate: async (targetPath?: string | null) => {
        calls.push({ kind: "create", arg: targetPath });
        return {
          path: targetPath ?? "/tmp/out.zip",
          bytes: 2048,
          files: 4,
          attachmentFiles: 2,
          databaseBytes: 1024,
          schemaVersion: 7,
          summary: status && {
            orders: 3,
            activeOrders: 2,
            clients: 1,
            templates: 1,
            events: 9,
            attachments: 2,
            stageSkips: 1,
            reschedules: 0,
          },
          createdAt: "2026-11-20T01:00:00+08:00",
        };
      },
      backupInspect: async (path: string) => {
        calls.push({ kind: "inspect", arg: path });
        if (inspectError) throw inspectError;
        return preview;
      },
      backupRestore: async (path: string) => {
        calls.push({ kind: "restore", arg: path });
        if (restoreError) throw restoreError;
        return {
          newGeneration: "gen-new",
          previousGeneration: "gen-old",
          migratedFrom: 7,
          schemaVersion: 7,
          summary: preview.summary,
          raisedWatermarks: [{ year: 2026, lastAllocated: 12 }],
          missingThumbs: 0,
          cleanupTasksRetargeted: 0,
          staleJobsClosed: 0,
          preRestoreBackup: "/tmp/pre-restore.zip",
          warnings: restoreWarnings,
        };
      },
      backupSetReminder: async (days: number) => {
        calls.push({ kind: "reminder", arg: days });
        status = { ...status, reminderDays: days, reminderDue: days > 0 && status.daysSinceLast === null };
        return status;
      },
      restartApp: async () => {
        calls.push({ kind: "restart" });
      },
    },
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: async () => dialogSave,
  open: async () => dialogOpen,
}));

const { default: BackupPanel } = await import("./BackupPanel");

beforeEach(() => {
  calls.length = 0;
  inspectError = null;
  restoreError = null;
  restoreWarnings = undefined;
  dialogSave = "/tmp/out.zip";
  dialogOpen = "/tmp/in.zip";
  status = {
    schemaVersion: 7,
    formatVersion: 1,
    appVersion: "0.1.0",
    generation: "gen-abc123",
    root: "/tmp/data",
    workingTimezone: "Asia/Shanghai",
    lastSuccessAt: null,
    lastPath: null,
    reminderDays: 0,
    reminderDue: false,
    daysSinceLast: null,
    lastError: null,
    orders: 3,
    attachments: 2,
    databaseBytes: 1024,
    reachable: true,
  };
  preview = {
    path: "/tmp/in.zip",
    formatVersion: 1,
    appVersion: "0.1.0",
    schemaVersion: 7,
    createdAt: "2026-11-19T10:00:00+08:00",
    workingTimezone: "Asia/Shanghai",
    sourceGenerationId: null,
    files: 5,
    attachmentFiles: 2,
    bytes: 4096,
    schemaRelation: "current",
    summary: {
      orders: 3,
      activeOrders: 2,
      clients: 1,
      templates: 1,
      events: 9,
      attachments: 2,
      stageSkips: 1,
      reschedules: 0,
    },
    canRestore: true,
    blockReason: null,
  };
});

function renderPanel() {
  const onError = vi.fn();
  render(<BackupPanel onError={onError} />);
  return onError;
}

describe("数据备份面板", () => {
  it("显示上次备份、结构版本、代际与数据量；从未备份时明确说明", async () => {
    renderPanel();
    expect(await screen.findByText("数据备份")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("从未备份")).toBeTruthy());
    expect(screen.getByText("v7 / v1")).toBeTruthy();
    expect(screen.getByText("gen-abc123")).toBeTruthy();
    expect(screen.getByText(/订单 3 · 附件 2/)).toBeTruthy();
  });

  it("导出成功后给出路径与体积，并刷新状态", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(screen.getByText("从未备份")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: "导出备份…" }));

    await waitFor(() => expect(calls.some((c) => c.kind === "create")).toBe(true));
    expect(calls.find((c) => c.kind === "create")?.arg).toBe("/tmp/out.zip");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("/tmp/out.zip"),
    );
  });

  it("用户在保存对话框取消时不调用后端", async () => {
    dialogSave = null;
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(screen.getByText("从未备份")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "导出备份…" }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(calls.some((c) => c.kind === "create")).toBe(false);
  });

  it("恢复前先给出摘要与兼容性，取消后不写入", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(screen.getByText("从未备份")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: "从备份恢复…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/in\.zip/)).toBeTruthy();
    expect(within(dialog).getByText(/结构版本与应用一致/)).toBeTruthy();
    expect(within(dialog).getByText(/跳级 1 条/)).toBeTruthy();
    expect(within(dialog).getByText(/工作时区：Asia\/Shanghai/)).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(calls.some((c) => c.kind === "restore")).toBe(false);
  });

  it("结构版本较新时禁用确认按钮并说明原因", async () => {
    preview = {
      ...preview,
      schemaVersion: 99,
      schemaRelation: "newer",
      canRestore: false,
      blockReason: "备份的结构版本 v99 高于本程序支持的 v7，请先升级应用",
    };
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(screen.getByText("从未备份")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "从备份恢复…" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("button", { name: "确认恢复" })).toBeDisabled();
    expect(within(dialog).getByText(/高于本程序支持/)).toBeTruthy();
  });

  it("确认恢复后展示结果并要求重启", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(screen.getByText("从未备份")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "从备份恢复…" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "确认恢复" }),
    );

    const done = await screen.findByRole("alertdialog");
    expect(within(done).getByText(/已恢复 3 笔订单/)).toBeTruthy();
    expect(within(done).getByText(/pre-restore\.zip/)).toBeTruthy();

    await user.click(within(done).getByRole("button", { name: "立即重启" }));
    await waitFor(() => expect(calls.some((c) => c.kind === "restart")).toBe(true));
  });

  it("恢复失败时把错误交给上层，且不显示成功", async () => {
    restoreError = new Error("备份包缺少 1 个原图");
    const user = userEvent.setup();
    const onError = renderPanel();
    await waitFor(() => expect(screen.getByText("从未备份")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "从备份恢复…" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "确认恢复" }),
    );

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(screen.queryByText(/已恢复/)).toBeNull();
  });

  it("校验失败的备份不会进入确认框", async () => {
    inspectError = new Error("SHA-256 不匹配：database.sqlite");
    const user = userEvent.setup();
    const onError = renderPanel();
    await waitFor(() => expect(screen.getByText("从未备份")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "从备份恢复…" }));

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("提醒周期可切换，并显示到期提示", async () => {
    const user = userEvent.setup();
    renderPanel();
    const select = await waitFor(() => screen.getByLabelText("备份提醒"));
    await user.selectOptions(select, "7");

    await waitFor(() =>
      expect(calls.find((c) => c.kind === "reminder")?.arg).toBe(7),
    );
    expect(await screen.findByText(/天没有备份，建议现在导出一份/)).toBeTruthy();
  });

  it("关闭提醒后不再提示", async () => {
    status = { ...status, reminderDays: 7, reminderDue: true, daysSinceLast: 20 };
    const user = userEvent.setup();
    renderPanel();
    expect(await screen.findByText(/天没有备份/)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("备份提醒"), "0");
    await waitFor(() => expect(screen.queryByText(/天没有备份/)).toBeNull());
  });
  it("恢复预览展示财务四项数量，且不出现金额或客户信息", async () => {
    preview = {
      ...preview,
      summary: {
        ...preview.summary,
        paymentPlatforms: 4,
        paymentSchedules: 12,
        paymentRecords: 18,
        refundRecords: 3,
      },
    };
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(screen.getByText("从未备份")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "从备份恢复…" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/收款平台 4 个 · 付款计划 12 项 · 收款流水 18 笔 · 退款记录 3 笔/),
    ).toBeTruthy();
    // 摘要是数量清单：不出现金额符号，也不出现客户相关的字眼。
    expect(within(dialog).queryByText(/[¥￥]/)).toBeNull();
    expect(within(dialog).queryByText(/客户名|联系方式/)).toBeNull();
  });

  it("旧后端不带财务字段时整行不显示，不画一排 0", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(screen.getByText("从未备份")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "从备份恢复…" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).queryByText(/收款平台/)).toBeNull();
  });

  it("恢复预览原样展示平台回填与退款表兼容提示", async () => {
    preview = {
      ...preview,
      schemaVersion: 9,
      schemaRelation: "older",
      warnings: [
        "该备份早于收款平台配置功能（包内没有平台表）。恢复后将保留当前设备的 3 个平台配置：ID、名称、费率、归档状态、排序与创建时间原样，更新时间记为恢复时刻。",
        "该备份早于财务模块（包内没有付款计划、收款流水与退款记录）。升级后这三张表为空，不会为旧订单生成任何记录。",
      ],
    };
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(screen.getByText("从未备份")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "从备份恢复…" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/保留当前设备的 3 个平台配置/)).toBeTruthy();
    expect(within(dialog).getByText(/不会为旧订单生成任何记录/)).toBeTruthy();
  });

  it("恢复结果同时报财务数量与兼容提示", async () => {
    preview = {
      ...preview,
      summary: {
        ...preview.summary,
        paymentPlatforms: 3,
        paymentSchedules: 0,
        paymentRecords: 0,
        refundRecords: 0,
      },
    };
    restoreWarnings = [
      "该备份不含收款平台配置，已保留当前设备的 3 个平台：ID、名称、费率、归档状态、排序与创建时间原样，更新时间记为本次恢复时刻。",
    ];
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(screen.getByText("从未备份")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "从备份恢复…" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "确认恢复" }),
    );

    const done = await screen.findByRole("alertdialog");
    expect(
      within(done).getByText(/收款平台 3 个 · 付款计划 0 项 · 收款流水 0 笔 · 退款记录 0 笔/),
    ).toBeTruthy();
    expect(within(done).getByText(/已保留当前设备的 3 个平台/)).toBeTruthy();
  });
});
