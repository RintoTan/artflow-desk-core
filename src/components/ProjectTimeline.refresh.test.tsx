import { MemoryRouter, Route, Routes } from "react-router-dom";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OrderView } from "../bridge/commands";
import { ProjectTimeline } from "./ProjectTimeline";

/**
 * DEV-06D-2-AUTO-QA-01 的 U7-B / U7-C / U7-D / U7-E。
 *
 * 这里只测"读取与刷新"这条链路：焦点重取、主动刷新、失败保留旧数据、
 * 首次失败重试、旧请求不覆盖新请求、没有定时轮询。
 * 几何与滚动位置在 scripts/timeline-autoqa.mjs 里用真实浏览器量。
 */

const NOW = "2026-11-18T04:00:00.000Z";

const hoisted = vi.hoisted(() => ({
  listOrders: vi.fn(),
  status: vi.fn(),
}));

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>("../bridge/commands");
  return {
    ...actual,
    api: { ...actual.api, listOrders: hoisted.listOrders, status: hoisted.status },
  };
});

const STATUS = {
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
  orders: 0,
  clients: 0,
  templates: 0,
  attachments: 0,
  pendingCleanup: 0,
  highWater: [],
  integrity: "ok",
};

function order(overrides: Partial<OrderView> = {}): OrderView {
  return {
    id: "id-1",
    code: "AF-2026-0001",
    title: "测试订单",
    clientId: null,
    clientName: "林小满",
    commissionType: null,
    stageTemplateId: "tpl-a",
    source: null,
    amountCents: 88000,
    note: null,
    status: "active",
    workState: "queued",
    currentStageId: "draft",
    currentStageTitle: "草稿",
    currentStageIndex: 0,
    stageCount: 5,
    stages: [],
    queuePosition: 0,
    plannedStartDate: "2026-11-10",
    plannedDeliveryDate: "2026-11-20",
    deadlineState: "dueSoon",
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    revision: 1,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    capabilities: {
      canStartWork: true,
      canUndoStartWork: false,
      undoBlockedReason: null,
      canAdvance: false,
      canRework: false,
      canSkip: false,
      canComplete: false,
      canCancel: true,
      canReopen: false,
      canEditWorkflow: true,
    },
    ...overrides,
  };
}

/**
 * IPC 返回的是新对象（JSON 反序列化）。夹具必须一样，
 * 否则 React 会因引用相同跳过更新，测出假的"状态被保留"。
 */
function ipc<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function renderTimeline() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<ProjectTimeline nowIso={NOW} />} />
        <Route path="/orders" element={<div />} />
      </Routes>
    </MemoryRouter>,
  );
}

function rowTitles(): string[] {
  return [...document.querySelectorAll(".timeline-title")].map((el) => el.textContent ?? "");
}

function listCalls(): number {
  return hoisted.listOrders.mock.calls.length;
}

beforeEach(() => {
  hoisted.listOrders.mockReset();
  hoisted.status.mockReset();
  hoisted.status.mockImplementation(async () => ipc(STATUS));
  hoisted.listOrders.mockImplementation(async () => ipc([order()]));
});

describe("U7-B 焦点重取", () => {
  it("进入工作台读一次，window focus 后重新请求并更新界面", async () => {
    renderTimeline();
    await screen.findByTestId("timeline-frame");
    expect(listCalls()).toBe(1);

    hoisted.listOrders.mockImplementation(async () =>
      ipc([order({ id: "id-2", code: "AF-2026-0002", title: "焦点后新增的订单" })]),
    );
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(listCalls()).toBe(2));
    await waitFor(() => expect(screen.getByText("焦点后新增的订单")).toBeInTheDocument());
    expect(screen.queryByText("测试订单")).not.toBeInTheDocument();
  });

  it("连续两次焦点切换各发一次请求，且不会产生重复订单行", async () => {
    renderTimeline();
    await screen.findByTestId("timeline-frame");

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(listCalls()).toBe(3));

    const ids = [...document.querySelectorAll(".timeline-row")].map((el) =>
      el.getAttribute("data-order-id"),
    );
    expect(ids).toEqual(["id-1"]);
  });

  it("旧请求晚于新请求返回时，不会覆盖新数据", async () => {
    let resolveFirst: (value: OrderView[]) => void = () => {};
    let resolveSecond: (value: OrderView[]) => void = () => {};
    hoisted.listOrders
      .mockImplementationOnce(() => new Promise<OrderView[]>((r) => (resolveFirst = r)))
      .mockImplementationOnce(() => new Promise<OrderView[]>((r) => (resolveSecond = r)));

    renderTimeline();
    // 首次请求还挂着，就触发第二次（焦点事件不等第一次完成）
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(listCalls()).toBe(2);

    // 新请求先回来
    await act(async () => {
      resolveSecond(ipc([order({ id: "id-new", title: "新请求的数据" })]));
    });
    await waitFor(() => expect(screen.getByText("新请求的数据")).toBeInTheDocument());

    // 旧请求后回来，必须被丢弃
    await act(async () => {
      resolveFirst(ipc([order({ id: "id-old", title: "旧请求的过期数据" })]));
    });
    expect(screen.queryByText("旧请求的过期数据")).not.toBeInTheDocument();
    expect(screen.getByText("新请求的数据")).toBeInTheDocument();
  });

  it("不注册定时轮询：推进 10 分钟也不发请求", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderTimeline();
      await screen.findByTestId("timeline-frame");
      expect(listCalls()).toBe(1);
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(listCalls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("U7-C 主动刷新", () => {
  it("「刷新」重新请求订单并更新内容，不重复插入、不重置尺度与终态开关", async () => {
    const user = userEvent.setup();
    renderTimeline();
    await screen.findByTestId("timeline-frame");
    expect(listCalls()).toBe(1);

    await user.click(screen.getByRole("button", { name: "周" }));
    await user.click(screen.getByRole("checkbox", { name: "显示已结束" }));
    expect(screen.getByRole("button", { name: "周" })).toHaveAttribute("aria-pressed", "true");

    hoisted.listOrders.mockImplementation(async () =>
      ipc([
        order({ id: "id-1", title: "刷新后的订单" }),
        order({ id: "id-9", code: "AF-2026-0009", title: "刷新后才出现的一单" }),
      ]),
    );
    await user.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(listCalls()).toBe(2));

    expect(screen.getByRole("button", { name: "周" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("checkbox", { name: "显示已结束" })).toBeChecked();
    expect(rowTitles()).toEqual(["刷新后的订单", "刷新后才出现的一单"]);
    expect(screen.getByText(/时间线 2 单/)).toBeInTheDocument();
    // 没有重复：行数 = 去重后的 id 数
    const ids = [...document.querySelectorAll(".timeline-row")].map((el) =>
      el.getAttribute("data-order-id"),
    );
    expect(ids).toEqual([...new Set(ids)]);
  });

  it("刷新不重新计算日期窗口（尺度不变）", async () => {
    const user = userEvent.setup();
    renderTimeline();
    await screen.findByTestId("timeline-frame");
    const beforeWindow = screen.getByTestId("timeline-range").textContent ?? "";
    await user.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(listCalls()).toBe(2));
    expect(screen.getByTestId("timeline-range").textContent).toBe(beforeWindow);
  });
});

describe("U7-D 刷新失败保留旧数据", () => {
  it("第二次请求失败：保留上次数据、显示刷新失败提示、可重新尝试恢复", async () => {
    const user = userEvent.setup();
    renderTimeline();
    await screen.findByTestId("timeline-frame");
    expect(screen.getByText("测试订单")).toBeInTheDocument();

    hoisted.listOrders.mockImplementation(async () => {
      throw new Error("QA 注入：读取订单失败");
    });
    await user.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/刷新失败/));

    // 旧数据仍在，没有退化成 0 单，也没有示例订单
    expect(screen.getByText("测试订单")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-frame")).toBeInTheDocument();
    expect(screen.queryByText("尚无订单")).not.toBeInTheDocument();
    expect(screen.queryByText("没有任何订单填入计划日期")).not.toBeInTheDocument();
    expect(screen.getByText(/共 1 单/)).toBeInTheDocument();

    // 点「重新尝试」后恢复
    hoisted.listOrders.mockImplementation(async () => ipc([order({ title: "恢复后的订单" })]));
    await user.click(screen.getByRole("button", { name: "重新尝试" }));
    await waitFor(() => expect(screen.getByText("恢复后的订单")).toBeInTheDocument());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("刷新失败不会把时间线换成错误面板（区分首次失败与刷新失败）", async () => {
    const user = userEvent.setup();
    renderTimeline();
    await screen.findByTestId("timeline-frame");

    hoisted.listOrders.mockImplementation(async () => {
      throw new Error("QA 注入");
    });
    await user.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    expect(screen.queryByText("无法读取时间线")).not.toBeInTheDocument();
  });
});

describe("U7-E 首次加载失败与重试", () => {
  it("首次失败显示独立错误面板与重试入口，不出现任何订单或空状态", async () => {
    hoisted.listOrders.mockImplementationOnce(async () => {
      throw new Error("QA 注入：首次读取失败");
    });
    renderTimeline();

    await screen.findByText("无法读取时间线");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.queryByText("尚无订单")).not.toBeInTheDocument();
    expect(screen.queryByText("没有任何订单填入计划日期")).not.toBeInTheDocument();
    expect(screen.queryByText("活动订单已全部结束")).not.toBeInTheDocument();
    expect(document.querySelector(".timeline-row")).toBeNull();
  });

  it("点重试后正常加载，且不产生重复请求", async () => {
    const user = userEvent.setup();
    hoisted.listOrders.mockImplementationOnce(async () => {
      throw new Error("QA 注入：首次读取失败");
    });
    renderTimeline();
    await screen.findByText("无法读取时间线");
    expect(listCalls()).toBe(1);

    await user.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByTestId("timeline-frame");
    expect(listCalls()).toBe(2);
    expect(screen.getByText("测试订单")).toBeInTheDocument();
    expect([...document.querySelectorAll(".timeline-row")]).toHaveLength(1);
  });

  it("工作时区读取失败同样进入错误面板，不静默用错误时区绘图", async () => {
    hoisted.status.mockImplementationOnce(async () => {
      throw new Error("QA 注入：时区读取失败");
    });
    renderTimeline();
    await screen.findByText("无法读取时间线");
    expect(screen.queryByTestId("timeline-frame")).not.toBeInTheDocument();
  });
});
