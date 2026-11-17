import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EnvironmentStatus } from "./bridge/commands";
import { popModal, pushModal, resetModalStack } from "./lib/modalStack";
import {
  dirtyGuards,
  registerUnsavedGuard,
  resetUnsavedGuards,
} from "./lib/unsavedRegistry";

type CloseEvent = { preventDefault: () => void };

const destroy = vi.fn(async () => {});
const invoke = vi.fn(async () => undefined);
let closeHandler: ((event: CloseEvent) => void) | null = null;
let exitHandler: (() => void) | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: (...args: unknown[]) => invoke(...(args as [])),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    destroy,
    onCloseRequested: async (handler: (event: CloseEvent) => void) => {
      closeHandler = handler;
      return () => {
        closeHandler = null;
      };
    },
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_name: string, handler: () => void) => {
    exitHandler = handler;
    return () => {
      exitHandler = null;
    };
  },
}));

vi.mock("./bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("./bridge/commands")>("./bridge/commands");
  return {
    ...actual,
    api: {
      status: async () => ({ qaMode: false } as unknown as EnvironmentStatus),
    },
  };
});

async function renderShell() {
  const { default: App } = await import("./App");
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <App />,
        children: [{ index: true, element: <p>页面内容</p> }],
      },
    ],
    { initialEntries: ["/"] },
  );
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(closeHandler).not.toBeNull());
}

function guard(overrides: Partial<Parameters<typeof registerUnsavedGuard>[0]> = {}) {
  const save = vi.fn(async () => null as string | null);
  const discard = vi.fn();
  registerUnsavedGuard({
    id: "test-guard",
    label: "测试表单",
    isDirty: () => true,
    save,
    discard,
    ...overrides,
  });
  return { save, discard };
}

async function fireClose() {
  const preventDefault = vi.fn();
  await act(async () => {
    closeHandler?.({ preventDefault });
  });
  return preventDefault;
}

describe("窗口关闭保护", () => {
  beforeEach(() => {
    destroy.mockClear();
    invoke.mockClear();
    closeHandler = null;
    exitHandler = null;
    resetUnsavedGuards();
    resetModalStack();
  });

  afterEach(() => {
    resetUnsavedGuards();
    resetModalStack();
  });

  it("没有草稿时直接关闭，不弹任何框", async () => {
    guard({ isDirty: () => false });
    await renderShell();
    const preventDefault = await fireClose();

    expect(preventDefault).toHaveBeenCalled();
    await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("有草稿时拦下关闭并给出三个选项", async () => {
    const { save } = guard();
    await renderShell();
    await fireClose();

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("关闭窗口前有未保存的修改");
    expect(screen.getByRole("button", { name: "保存并关闭" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "放弃修改并关闭" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消，继续编辑" })).toBeInTheDocument();
    expect(destroy).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("保存成功后关闭，destroy 只在保存完成之后调用", async () => {
    const order: string[] = [];
    const save = vi.fn(async () => {
      order.push("save");
      return null;
    });
    destroy.mockImplementation(async () => {
      order.push("destroy");
    });
    guard({ save });

    await renderShell();
    await fireClose();
    await userEvent.click(await screen.findByRole("button", { name: "保存并关闭" }));

    await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["save", "destroy"]);
  });

  it("保存失败时窗口不关闭，错误显示在框内，输入保留", async () => {
    const save = vi.fn(async () => "数据库被占用，请稍后再试");
    guard({ save });

    await renderShell();
    await fireClose();
    await userEvent.click(await screen.findByRole("button", { name: "保存并关闭" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(destroy).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent("数据库被占用");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("放弃修改：先确认再关闭，不调用保存", async () => {
    const { save, discard } = guard();
    await renderShell();
    await fireClose();
    await userEvent.click(await screen.findByRole("button", { name: "放弃修改并关闭" }));

    await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
    expect(save).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it("取消后回到编辑，窗口保持打开", async () => {
    const { save, discard } = guard();
    await renderShell();
    await fireClose();
    await userEvent.click(await screen.findByRole("button", { name: "取消，继续编辑" }));

    expect(await screen.findByText("页面内容")).toBeInTheDocument();
    expect(destroy).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });

  it("连续点击关闭只处理一次，不重复保存", async () => {
    const { save } = guard();
    await renderShell();
    await fireClose();
    await fireClose();
    await fireClose();

    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "保存并关闭" }));
    await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("已有其它模态时先排队，不叠出第二个保护框", async () => {
    guard();
    await renderShell();
    pushModal("another-modal");

    await fireClose();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    await act(async () => {
      popModal("another-modal");
    });
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
  });

  it("Cmd+Q 走退出链路：确认后调用 confirm_close", async () => {
    guard();
    await renderShell();
    await waitFor(() => expect(exitHandler).not.toBeNull());

    await act(async () => {
      exitHandler?.();
    });
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("退出前有未保存的修改");

    await userEvent.click(screen.getByRole("button", { name: "保存并关闭" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("confirm_close"));
    expect(destroy).not.toHaveBeenCalled();
  });

  it("关窗确认框打开时 Esc 只关它自己", async () => {
    guard();
    await renderShell();
    await fireClose();
    await screen.findByRole("alertdialog");

    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(destroy).not.toHaveBeenCalled();
    expect(await screen.findByText("页面内容")).toBeInTheDocument();
  });
});

describe("多份草稿同时存在（SAFE-01）", () => {
  beforeEach(() => {
    destroy.mockClear();
    invoke.mockClear();
    closeHandler = null;
    exitHandler = null;
    resetUnsavedGuards();
    resetModalStack();
  });

  afterEach(() => {
    resetUnsavedGuards();
    resetModalStack();
  });

  function twoGuards(options: {
    outerSave?: () => Promise<string | null>;
    innerSave?: () => Promise<string | null>;
  } = {}) {
    const outer = {
      id: "orders-detail",
      label: "订单资料",
      isDirty: () => true,
      save: vi.fn(options.outerSave ?? (async () => null)),
      discard: vi.fn(),
    };
    const inner = {
      id: "orders-create",
      label: "新建订单",
      isDirty: () => true,
      save: vi.fn(options.innerSave ?? (async () => null)),
      discard: vi.fn(),
    };
    registerUnsavedGuard(outer);
    registerUnsavedGuard(inner);
    return { outer, inner };
  }

  it("两份都被保存，内层先存，全部成功才关闭", async () => {
    const order: string[] = [];
    const { outer, inner } = twoGuards({
      innerSave: async () => {
        order.push("内层");
        return null;
      },
      outerSave: async () => {
        order.push("外层");
        return null;
      },
    });

    await renderShell();
    await fireClose();
    await screen.findByRole("alertdialog");
    expect(screen.getByRole("alertdialog")).toHaveTextContent("2 处未保存的修改");

    await userEvent.click(screen.getByRole("button", { name: "保存并关闭" }));
    await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));

    expect(order).toEqual(["内层", "外层"]);
    expect(inner.save).toHaveBeenCalledTimes(1);
    expect(outer.save).toHaveBeenCalledTimes(1);
  });

  it("一份保存失败就停止，不关闭，另一份也不被放弃", async () => {
    const { outer, inner } = twoGuards({
      innerSave: async () => null,
      outerSave: async () => "revision 冲突",
    });

    await renderShell();
    await fireClose();
    await userEvent.click(await screen.findByRole("button", { name: "保存并关闭" }));

    await waitFor(() => expect(outer.save).toHaveBeenCalledTimes(1));
    expect(destroy).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent("订单资料：revision 冲突");
    // 内层已保存，外层仍是草稿：两份都还在登记表里受保护
    expect(dirtyGuards()).toHaveLength(2);
    expect(inner.discard).not.toHaveBeenCalled();
    expect(outer.discard).not.toHaveBeenCalled();
  });

  it("放弃会清空全部草稿，不只当前那一份", async () => {
    const { outer, inner } = twoGuards();
    await renderShell();
    await fireClose();
    await userEvent.click(await screen.findByRole("button", { name: "放弃修改并关闭" }));

    await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
    expect(inner.discard).toHaveBeenCalledTimes(1);
    expect(outer.discard).toHaveBeenCalledTimes(1);
    expect(inner.save).not.toHaveBeenCalled();
    expect(outer.save).not.toHaveBeenCalled();
  });

  it("取消后两份草稿都还在，再次关闭仍会拦", async () => {
    const { outer, inner } = twoGuards();
    await renderShell();
    await fireClose();
    await userEvent.click(await screen.findByRole("button", { name: "取消，继续编辑" }));

    expect(dirtyGuards()).toHaveLength(2);

    await fireClose();
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(inner.save).not.toHaveBeenCalled();
    expect(outer.save).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("内层保存后已卸载时不会重复保存，外层照常保存", async () => {
    const outer = {
      id: "orders-detail",
      label: "订单资料",
      isDirty: () => true,
      save: vi.fn(async () => null),
      discard: vi.fn(),
    };
    let unregisterInner = () => {};
    const inner = {
      id: "orders-create",
      label: "新建订单",
      isDirty: () => true,
      save: vi.fn(async () => {
        // 模拟"创建成功后面板自动关闭"
        unregisterInner();
        return null;
      }),
      discard: vi.fn(),
    };
    registerUnsavedGuard(outer);
    unregisterInner = registerUnsavedGuard(inner);

    await renderShell();
    await fireClose();
    await userEvent.click(await screen.findByRole("button", { name: "保存并关闭" }));

    await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
    expect(inner.save).toHaveBeenCalledTimes(1);
    expect(outer.save).toHaveBeenCalledTimes(1);
  });
});

describe("Cmd+Q 与红色按钮的一致性", () => {
  beforeEach(() => {
    destroy.mockClear();
    invoke.mockClear();
    closeHandler = null;
    exitHandler = null;
    resetUnsavedGuards();
    resetModalStack();
  });

  it("无草稿时 Cmd+Q 直接退出，不弹框", async () => {
    guard({ isDirty: () => false });
    await renderShell();
    await waitFor(() => expect(exitHandler).not.toBeNull());

    await act(async () => {
      exitHandler?.();
    });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("confirm_close"));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("Cmd+Q 时两份草稿都会被保存", async () => {
    const outer = {
      id: "outer",
      label: "订单资料",
      isDirty: () => true,
      save: vi.fn(async () => null),
      discard: vi.fn(),
    };
    const inner = {
      id: "inner",
      label: "新建订单",
      isDirty: () => true,
      save: vi.fn(async () => null),
      discard: vi.fn(),
    };
    registerUnsavedGuard(outer);
    registerUnsavedGuard(inner);

    await renderShell();
    await waitFor(() => expect(exitHandler).not.toBeNull());
    await act(async () => {
      exitHandler?.();
    });

    expect(await screen.findByRole("alertdialog")).toHaveTextContent("退出前有未保存的修改");
    await userEvent.click(screen.getByRole("button", { name: "保存并关闭" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("confirm_close"));
    expect(inner.save).toHaveBeenCalledTimes(1);
    expect(outer.save).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("Cmd+Q 保存失败时不退出", async () => {
    guard({ save: vi.fn(async () => "数据库忙") });
    await renderShell();
    await waitFor(() => expect(exitHandler).not.toBeNull());
    await act(async () => {
      exitHandler?.();
    });

    await userEvent.click(await screen.findByRole("button", { name: "保存并关闭" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("数据库忙"));
    expect(invoke).not.toHaveBeenCalled();
  });
});
