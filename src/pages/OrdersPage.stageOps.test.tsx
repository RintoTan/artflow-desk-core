import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OrderView } from "../bridge/commands";

function stages(titles: string[], current: number) {
  return titles.map((title, i) => ({
    id: `s-${title}`,
    title,
    position: i,
    isCurrent: i === current,
  }));
}

/** 三阶段、已开工、停在第二阶段的正常活动订单。 */
function orderAt(index: number, patch: Partial<OrderView> = {}): OrderView {
  const titles = ["草稿", "线稿", "上色"];
  return {
    id: "o1",
    code: "AF-2026-0001",
    title: "双人插画",
    clientId: "c1",
    clientName: "林小满",
    commissionType: null,
    stageTemplateId: "tpl-a",
    source: "米画师",
    amountCents: 88000,
    note: null,
    status: "active",
    workState: "inProgress",
    currentStageId: `s-${titles[index] ?? titles[0]}`,
    currentStageTitle: titles[index] ?? titles[0] ?? "",
    currentStageIndex: index,
    stageCount: titles.length,
    stages: stages(titles, index),
    queuePosition: 0,
    plannedStartDate: null,
    plannedDeliveryDate: "2026-11-20",
    deadlineState: "scheduled",
    startedAt: "2026-11-01T00:00:00Z",
    completedAt: null,
    cancelledAt: null,
    revision: 1,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    capabilities: {
      canStartWork: false,
      canUndoStartWork: false,
      undoBlockedReason: null,
      canAdvance: index < titles.length - 1,
      canRework: index > 0,
      canComplete: false,
      canCancel: true,
      canReopen: false,
      canEditWorkflow: true,
    },
    ...patch,
  };
}

let current: OrderView;
const calls: Array<{ kind: string; input: unknown }> = [];

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    preferenceApi: {
      get: async () => null,
      set: async (_key: string, value: string) => value,
    },
    api: {
      ...actual.api,
      listOrders: async () => [current],
      listClients: async () => [],
      listOrderEvents: async () => [],
      getOrder: async () => current,
      advanceStage: async (input: unknown) => {
        calls.push({ kind: "advance", input });
        return current;
      },
      reworkStage: async (input: unknown) => {
        calls.push({ kind: "rework", input });
        return current;
      },
      cancelOrder: async (input: unknown) => {
        calls.push({ kind: "cancel", input });
        return current;
      },
      status: async () => ({
        appVersion: "0.1.0",
        firstRun: false,
        generation: "gen-test",
        schemaVersion: 5,
        upgradedFrom: null,
        rootPath: "/tmp/test",
        sqliteVersion: "3.54.1",
        journalMode: "wal",
        workingTimezone: "Asia/Shanghai",
        systemTimezone: "Asia/Shanghai",
        lockHeld: true,
        qaScenario: null,
      }),
    },
    templateApi: { ...actual.templateApi, list: async () => [] },
    queueApi: { ...actual.queueApi, list: async () => ({ revision: 0, items: [] }) },
  };
});

const { default: OrdersPage } = await import("./OrdersPage");

function renderPage() {
  const router = createMemoryRouter([{ path: "/orders", element: <OrdersPage /> }], {
    initialEntries: ["/orders"],
  });
  return render(<RouterProvider router={router} />);
}

async function openStagePanel(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(screen.getAllByText("双人插画").length).toBeGreaterThan(0));
  await user.click(screen.getByRole("button", { name: "推进阶段…" }));
  const dialog = await screen.findByRole("alertdialog");
  return dialog;
}

beforeEach(() => {
  calls.length = 0;
  current = orderAt(1);
});

describe("订单详情的阶段操作入口", () => {
  it("制作进度只有一个主入口，不再并列「调整阶段…」与「返工一步」", async () => {
    renderPage();
    await waitFor(() => expect(screen.getAllByText("双人插画").length).toBeGreaterThan(0));
    expect(screen.getAllByRole("button", { name: "推进阶段…" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /调整阶段/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /返工一步/ })).toBeNull();
  });

  it("默认选中下一阶段，确认后只调用一次推进", async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openStagePanel(user);

    const next = within(dialog).getByRole("radio", { name: /推进到「上色」/ });
    expect(next).toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "确认推进" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.kind).toBe("advance");
    expect(calls[0]?.input).toMatchObject({ orderId: "o1", expectedRevision: 1 });
  });

  it("返工仍在同一面板里可选，确认后走返工命令并带目标阶段", async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openStagePanel(user);

    await user.click(within(dialog).getByRole("radio", { name: /退回「草稿」/ }));
    await user.click(within(dialog).getByRole("button", { name: "确认返工" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.kind).toBe("rework");
    expect(calls[0]?.input).toMatchObject({ orderId: "o1", targetStageId: "s-草稿" });
  });

  it("取消关闭面板时不产生任何写入", async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openStagePanel(user);
    await user.click(within(dialog).getByRole("radio", { name: /退回「草稿」/ }));
    await user.click(within(dialog).getByRole("button", { name: "取消" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("最后一个阶段仍能打开面板返工，不把入口一起禁用", async () => {
    current = orderAt(2);
    const user = userEvent.setup();
    renderPage();
    const entry = await waitFor(() => screen.getByRole("button", { name: "推进阶段…" }));
    expect(entry).toBeEnabled();

    await user.click(entry);
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).queryByRole("radio", { name: /推进到/ })).toBeNull();
    expect(within(dialog).getByText(/已在最后一个阶段/)).toBeTruthy();
    expect(within(dialog).getByRole("radio", { name: /退回「草稿」/ })).toBeTruthy();
  });

  it("未开工的订单禁用入口并说明原因", async () => {
    current = orderAt(0, {
      workState: "queued",
      startedAt: null,
      capabilities: { ...orderAt(0).capabilities, canAdvance: false, canRework: false },
    });
    renderPage();
    const entry = await waitFor(() => screen.getByRole("button", { name: "推进阶段…" }));
    expect(entry).toBeDisabled();
    expect(entry).toHaveAttribute("title", "订单尚未开工，不能推进或返工");
  });

  it("终态订单禁用入口并说明原因", async () => {
    current = orderAt(2, {
      status: "complete",
      workState: "completed",
      completedAt: "2026-11-10T00:00:00Z",
      capabilities: {
        ...orderAt(2).capabilities,
        canAdvance: false,
        canRework: false,
        canCancel: false,
        canReopen: true,
      },
    });
    renderPage();
    const entry = await waitFor(() => screen.getByRole("button", { name: "推进阶段…" }));
    expect(entry).toBeDisabled();
    expect(entry).toHaveAttribute("title", "已完成或已取消的订单不能推进或返工");
  });

  it("取消订单走独立确认框：保留订单不写任何数据", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getAllByText("双人插画").length).toBeGreaterThan(0));

    await user.click(screen.getByRole("button", { name: "取消订单…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("取消这张订单？")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "确认取消订单" })).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "保留订单" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("确认取消订单只调用一次取消命令", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getAllByText("双人插画").length).toBeGreaterThan(0));

    await user.click(screen.getByRole("button", { name: "取消订单…" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "确认取消订单" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.kind).toBe("cancel");
    expect(calls[0]?.input).toMatchObject({ orderId: "o1", expectedRevision: 1 });
  });

  it("超长阶段名不把确认按钮挤出对话框", async () => {
    const long = "封面主视觉重绘与全彩上色第二版修订稿第三轮细化与背景补画";
    current = orderAt(0, {
      stages: [
        { id: "s-草稿", title: "草稿", position: 0, isCurrent: true },
        { id: "s-long", title: long, position: 1, isCurrent: false },
      ],
      stageCount: 2,
      currentStageId: "s-草稿",
      currentStageTitle: "草稿",
      currentStageIndex: 0,
    });
    const user = userEvent.setup();
    renderPage();
    const dialog = await openStagePanel(user);
    expect(within(dialog).getByText(`推进到「${long}」`)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "确认推进" })).toBeVisible();
  });
});
