import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** 只模拟 Tauri 的 webview 拖拽通道，其余保持真实组件逻辑。 */
type DragPayload =
  | { type: "enter"; paths: string[]; position?: { x: number; y: number } }
  | { type: "over"; position?: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position?: { x: number; y: number } }
  | { type: "leave" };

let emit: ((event: { payload: DragPayload }) => void) | null = null;

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (cb: (event: { payload: DragPayload }) => void) => {
      emit = cb;
      return () => {
        emit = null;
      };
    },
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => ["/tmp/chosen.png"]),
}));

const importSpy = vi.fn(async (..._args: unknown[]) => [
  { ok: true, sourceName: "a.png", attachment: null, error: null },
]);

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    attachmentApi: {
      ...actual.attachmentApi,
      list: async () => [],
      import: (...args: unknown[]) => importSpy(...args),
      verify: async () => ({ attachments: [], missing: 0, corrupt: 0 }),
    },
  };
});

const { default: AttachmentPanel } = await import("./AttachmentPanel");

const RECT = {
  left: 100,
  top: 200,
  right: 600,
  bottom: 700,
  width: 500,
  height: 500,
  x: 100,
  y: 200,
  toJSON: () => ({}),
} as DOMRect;

function renderPanel(orderId = "o1") {
  const onError = vi.fn();
  const onNotice = vi.fn();
  const utils = render(
    <AttachmentPanel orderId={orderId} onError={onError} onNotice={onNotice} />,
  );
  return { ...utils, onError, onNotice };
}

async function fire(payload: DragPayload) {
  await waitFor(() => expect(emit).not.toBeNull());
  emit?.({ payload });
}

beforeEach(() => {
  importSpy.mockClear();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(RECT);
});

describe("参考图片面板的拖放边界", () => {
  it("落在面板内 → 只导入一次，且导入到当前订单", async () => {
    renderPanel("o1");
    await fire({ type: "over", position: { x: 150, y: 250 } });
    await fire({ type: "drop", paths: ["/tmp/a.png"], position: { x: 150, y: 250 } });

    await waitFor(() => expect(importSpy).toHaveBeenCalledTimes(1));
    expect(importSpy.mock.calls[0]?.[0]).toMatchObject({
      orderId: "o1",
      sourcePaths: ["/tmp/a.png"],
    });
  });

  it("落在订单列表 / 侧边栏 / 详情其它区域 → 零写入", async () => {
    const { onError } = renderPanel("o1");
    await fire({ type: "drop", paths: ["/tmp/a.png"], position: { x: 20, y: 20 } });
    await fire({ type: "drop", paths: ["/tmp/b.png"], position: { x: 900, y: 300 } });

    expect(importSpy).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("坐标缺失 → 零写入，并给出非侵入提示", async () => {
    const { onNotice } = renderPanel("o1");
    await fire({ type: "drop", paths: ["/tmp/a.png"] });

    expect(importSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(onNotice).toHaveBeenCalledTimes(1));
  });

  it("拖拽期间切换订单 → 不导入，也不写到新订单", async () => {
    const first = renderPanel("o1");
    await fire({ type: "over", position: { x: 150, y: 250 } });

    first.rerender(<AttachmentPanel orderId="o2" onError={first.onError} onNotice={first.onNotice} />);
    await fire({ type: "drop", paths: ["/tmp/a.png"], position: { x: 150, y: 250 } });

    expect(importSpy).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(first.onError.mock.calls[0]?.[0]).toContain("拖拽期间切换了订单"),
    );
  });

  it("同一次拖拽连发两次 drop → 只导入一次", async () => {
    renderPanel("o1");
    await fire({ type: "drop", paths: ["/tmp/a.png"], position: { x: 150, y: 250 } });
    await fire({ type: "drop", paths: ["/tmp/a.png"], position: { x: 150, y: 250 } });

    await waitFor(() => expect(importSpy).toHaveBeenCalledTimes(1));
  });

  it("点击空状态仍然走原有文件选择流程", async () => {
    const user = userEvent.setup();
    renderPanel("o1");
    const zone = await screen.findByRole("button", { name: /把参考图片拖到这里/ });
    await user.click(zone);

    await waitFor(() => expect(importSpy).toHaveBeenCalledTimes(1));
  });
});
