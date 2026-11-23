import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AttachmentView } from "../bridge/commands";
import ImageViewer from "./ImageViewer";

// jsdom 里没有 Tauri 的 asset 协议，直接原样返回路径即可。
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p }));

function item(id: string): AttachmentView {
  return {
    id,
    orderId: "o1",
    displayName: null,
    note: null,
    tag: null,
    byteSize: 1024,
    sha256: "x",
    width: 800,
    height: 600,
    state: "ok",
    createdAt: "2026-11-20T00:00:00+08:00",
    originalPath: `attachments/originals/${id}.png`,
    thumbPath: `attachments/thumbs/${id}.webp`,
    fileExists: true,
    thumbExists: true,
    thumbState: "ok",
  } as unknown as AttachmentView;
}

const noop = () => {};

function renderViewer(index = 0, count = 2) {
  const onChangeIndex = vi.fn();
  const onClose = vi.fn();
  const items = Array.from({ length: count }, (_, i) => item(`a${i}`));
  render(
    <ImageViewer
      items={items}
      index={index}
      busy={false}
      onClose={onClose}
      onChangeIndex={onChangeIndex}
      onSaveMeta={noop}
      onRemove={noop}
      onRepair={noop}
    />,
  );
  return { onChangeIndex, onClose };
}

describe("附件查看器", () => {
  it("滚轮缩放并夹在 20%–600% 之间", () => {
    renderViewer();
    const stage = document.querySelector(".viewer-stage") as HTMLElement;
    fireEvent.wheel(stage, { deltaY: -100 });
    expect(screen.getByText("115%")).toBeInTheDocument();

    for (let i = 0; i < 40; i += 1) fireEvent.wheel(stage, { deltaY: 100 });
    expect(screen.getByText("20%")).toBeInTheDocument();

    for (let i = 0; i < 60; i += 1) fireEvent.wheel(stage, { deltaY: -100 });
    expect(screen.getByText("600%")).toBeInTheDocument();
  });

  it("前后切换在两端禁用，点击可换到下一张", async () => {
    const user = userEvent.setup();
    const { onChangeIndex } = renderViewer(0);
    const prev = screen.getByRole("button", { name: /上一/ });
    const next = screen.getByRole("button", { name: /下一/ });
    expect(prev).toBeDisabled();
    await user.click(next);
    expect(onChangeIndex).toHaveBeenCalledWith(1);
  });

  it("Escape 关闭查看器", async () => {
    const user = userEvent.setup();
    const { onClose } = renderViewer();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("拖拽平移改的是 offset，松手后停住", () => {
    renderViewer();
    const stage = document.querySelector(".viewer-stage") as HTMLElement;
    const img = document.querySelector(".viewer-image") as HTMLImageElement;

    fireEvent.pointerDown(stage, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(stage, { clientX: 140, clientY: 130 });
    expect(img.style.transform).toContain("translate(40px, 30px)");

    fireEvent.pointerMove(stage, { clientX: 180, clientY: 160 });
    expect(img.style.transform).toContain("translate(80px, 60px)");

    fireEvent.pointerUp(stage);
    fireEvent.pointerMove(stage, { clientX: 400, clientY: 400 });
    expect(img.style.transform).toContain("translate(80px, 60px)");
  });

  it("切换图片即「适配画面」：缩放与位移归零", () => {
    const { rerender } = render(
      <ImageViewer items={[item("a"), item("b")]} index={0} busy={false}
        onClose={noop} onChangeIndex={noop} onSaveMeta={noop}
        onRemove={noop} onRepair={noop} />,
    );
    const stage = document.querySelector(".viewer-stage") as HTMLElement;
    fireEvent.pointerDown(stage, { clientX: 50, clientY: 50 });
    fireEvent.pointerMove(stage, { clientX: 90, clientY: 90 });
    fireEvent.pointerUp(stage);
    fireEvent.wheel(stage, { deltaY: -100 });
    expect(document.querySelector(".viewer-image")!.getAttribute("style")).toContain("translate(40px, 40px)");

    rerender(<ImageViewer items={[item("a"), item("b")]} index={1} busy={false}
      onClose={noop} onChangeIndex={noop} onSaveMeta={noop}
      onRemove={noop} onRepair={noop} />);
    // CSSOM 会把 translate(0px, 0px) 归一化成 translate(0px)，只断言归零与 scale(1)
    expect(document.querySelector(".viewer-image")!.getAttribute("style")).toMatch(/translate\(0px\)|translate\(0px, 0px\)/);
    expect(document.querySelector(".viewer-image")!.getAttribute("style")).toContain("scale(1)");
  });

  it("中间位置可以双向切换，两端各自禁用", async () => {
    const user = userEvent.setup();
    const { onChangeIndex } = renderViewer(1, 3);
    await user.click(screen.getByRole("button", { name: /上一/ }));
    expect(onChangeIndex).toHaveBeenLastCalledWith(0);
    await user.click(screen.getByRole("button", { name: /下一/ }));
    expect(onChangeIndex).toHaveBeenLastCalledWith(2);
  });
});

describe("附件查看器 · 两端", () => {
  it("最后一张时下一张禁用", () => {
    renderViewer(2, 3);
    expect(screen.getByRole("button", { name: /下一/ })).toBeDisabled();
  });
});
