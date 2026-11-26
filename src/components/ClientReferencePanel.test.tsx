import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientRef, ClientRefOutcome } from "../bridge/commands";

const state = vi.hoisted(() => ({
  items: [] as ClientRef[],
  list: vi.fn(),
  import: vi.fn(),
  remove: vi.fn(),
  dialog: [] as string[],
}));

function ref(id: string, name: string, overrides: Partial<ClientRef> = {}): ClientRef {
  return {
    id,
    clientId: "c-1",
    originalName: name,
    mimeType: "image/png",
    byteSize: 1024,
    width: 800,
    height: 600,
    state: "ok",
    createdAt: "2026-11-26T00:00:00.000Z",
    originalPath: `/gen/attachments/originals/clients/c-1/${id}.png`,
    thumbPath: `/gen/attachments/thumbs/clients/c-1/${id}.webp`,
    fileExists: true,
    thumbExists: true,
    ...overrides,
  };
}

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: async () => state.dialog,
}));

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>("../bridge/commands");
  return {
    ...actual,
    // 必须转发调用而不是直接引用函数：mock 工厂只在模块初始化时执行一次，
    // 直接赋值会把 beforeEach 里替换的实现挡在外面。
    clientRefApi: {
      list: (clientId: string) => state.list(clientId),
      import: (input: { clientId: string; sourcePaths: string[] }) => state.import(input),
      remove: (clientId: string, attachmentId: string) => state.remove(clientId, attachmentId),
    },
  };
});

const { default: ClientReferencePanel } = await import("./ClientReferencePanel");

beforeEach(() => {
  state.items = [];
  state.dialog = [];
  state.list = vi.fn(async () => state.items);
  state.import = vi.fn(async (input: { clientId: string; sourcePaths: string[] }): Promise<ClientRefOutcome[]> => {
    const added = input.sourcePaths.map((path, index) => ref(`new-${index}`, path.split("/").pop() ?? "ref.png"));
    state.items = [...added, ...state.items];
    return added.map((attachment, index) => ({
      sourceName: input.sourcePaths[index] ?? "ref.png",
      ok: true,
      attachment,
      error: null,
    }));
  });
  state.remove = vi.fn(async () => {
    state.items = state.items.slice(1);
  });
});

describe("客户参考图", () => {
  it("没有图时说明可以上传或拖入", async () => {
    render(<ClientReferencePanel clientId="c-1" />);
    expect(await screen.findByText(/还没有参考图/)).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("列出已有参考图，缩略图用缩略图路径", async () => {
    state.items = [ref("a-1", "设定.png")];
    render(<ClientReferencePanel clientId="c-1" />);
    const thumb = await screen.findByRole("button", { name: "查看 设定.png" });
    const img = thumb.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(
      `asset://localhost/${encodeURIComponent("/gen/attachments/thumbs/clients/c-1/a-1.webp")}`,
    );
  });

  it("点缩略图打开原图，关闭后回到客户资料", async () => {
    const user = userEvent.setup();
    state.items = [ref("a-1", "设定.png")];
    render(<ClientReferencePanel clientId="c-1" />);

    await user.click(await screen.findByRole("button", { name: "查看 设定.png" }));
    const viewer = screen.getByRole("dialog");
    expect(within(viewer).getByRole("img").getAttribute("src")).toBe(
      `asset://localhost/${encodeURIComponent("/gen/attachments/originals/clients/c-1/a-1.png")}`,
    );

    await user.click(within(viewer).getByRole("button", { name: "关闭原图" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("删除需要确认，确认后调用后端并刷新", async () => {
    const user = userEvent.setup();
    state.items = [ref("a-1", "设定.png")];
    render(<ClientReferencePanel clientId="c-1" />);

    await user.click(await screen.findByRole("button", { name: "删除 设定.png" }));
    // 应用内确认框用的是 alertdialog（不是 dialog），与查看器的角色区分开
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/不能撤销/)).toBeInTheDocument();
    expect(state.remove).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(state.remove).toHaveBeenCalledWith("c-1", "a-1"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("上传走系统文件选择，失败项逐条说明", async () => {
    const user = userEvent.setup();
    state.dialog = ["/tmp/ok.png", "/tmp/bad.gif"];
    state.import = vi.fn(async () => [
      { sourceName: "ok.png", ok: true, attachment: ref("new-0", "ok.png"), error: null },
      { sourceName: "bad.gif", ok: false, attachment: null, error: "无法识别的图片格式（只支持 PNG / JPEG / WebP）" },
    ]);
    render(<ClientReferencePanel clientId="c-1" />);

    await user.click(await screen.findByRole("button", { name: "上传参考图" }));

    await waitFor(() => expect(state.import).toHaveBeenCalled());
    // 扩展名不在白名单的路径在发起 IPC 之前就被挡住
    expect(state.import.mock.calls[0]?.[0]).toEqual({ clientId: "c-1", sourcePaths: ["/tmp/ok.png"] });
    expect(await screen.findByRole("alert")).toHaveTextContent("bad.gif");
  });
});
