import { render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientView } from "../bridge/commands";

const state = vi.hoisted(() => ({
  created: [] as ClientView[],
  create: vi.fn(),
}));

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>("../bridge/commands");
  return {
    ...actual,
    clientApi: {
      create: (input: { displayName: string }) => state.create(input),
    },
  };
});

const { default: ClientPicker } = await import("./ClientPicker");

function client(id: string, name: string): ClientView {
  return {
    id,
    displayName: name,
    contact: null,
    note: null,
    revision: 0,
    orderCount: 1,
    activeCount: 1,
    completedCount: 0,
    knownAmountCents: 0,
    lastOrderAt: null,
    tags: [],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  } as ClientView;
}

const CLIENTS = [client("c1", "林三"), client("c2", "王五")];

beforeEach(() => {
  state.created = [];
  state.create = vi.fn(async (input: { displayName: string }) => {
    const created = client("c9", input.displayName);
    state.created.push(created);
    return created;
  });
});

/** 受控包装：把当前值显示出来，验证 onChange 真的生效。 */
function Harness({ initial = null as string | null, showCreate = false }) {
  const [value, setValue] = useState<string | null>(initial);
  const [clients, setClients] = useState<ClientView[]>(CLIENTS);
  return (
    <div>
      <ClientPicker
        id="picker"
        clients={clients}
        value={value}
        onChange={setValue}
        onClientCreated={showCreate ? (c) => setClients((list) => [...list, c]) : undefined}
      />
      <output data-testid="value">{value ?? "none"}</output>
    </div>
  );
}

describe("客户选择器", () => {
  it("默认是不关联客户，展开后能选已有客户", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("combobox", { name: "客户" });
    expect(trigger).toHaveTextContent("不关联客户");

    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: "王五" }));

    expect(screen.getByTestId("value")).toHaveTextContent("c2");
    expect(trigger).toHaveTextContent("王五");
  });

  it("输入关键词实时过滤", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("combobox", { name: "客户" }));
    await user.type(screen.getByLabelText("搜索客户"), "王");

    const options = within(screen.getByRole("listbox", { name: "客户选项" })).getAllByRole("option");
    // 末尾带上新建入口：搜不到同名客户时可以直接建
    expect(options.map((option) => option.textContent)).toEqual(["不关联客户", "王五", "新建客户「王」"]);
  });

  it("搜索不到时提供新建，建完自动选中", async () => {
    const user = userEvent.setup();
    render(<Harness showCreate />);
    await user.click(screen.getByRole("combobox", { name: "客户" }));
    await user.type(screen.getByLabelText("搜索客户"), "新客户甲");

    await user.click(screen.getByRole("option", { name: "新建客户「新客户甲」" }));

    await waitFor(() => expect(state.create).toHaveBeenCalledWith({ displayName: "新客户甲" }));
    expect(screen.getByTestId("value")).toHaveTextContent("c9");
    expect(screen.getByRole("combobox", { name: "客户" })).toHaveTextContent("新客户甲");
  });

  it("键盘上下移动 + 回车选中", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("combobox", { name: "客户" }));
    const search = screen.getByLabelText("搜索客户");

    await user.type(search, "{ArrowDown}{Enter}");
    // 第一项是不关联客户，向下一次到「林三」
    expect(screen.getByTestId("value")).toHaveTextContent("c1");
  });

  it("可以主动改回不关联客户", async () => {
    const user = userEvent.setup();
    render(<Harness initial="c1" />);
    expect(screen.getByRole("combobox", { name: "客户" })).toHaveTextContent("林三");

    await user.click(screen.getByRole("combobox", { name: "客户" }));
    await user.click(screen.getByRole("option", { name: "不关联客户" }));
    expect(screen.getByTestId("value")).toHaveTextContent("none");
  });
});
