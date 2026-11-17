import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import UnsavedChangesDialog from "./UnsavedChangesDialog";

function renderDialog(overrides: Partial<Parameters<typeof UnsavedChangesDialog>[0]> = {}) {
  const onSaveAndLeave = vi.fn();
  const onDiscard = vi.fn();
  const onStay = vi.fn();
  const utils = render(
    <UnsavedChangesDialog
      open
      onSaveAndLeave={onSaveAndLeave}
      onDiscard={onDiscard}
      onStay={onStay}
      {...overrides}
    />,
  );
  return { ...utils, onSaveAndLeave, onDiscard, onStay };
}

/** 保存失败后由父组件保持打开并回填错误，验证"草稿不丢、可重试"。 */
function FailingHarness({ onSaveAttempt }: { onSaveAttempt: () => void }) {
  const [open, setOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <>
      <button type="button">外部按钮</button>
      <UnsavedChangesDialog
        open={open}
        busy={busy}
        error={error}
        onSaveAndLeave={async () => {
          onSaveAttempt();
          setBusy(true);
          await Promise.resolve();
          setBusy(false);
          setError("保存失败：数据库不可用。草稿仍保留在表单中。");
        }}
        onDiscard={() => setOpen(false)}
        onStay={() => setOpen(false)}
      />
    </>
  );
}

describe("未保存修改对话框", () => {
  it("显示标题与三种操作，默认聚焦「继续编辑」", async () => {
    const { onStay } = renderDialog();

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText("有尚未保存的修改")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存并离开" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "放弃修改" })).toBeInTheDocument();

    const stay = screen.getByRole("button", { name: "继续编辑" });
    await waitFor(() => expect(stay).toHaveFocus());
    expect(onStay).not.toHaveBeenCalled();
  });

  it("以模态方式呈现，并带背景遮罩", () => {
    renderDialog();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("unsaved-overlay")).toBeInTheDocument();
  });

  it("按 Esc 等同「继续编辑」，不会丢弃草稿", async () => {
    const user = userEvent.setup();
    const { onStay, onDiscard, onSaveAndLeave } = renderDialog();

    await user.keyboard("{Escape}");

    expect(onStay).toHaveBeenCalledTimes(1);
    expect(onDiscard).not.toHaveBeenCalled();
    expect(onSaveAndLeave).not.toHaveBeenCalled();
  });

  it("点击「放弃修改」只触发一次", async () => {
    const user = userEvent.setup();
    const { onDiscard, onStay } = renderDialog();

    await user.click(screen.getByRole("button", { name: "放弃修改" }));

    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onStay).not.toHaveBeenCalled();
  });

  it("保存失败时保持打开、显示错误，且草稿未被丢弃", async () => {
    const user = userEvent.setup();
    const onSaveAttempt = vi.fn();
    render(<FailingHarness onSaveAttempt={onSaveAttempt} />);

    await user.click(screen.getByRole("button", { name: "保存并离开" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("保存失败"),
    );
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(onSaveAttempt).toHaveBeenCalledTimes(1);
    // 保存失败后仍可再次操作
    expect(screen.getByRole("button", { name: "放弃修改" })).toBeEnabled();
  });

  it("处理中禁用全部操作，避免重复导航", async () => {
    const user = userEvent.setup();
    const onSaveAndLeave = vi.fn(() => new Promise<void>(() => {}));
    renderDialog({ busy: true, onSaveAndLeave });

    const save = screen.getByRole("button", { name: "保存并离开" });
    const discard = screen.getByRole("button", { name: "放弃修改" });
    const stay = screen.getByRole("button", { name: "继续编辑" });

    expect(save).toBeDisabled();
    expect(discard).toBeDisabled();
    expect(stay).toBeDisabled();
    await user.click(save);
    expect(onSaveAndLeave).not.toHaveBeenCalled();
  });

  it("连续点击「保存并离开」只触发一次", async () => {
    const user = userEvent.setup();
    const pending: { resolve?: () => void } = {};
    const onSaveAndLeave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          pending.resolve = resolve;
        }),
    );
    renderDialog({ onSaveAndLeave });

    const save = screen.getByRole("button", { name: "保存并离开" });
    await user.click(save);
    await user.click(save);

    expect(onSaveAndLeave).toHaveBeenCalledTimes(1);
    pending.resolve?.();
  });

  it("Tab 不会把焦点移出对话框", async () => {
    const user = userEvent.setup();
    renderDialog();

    const stay = screen.getByRole("button", { name: "继续编辑" });
    await waitFor(() => expect(stay).toHaveFocus());

    // 「继续编辑」是最后一个可聚焦元素，Tab 应回到第一个按钮
    await user.tab();
    expect(screen.getByRole("button", { name: "保存并离开" })).toHaveFocus();

    await user.tab({ shift: true });
    expect(stay).toHaveFocus();
  });

  it("关闭后焦点回到打开前的元素", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            打开确认
          </button>
          <UnsavedChangesDialog
            open={open}
            onSaveAndLeave={() => setOpen(false)}
            onDiscard={() => setOpen(false)}
            onStay={() => setOpen(false)}
          />
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "打开确认" });
    await user.click(trigger);
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("关闭时不渲染任何内容", () => {
    render(
      <UnsavedChangesDialog
        open={false}
        onSaveAndLeave={() => {}}
        onDiscard={() => {}}
        onStay={() => {}}
      />,
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("unsaved-overlay")).not.toBeInTheDocument();
  });
});
