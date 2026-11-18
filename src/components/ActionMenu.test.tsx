import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import ActionMenu from "./ActionMenu";

function setup() {
  const onCancel = vi.fn();
  render(
    <div>
      <button type="button">页面其它按钮</button>
      <ActionMenu label="更多操作">
        <button type="button" onClick={onCancel}>
          取消订单…
        </button>
      </ActionMenu>
    </div>,
  );
  return { onCancel };
}

describe("更多操作菜单", () => {
  it("点击触发按钮开、再点关闭", async () => {
    const user = userEvent.setup();
    setup();
    const trigger = screen.getByRole("button", { name: "更多操作" });

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: "更多操作" })).toBeInTheDocument();

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("点击菜单外部关闭", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "更多操作" }));
    await user.click(screen.getByRole("button", { name: "页面其它按钮" }));

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("Escape 关闭并把焦点还给触发按钮", async () => {
    const user = userEvent.setup();
    setup();
    const trigger = screen.getByRole("button", { name: "更多操作" });
    await user.click(trigger);
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it("点菜单里的操作不会当成外部点击，执行后收起", async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.click(screen.getByRole("button", { name: "更多操作" }));
    await user.click(screen.getByRole("button", { name: "取消订单…" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("禁用时打不开菜单", async () => {
    const user = userEvent.setup();
    render(<ActionMenu label="更多操作" disabled><button type="button">项</button></ActionMenu>);
    const trigger = screen.getByRole("button", { name: "更多操作" });
    await user.click(trigger);
    expect(trigger).toBeDisabled();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
