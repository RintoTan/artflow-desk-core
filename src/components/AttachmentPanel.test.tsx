import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AttachmentView } from "../bridge/commands";

function attachment(partial: Partial<AttachmentView>): AttachmentView {
  return {
    id: "att-1",
    orderId: "order-1",
    originalName: "参考图.png",
    displayName: null,
    note: null,
    tag: null,
    mimeType: "image/png",
    byteSize: 2048,
    sha256: "abc",
    width: 900,
    height: 600,
    state: "ok",
    createdAt: "2026-11-01T00:00:00.000Z",
    originalPath: "/tmp/data/attachments/originals/att-1.png",
    thumbPath: "/tmp/data/attachments/thumbs/att-1.webp",
    fileExists: true,
    thumbExists: true,
    ...partial,
  };
}

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));

const list = vi.fn(async (): Promise<AttachmentView[]> => []);
const remove = vi.fn(async () => undefined);

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    attachmentApi: {
      list,
      remove,
      import: vi.fn(),
      verify: vi.fn(),
      rebuildThumbs: vi.fn(),
      repair: vi.fn(),
      updateMeta: vi.fn(),
    },
  };
});

describe("参考图片面板", () => {
  beforeEach(() => {
    list.mockReset();
    remove.mockReset();
    remove.mockResolvedValue(undefined);
  });

  it("没有图片时显示导入引导", async () => {
    list.mockResolvedValue([]);
    const { default: AttachmentPanel } = await import("./AttachmentPanel");
    render(<AttachmentPanel orderId="order-1" onError={vi.fn()} onNotice={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("还没有参考图片。")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "导入图片" })).toBeInTheDocument();
  });

  it("正常图片显示缩略图网格与尺寸", async () => {
    list.mockResolvedValue([attachment({ displayName: "封面参考" })]);
    const { default: AttachmentPanel } = await import("./AttachmentPanel");
    render(<AttachmentPanel orderId="order-1" onError={vi.fn()} onNotice={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("封面参考")).toBeInTheDocument());
    expect(screen.getByText(/900×600/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "校验" })).toBeInTheDocument();
  });

  it("缺失原图会标出状态并提供重新选择原图", async () => {
    list.mockResolvedValue([
      attachment({ state: "missing", fileExists: false, thumbExists: false }),
    ]);
    const { default: AttachmentPanel } = await import("./AttachmentPanel");
    render(<AttachmentPanel orderId="order-1" onError={vi.fn()} onNotice={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("原图缺失")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "重新选择原图" })).toBeInTheDocument();
    expect(screen.getByText("无预览")).toBeInTheDocument();
  });

  it("移除需要确认，取消时不调用删除命令", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue([attachment({})]);
    const { default: AttachmentPanel } = await import("./AttachmentPanel");
    render(<AttachmentPanel orderId="order-1" onError={vi.fn()} onNotice={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "移除" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "移除" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("确认移除这张参考图片？");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "取消" })).toHaveFocus(),
    );
    await user.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(remove).not.toHaveBeenCalled();
  });

  it("确认后才真正移除", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue([attachment({})]);
    const { default: AttachmentPanel } = await import("./AttachmentPanel");
    render(<AttachmentPanel orderId="order-1" onError={vi.fn()} onNotice={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "移除" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "移除" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "确认移除" }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith("att-1"));
  });

  it("点击缩略图打开查看器，Esc 可关闭", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue([attachment({ displayName: "封面参考" })]);
    const { default: AttachmentPanel } = await import("./AttachmentPanel");
    render(<AttachmentPanel orderId="order-1" onError={vi.fn()} onNotice={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "查看 封面参考" }));
    expect(await screen.findByRole("dialog", { name: "图片查看器" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "图片查看器" })).not.toBeInTheDocument(),
    );
  });
});
