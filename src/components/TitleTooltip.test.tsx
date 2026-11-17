import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TruncatedTitle, isTruncated, placeTooltip, titleMetrics } from "./TitleTooltip";

const LONG = "这是一个非常长的订单标题，包含 EnglishMixedWordsWithoutSpaces 与中文混排";

function row(text: string) {
  return (
    <button type="button">
      <TruncatedTitle className="order-row-title" text={text} />
    </button>
  );
}

describe("截断判定", () => {
  it("完整高度超过按钮盒高度才算截断", () => {
    expect(isTruncated({ clientHeight: 36 }, 36)).toBe(false);
    expect(isTruncated({ clientHeight: 36 }, 37)).toBe(false);
    expect(isTruncated({ clientHeight: 36 }, 55)).toBe(true);
  });
});

describe("气泡定位", () => {
  const viewport = { width: 900, height: 800 };

  it("默认放在触发元素下方并水平居中", () => {
    const r = placeTooltip({ x: 300, y: 100, w: 200, h: 40 }, { w: 120, h: 30 }, viewport);
    expect(r.placement).toBe("bottom");
    expect(r.top).toBe(148);
    expect(r.left).toBe(340);
  });

  it("下方放不下时翻到上方", () => {
    const r = placeTooltip({ x: 300, y: 760, w: 200, h: 40 }, { w: 120, h: 60 }, viewport);
    expect(r.placement).toBe("top");
    expect(r.top).toBe(692);
  });

  it("靠近左/右边缘时贴边不移出视口", () => {
    const left = placeTooltip({ x: 0, y: 100, w: 100, h: 40 }, { w: 300, h: 30 }, viewport);
    expect(left.left).toBe(8);
    const right = placeTooltip({ x: 800, y: 100, w: 100, h: 40 }, { w: 300, h: 30 }, viewport);
    expect(right.left).toBe(viewport.width - 8 - 300);
  });
});

describe("长标题提示", () => {
  let fullHeight: number;

  beforeEach(() => {
    vi.useFakeTimers();
    fullHeight = 0;
    vi.spyOn(titleMetrics, "fullHeight").mockImplementation(() => fullHeight);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function hover() {
    fireEvent.pointerOver(screen.getByText(LONG.slice(0, 10), { exact: false }), {
      pointerType: "mouse",
    });
  }

  it("没有被截断时不弹气泡", () => {
    fullHeight = 0;
    render(row("短标题"));
    fireEvent.pointerOver(screen.getByText("短标题"));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("被截断时延迟后显示完整标题", () => {
    fullHeight = 60;
    render(row(LONG));
    hover();

    // 立刻出现会显得吵：450ms 之前不应该有气泡
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(100);
    });
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent(LONG);
    // 气泡挂在 body 上，不会被列表的滚动容器裁切
    expect(tip.parentElement).toBe(document.body);
  });

  it("鼠标移出立刻收起", () => {
    fullHeight = 60;
    render(row(LONG));
    hover();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    fireEvent.pointerOut(document.querySelector(".order-row-title")!);
    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("键盘聚焦整行也能看到完整标题", () => {
    fullHeight = 60;
    render(row(LONG));
    act(() => {
      screen.getByRole("button").focus();
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole("tooltip")).toHaveTextContent(LONG);
    // 可访问性：焦点在按钮上时，气泡文本作为描述
    expect(screen.getByRole("button")).toHaveAttribute("aria-describedby");
  });

  it("滚动容器滚动时收起，避免气泡停在旧位置", () => {
    fullHeight = 60;
    render(row(LONG));
    hover();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("Esc 收起气泡", () => {
    fullHeight = 60;
    render(row(LONG));
    hover();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
