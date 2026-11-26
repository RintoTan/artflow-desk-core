import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { OrderCover } from "../bridge/commands";
import OrderThumb from "./OrderThumb";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));

function cover(overrides: Partial<OrderCover> = {}): OrderCover {
  return {
    orderId: "o-1",
    attachmentId: "a-1",
    role: "final",
    thumbPath: "/gen/attachments/thumbs/a-1.webp",
    originalPath: "/gen/attachments/a-1.png",
    mimeType: "image/png",
    ...overrides,
  };
}

function url(path: string) {
  return `asset://localhost/${encodeURIComponent(path)}`;
}

describe("订单缩略图", () => {
  it("有缩略图就用缩略图，不拉原图", () => {
    const { container } = render(<OrderThumb cover={cover()} />);
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(url("/gen/attachments/thumbs/a-1.webp"));
  });

  it("没有缩略图时回退到原图", () => {
    const { container } = render(<OrderThumb cover={cover({ thumbPath: null })} />);
    expect((container.querySelector("img") as HTMLImageElement).getAttribute("src")).toBe(
      url("/gen/attachments/a-1.png"),
    );
  });

  it("没有封面时给占位块，不渲染 img", () => {
    const { container } = render(<OrderThumb />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".order-thumb-empty")).not.toBeNull();
  });

  it("图片加载失败后退到占位块，不留碎图标", () => {
    const { container } = render(<OrderThumb cover={cover()} />);
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".order-thumb-empty")).not.toBeNull();
  });
});
