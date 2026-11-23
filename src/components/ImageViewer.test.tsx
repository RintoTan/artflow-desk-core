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

function renderViewer(index = 0) {
  const onChangeIndex = vi.fn();
  const onClose = vi.fn();
  render(
    <ImageViewer
      items={[item("a"), item("b")]}
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
});
