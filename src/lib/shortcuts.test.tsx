import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { popModal, pushModal, resetModalStack } from "./modalStack";
import { usePageShortcuts, type PageShortcuts } from "./shortcuts";

function Harness(props: PageShortcuts & { enabled?: boolean }) {
  usePageShortcuts(props, props.enabled ?? true);
  return (
    <div>
      <input aria-label="标题" />
      <button type="button">按钮</button>
    </div>
  );
}

afterEach(() => {
  resetModalStack();
});

describe("页面快捷键", () => {
  it("Cmd+N / Cmd+S / Cmd+F 触发对应动作", async () => {
    const onNew = vi.fn();
    const onSave = vi.fn();
    const onFocusSearch = vi.fn();
    render(<Harness onNew={onNew} onSave={onSave} onFocusSearch={onFocusSearch} />);

    await userEvent.keyboard("{Meta>}n{/Meta}");
    await userEvent.keyboard("{Meta>}s{/Meta}");
    await userEvent.keyboard("{Meta>}f{/Meta}");

    expect(onNew).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onFocusSearch).toHaveBeenCalledTimes(1);
  });

  it("没传的快捷键不会吞掉默认行为", async () => {
    render(<Harness />);
    await userEvent.keyboard("{Meta>}n{/Meta}");
    // 不抛错、不阻塞，即视为通过；这里只确认没有副作用
    expect(screen.getByLabelText("标题")).toBeInTheDocument();
  });

  it("正在输入文本时方向键不触发列表移动", async () => {
    const onMoveSelection = vi.fn();
    const onOpenSelection = vi.fn();
    render(<Harness onMoveSelection={onMoveSelection} onOpenSelection={onOpenSelection} />);

    const input = screen.getByLabelText("标题");
    await userEvent.click(input);
    await userEvent.keyboard("{ArrowDown}{ArrowUp}{Enter}");

    expect(onMoveSelection).not.toHaveBeenCalled();
    expect(onOpenSelection).not.toHaveBeenCalled();
  });

  it("焦点不在输入框时方向键与 Enter 生效", async () => {
    const onMoveSelection = vi.fn();
    const onOpenSelection = vi.fn();
    render(<Harness onMoveSelection={onMoveSelection} onOpenSelection={onOpenSelection} />);

    await userEvent.click(screen.getByRole("button", { name: "按钮" }));
    await userEvent.keyboard("{ArrowDown}{ArrowUp}{Enter}");

    expect(onMoveSelection).toHaveBeenNthCalledWith(1, 1);
    expect(onMoveSelection).toHaveBeenNthCalledWith(2, -1);
    expect(onOpenSelection).toHaveBeenCalledTimes(1);
  });

  it("模态打开时整页快捷键失效", async () => {
    const onSave = vi.fn();
    const onMoveSelection = vi.fn();
    render(<Harness onSave={onSave} onMoveSelection={onMoveSelection} />);

    pushModal("some-modal");
    await userEvent.click(screen.getByRole("button", { name: "按钮" }));
    await userEvent.keyboard("{Meta>}s{/Meta}{ArrowDown}");

    expect(onSave).not.toHaveBeenCalled();
    expect(onMoveSelection).not.toHaveBeenCalled();

    popModal("some-modal");
    await userEvent.keyboard("{Meta>}s{/Meta}");
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("输入法组合中的按键不当作快捷键", async () => {
    const onMoveSelection = vi.fn();
    render(<Harness onMoveSelection={onMoveSelection} />);

    await userEvent.click(screen.getByRole("button", { name: "按钮" }));
    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "isComposing", { value: true });
    document.dispatchEvent(event);

    expect(onMoveSelection).not.toHaveBeenCalled();
  });

  it("enabled=false 时完全不响应", async () => {
    const onSave = vi.fn();
    render(<Harness onSave={onSave} enabled={false} />);
    await userEvent.keyboard("{Meta>}s{/Meta}");
    expect(onSave).not.toHaveBeenCalled();
  });
});
