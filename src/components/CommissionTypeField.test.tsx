import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import CommissionTypeField from "./CommissionTypeField";

function Harness({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState("");
  return (
    <div>
      <CommissionTypeField id="type" value={value} onChange={setValue} disabled={disabled} />
      <output data-testid="value">{value}</output>
    </div>
  );
}

function group() {
  return screen.getByRole("group", { name: "高频类型" });
}

describe("委托类型输入", () => {
  it("七个预设都渲染出来", () => {
    render(<Harness />);
    const chips = within(group()).getAllByRole("button");
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "插画",
      "组合页",
      "服设",
      "设定卡",
      "表情包",
      "头像",
      "摸鱼",
    ]);
  });

  it("点预设就填进输入框，再点一次清空", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const chip = within(group()).getByRole("button", { name: "设定卡" });

    await user.click(chip);
    expect(screen.getByTestId("value")).toHaveTextContent("设定卡");
    expect(chip).toHaveAttribute("aria-pressed", "true");

    await user.click(chip);
    expect(screen.getByTestId("value")).toHaveTextContent("");
    expect(chip).toHaveAttribute("aria-pressed", "false");
  });

  it("预设不限制自由输入：手写的类型不会被改掉", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole("textbox") as HTMLInputElement;

    await user.type(input, "半身立绘");
    expect(screen.getByTestId("value")).toHaveTextContent("半身立绘");
    // 没有任何预设处于选中态
    expect(within(group()).getAllByRole("button").every((b) => b.getAttribute("aria-pressed") === "false")).toBe(true);
  });

  it("把输入框清空时，预设全部回到未选中", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(within(group()).getByRole("button", { name: "插画" }));
    const input = screen.getByRole("textbox");

    await user.clear(input);
    expect(screen.getByTestId("value")).toHaveTextContent("");
    expect(within(group()).getByRole("button", { name: "插画" })).toHaveAttribute("aria-pressed", "false");
  });
});
