import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ContextMenu, { type ContextMenuItem } from "./ContextMenu";
import { pushLayer, resetLayerStack, topLayer } from "../lib/layers";

function items(overrides: Partial<ContextMenuItem> = {}): ContextMenuItem[] {
  return [
    { id: "open", label: "打开订单", onSelect: vi.fn(), ...overrides },
    { id: "cancel", label: "取消订单…", onSelect: vi.fn(), danger: true },
  ];
}

beforeEach(() => {
  resetLayerStack();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("右键菜单", () => {
  it("按菜单语义渲染条目，并聚焦第一项", async () => {
    const list = items();
    render(<ContextMenu x={100} y={120} items={list} onClose={() => {}} />);

    const menu = screen.getByRole("menu", { name: "订单操作" });
    expect(menu).toBeTruthy();
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "打开订单" })).toHaveFocus());
  });

  it("点条目：先执行回调，再关闭", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <ContextMenu
        x={0}
        y={0}
        items={[{ id: "open", label: "打开订单", onSelect }]}
        onClose={onClose}
      />,
    );

    await userEvent.click(screen.getByRole("menuitem", { name: "打开订单" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点菜单外部关闭，点菜单内部不关闭", async () => {
    const onClose = vi.fn();
    render(<ContextMenu x={0} y={0} items={items()} onClose={onClose} />);

    fireEvent.mouseDown(screen.getByRole("menu"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc 关闭", () => {
    const onClose = vi.fn();
    render(<ContextMenu x={0} y={0} items={items()} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("上面还压着别的浮层时不抢 Esc：一次按键只关最上层", () => {
    const onClose = vi.fn();
    render(<ContextMenu x={0} y={0} items={items()} onClose={onClose} />);
    // 模拟「菜单之上又开了一层」
    pushLayer("something-else");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("滚动与窗口尺寸变化都关闭：fixed 定位跟不动", () => {
    const onClose = vi.fn();
    render(<ContextMenu x={0} y={0} items={items()} onClose={onClose} />);

    fireEvent.scroll(window);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.resize(window);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("上下键在可用条目之间移动焦点", async () => {
    render(<ContextMenu x={0} y={0} items={items()} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "打开订单" })).toHaveFocus());

    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "取消订单…" })).toHaveFocus();

    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(screen.getByRole("menuitem", { name: "打开订单" })).toHaveFocus();
  });

  it("挂载登记层级、卸载退栈，不留幽灵浮层", () => {
    const { unmount } = render(<ContextMenu x={0} y={0} items={items()} onClose={() => {}} />);
    expect(topLayer()).not.toBeNull();
    unmount();
    expect(topLayer()).toBeNull();
  });

  it("关闭后焦点回到打开前的元素", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "打开者";
    document.body.appendChild(trigger);
    trigger.focus();

    const { unmount } = render(<ContextMenu x={0} y={0} items={items()} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "打开订单" })).toHaveFocus());

    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("定位落在视口内：给出的坐标贴边时向内收", () => {
    render(<ContextMenu x={5000} y={5000} items={items()} onClose={() => {}} />);
    const menu = screen.getByRole("menu");
    const left = Number.parseFloat((menu as HTMLElement).style.left);
    const top = Number.parseFloat((menu as HTMLElement).style.top);
    // jsdom 里量不出菜单尺寸，只验证「不越界」这一半
    expect(left).toBeLessThanOrEqual(window.innerWidth);
    expect(top).toBeLessThanOrEqual(window.innerHeight);
  });
});
