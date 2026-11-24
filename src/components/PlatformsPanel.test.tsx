import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlatformView } from "../bridge/commands";

const platformsMock = vi.fn(async (): Promise<PlatformView[]> => []);
const createMock = vi.fn(async (): Promise<PlatformView> => platform("p-new", "米画师", 500));
const updateMock = vi.fn(async (): Promise<PlatformView> => platform("p-1", "米画师", 500));
const archiveMock = vi.fn(async (): Promise<PlatformView> => platform("p-1", "米画师", 500, true));
const restoreMock = vi.fn(async (): Promise<PlatformView> => platform("p-1", "米画师", 500));
const reorderMock = vi.fn(async (): Promise<PlatformView[]> => []);
const deleteMock = vi.fn(async () => ({ id: "p-1", name: "米画师", detachedPayments: 0 }));

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    financeApi: {
      platforms: platformsMock,
      createPlatform: createMock,
      updatePlatform: updateMock,
      archivePlatform: archiveMock,
      restorePlatform: restoreMock,
      reorderPlatforms: reorderMock,
      deletePlatform: deleteMock,
    },
  };
});

function platform(
  id: string,
  name: string,
  feeRateBp: number | null,
  archived = false,
  sortPosition = 0,
): PlatformView {
  return {
    id,
    name,
    feeRateBp,
    archived,
    sortPosition,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

async function setup(rows: PlatformView[]) {
  platformsMock.mockImplementation(async () => rows);
  const { default: PlatformsPanel } = await import("./PlatformsPanel");
  const onError = vi.fn();
  render(<PlatformsPanel onError={onError} />);
  await waitFor(() => expect(platformsMock).toHaveBeenCalled());
  return { onError };
}

function backendError(code: string, message: string) {
  return { code, message };
}

beforeEach(() => {
  vi.clearAllMocks();
  platformsMock.mockImplementation(async () => []);
  createMock.mockImplementation(async () => platform("p-new", "米画师", 500));
  updateMock.mockImplementation(async () => platform("p-1", "米画师", 500));
  reorderMock.mockImplementation(async () => []);
  deleteMock.mockImplementation(async () => ({
    id: "p-1",
    name: "米画师",
    detachedPayments: 0,
  }));
});

describe("接单平台与手续费", () => {
  it("没有任何平台时给空状态，不预置也不造假数据", async () => {
    await setup([]);
    expect(screen.getByText("还没有任何平台。")).toBeTruthy();
    expect(screen.getByText(/程序不会替你预置平台/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "添加平台" })).toBeTruthy();
  });

  it("添加平台把用户原文送去后端，成功后刷新列表", async () => {
    const user = userEvent.setup();
    await setup([]);
    await user.click(screen.getByRole("button", { name: "添加平台" }));
    await user.type(screen.getByLabelText("平台名称"), "米画师");
    await user.type(screen.getByLabelText(/默认手续费率/), "5");
    await user.click(screen.getByRole("button", { name: "添加平台" }));

    await waitFor(() => expect(createMock).toHaveBeenCalled());
    expect(createMock).toHaveBeenCalledWith({ name: "米画师", feeRate: "5" });
    await waitFor(() => expect(platformsMock).toHaveBeenCalledTimes(2));
  });

  it("留空费率提交 null，而不是 0", async () => {
    const user = userEvent.setup();
    await setup([]);
    await user.click(screen.getByRole("button", { name: "添加平台" }));
    await user.type(screen.getByLabelText("平台名称"), "画加");
    await user.click(screen.getByRole("button", { name: "添加平台" }));
    await waitFor(() => expect(createMock).toHaveBeenCalled());
    expect(createMock).toHaveBeenCalledWith({ name: "画加", feeRate: null });
  });

  it("未设置与 0.00% 在列表里是两种写法", async () => {
    await setup([
      platform("p-1", "米画师", 500),
      platform("p-2", "画加", null, false, 1),
      platform("p-3", "私信", 0, false, 2),
    ]);
    expect(screen.getByText("5.00%")).toBeTruthy();
    expect(screen.getByText("未设置")).toBeTruthy();
    expect(screen.getByText("0.00%")).toBeTruthy();
  });

  it("编辑时回显名称和费率，保存后不改变其他平台", async () => {
    const user = userEvent.setup();
    await setup([platform("p-1", "米画师", 125)]);
    await user.click(screen.getByRole("button", { name: "编辑" }));

    const name = screen.getByLabelText("平台名称") as HTMLInputElement;
    const rate = screen.getByLabelText(/默认手续费率/) as HTMLInputElement;
    expect(name.value).toBe("米画师");
    expect(rate.value).toBe("1.25");

    await user.clear(rate);
    await user.type(rate, "2");
    await user.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    expect(updateMock).toHaveBeenCalledWith({ id: "p-1", name: "米画师", feeRate: "2" });
  });

  it("保存失败时保留用户正在输入的内容并给出原因", async () => {
    const user = userEvent.setup();
    createMock.mockImplementation(async () => {
      throw backendError("CONFLICT", "已有同名平台，请更换名称");
    });
    await setup([]);
    await user.click(screen.getByRole("button", { name: "添加平台" }));
    await user.type(screen.getByLabelText("平台名称"), "米画师");
    await user.type(screen.getByLabelText(/默认手续费率/), "5");
    await user.click(screen.getByRole("button", { name: "添加平台" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("已有同名平台");
    // 表单还在，输入没被清空
    expect((screen.getByLabelText("平台名称") as HTMLInputElement).value).toBe("米画师");
    expect((screen.getByLabelText(/默认手续费率/) as HTMLInputElement).value).toBe("5");
  });

  it("同名平台已归档时给的是「可恢复」提示，不是「请更换名称」", async () => {
    const user = userEvent.setup();
    createMock.mockImplementation(async () => {
      throw backendError("CONFLICT", "同名平台已归档，可恢复原平台或修改名称");
    });
    await setup([]);
    await user.click(screen.getByRole("button", { name: "添加平台" }));
    await user.type(screen.getByLabelText("平台名称"), "米画师");
    await user.click(screen.getByRole("button", { name: "添加平台" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("已归档"),
    );
  });

  it("归档与正常分两组展示，归档项不给拖拽抓手", async () => {
    await setup([
      platform("p-1", "米画师", 500),
      platform("p-2", "画加", null, true, 1),
    ]);
    expect(screen.getByRole("heading", { name: "正常使用" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "已归档" })).toBeTruthy();
    expect(screen.getByLabelText("拖动 米画师 调整顺序")).toBeTruthy();
    expect(screen.queryByLabelText("拖动 画加 调整顺序")).toBeNull();
    expect(screen.getByRole("button", { name: "恢复" })).toBeTruthy();
  });

  it("归档会调用归档接口并提示可恢复", async () => {
    const user = userEvent.setup();
    await setup([platform("p-1", "米画师", 500)]);
    await user.click(screen.getByRole("button", { name: "归档" }));
    await waitFor(() => expect(archiveMock).toHaveBeenCalledWith("p-1"));
    await waitFor(() =>
      expect(screen.getByText(/随时可恢复/)).toBeTruthy(),
    );
  });

  it("上移按钮提交的是完整的正常平台顺序", async () => {
    const user = userEvent.setup();
    const first = platform("p-1", "甲", null, false, 0);
    const second = platform("p-2", "乙", null, false, 1);
    reorderMock.mockImplementation(async () => [second, first]);
    await setup([first, second]);

    await user.click(screen.getByLabelText("上移 乙"));
    await waitFor(() => expect(reorderMock).toHaveBeenCalled());
    expect(reorderMock).toHaveBeenCalledWith(["p-2", "p-1"]);
  });

  it("排序失败要报错并回读服务器状态，不假装成功", async () => {
    const user = userEvent.setup();
    reorderMock.mockImplementation(async () => {
      throw backendError("CONFLICT", "平台列表已变化（可能被归档或在别处新增），请刷新后重试");
    });
    await setup([
      platform("p-1", "甲", null, false, 0),
      platform("p-2", "乙", null, false, 1),
    ]);
    const before = platformsMock.mock.calls.length;
    await user.click(screen.getByLabelText("下移 甲"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("已变化"));
    expect(screen.queryByText("排序已保存")).toBeNull();
    await waitFor(() => expect(platformsMock.mock.calls.length).toBeGreaterThan(before));
  });

  it("删除必须二次确认，取消时不调用接口", async () => {
    const user = userEvent.setup();
    await setup([platform("p-1", "米画师", 500)]);
    await user.click(screen.getByRole("button", { name: "删除" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "取消" }));
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("删除确认后说明历史流水快照仍然保留", async () => {
    const user = userEvent.setup();
    deleteMock.mockImplementation(async () => ({
      id: "p-1",
      name: "米画师",
      detachedPayments: 2,
    }));
    await setup([platform("p-1", "米画师", 500)]);
    await user.click(screen.getByRole("button", { name: "删除" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("米画师");
    expect(dialog.textContent).toContain("不会");
    await user.click(within(dialog).getByRole("button", { name: "永久删除" }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("p-1"));
    await waitFor(() =>
      expect(screen.getByText(/有 2 笔收款流水失去了平台关联/)).toBeTruthy(),
    );
    expect(screen.getByText(/快照仍然保留/)).toBeTruthy();
  });
});
