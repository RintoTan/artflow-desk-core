import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TemplateView } from "../bridge/commands";

function tpl(
  id: string,
  name: string,
  isDefault: boolean,
  steps: string[] = ["草稿", "线稿"],
): TemplateView {
  return {
    id,
    name,
    isDefault,
    revision: 0,
    steps: steps.map((title, index) => ({ stepId: `${id}-${index}`, title, position: index })),
    stepCount: steps.length,
    usageCount: 0,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

const DEFAULT_TPL = tpl("tpl-default", "通用制作流程", true, ["草稿", "线稿", "固有色", "细化", "最终调整"]);
const SPARE_TPL = tpl("tpl-spare", "简版流程", false, ["草图", "上色"]);

const remove = vi.fn(async () => [DEFAULT_TPL]);
const list = vi.fn(async () => [DEFAULT_TPL, SPARE_TPL]);

vi.mock("../bridge/commands", async () => {
  const actual = await vi.importActual<typeof import("../bridge/commands")>(
    "../bridge/commands",
  );
  return {
    ...actual,
    templateApi: {
      list,
      create: vi.fn(),
      update: vi.fn(),
      duplicate: vi.fn(),
      remove,
      setDefault: vi.fn(),
    },
  };
});

async function setup() {
  const { default: TemplatesPage } = await import("./TemplatesPage");
  render(<TemplatesPage />);
  await screen.findByRole("button", { name: /通用制作流程/ });
}

async function selectTemplate(user: ReturnType<typeof userEvent.setup>, name: string) {
  const row = screen.getByRole("button", { name: new RegExp(name) });
  await user.click(row);
}

describe("模板删除确认", () => {
  beforeEach(() => {
    remove.mockClear();
    remove.mockImplementation(async () => [DEFAULT_TPL]);
    list.mockClear();
    list.mockImplementation(async () => [DEFAULT_TPL, SPARE_TPL]);
  });

  it("点击删除但未确认时，模板仍在且没有调用删除命令", async () => {
    const user = userEvent.setup();
    await setup();
    await selectTemplate(user, "简版流程");

    await user.click(screen.getByRole("button", { name: "删除模板…" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("确认删除流程模板？");
    expect(dialog).toHaveTextContent("简版流程");
    expect(dialog).toHaveTextContent("不会改变已经创建订单");
    expect(remove).not.toHaveBeenCalled();
  });

  it("取消不删除", async () => {
    const user = userEvent.setup();
    await setup();
    await selectTemplate(user, "简版流程");

    await user.click(screen.getByRole("button", { name: "删除模板…" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(remove).not.toHaveBeenCalled();
  });

  it("Esc 不删除", async () => {
    const user = userEvent.setup();
    await setup();
    await selectTemplate(user, "简版流程");

    await user.click(screen.getByRole("button", { name: "删除模板…" }));
    await screen.findByRole("alertdialog");
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(remove).not.toHaveBeenCalled();
  });

  it("默认焦点在取消上", async () => {
    const user = userEvent.setup();
    await setup();
    await selectTemplate(user, "简版流程");

    await user.click(screen.getByRole("button", { name: "删除模板…" }));
    await screen.findByRole("alertdialog");

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "取消" })).toHaveFocus(),
    );
  });

  it("确认后删除普通模板，且不传替代默认模板", async () => {
    const user = userEvent.setup();
    await setup();
    await selectTemplate(user, "简版流程");

    await user.click(screen.getByRole("button", { name: "删除模板…" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect(remove).toHaveBeenCalledWith({
      templateId: SPARE_TPL.id,
      expectedRevision: 0,
      replacementDefaultId: null,
    });
  });

  it("删除默认模板时必须选择替代模板，未选时确认按钮禁用", async () => {
    const user = userEvent.setup();
    await setup();
    await selectTemplate(user, "通用制作流程");

    await user.click(screen.getByRole("button", { name: "删除模板…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("请先选择替代的默认模板");

    // 默认已预选一个候选，先清空制造"未选择"状态
    const select = within(dialog).getByRole("combobox");
    await user.selectOptions(select, "");
    expect(screen.getByRole("button", { name: "确认删除" })).toBeDisabled();
    expect(remove).not.toHaveBeenCalled();

    // 选择一个有效替代后可以提交
    await user.selectOptions(select, SPARE_TPL.id);
    await user.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect(remove).toHaveBeenCalledWith({
      templateId: DEFAULT_TPL.id,
      expectedRevision: 0,
      replacementDefaultId: SPARE_TPL.id,
    });
  });

  it("删除默认模板后列表里仍恰好有一个默认模板", async () => {
    const user = userEvent.setup();
    remove.mockImplementation(async () => [tpl(SPARE_TPL.id, SPARE_TPL.name, true, ["草图", "上色"])]);
    await setup();
    await selectTemplate(user, "通用制作流程");

    await user.click(screen.getByRole("button", { name: "删除模板…" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    const defaults = screen.getAllByText("默认");
    expect(defaults).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /通用制作流程/ })).not.toBeInTheDocument();
  });

  it("删除失败时不关闭对话框，也不误报成功", async () => {
    const user = userEvent.setup();
    remove.mockRejectedValue({ code: "CONFLICT", message: "模板已被修改，请刷新后重试" });
    await setup();
    await selectTemplate(user, "简版流程");

    await user.click(screen.getByRole("button", { name: "删除模板…" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("模板已被修改"),
    );
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.queryByText(/已删除/)).not.toBeInTheDocument();
  });

  it("确认期间重复点击只提交一次", async () => {
    const user = userEvent.setup();
    const pending: { resolve?: (v: TemplateView[]) => void } = {};
    remove.mockImplementation(
      () =>
        new Promise<TemplateView[]>((resolve) => {
          pending.resolve = resolve;
        }),
    );
    await setup();
    await selectTemplate(user, "简版流程");

    await user.click(screen.getByRole("button", { name: "删除模板…" }));
    await screen.findByRole("alertdialog");
    const confirm = screen.getByRole("button", { name: "确认删除" });
    await user.click(confirm);
    await user.click(confirm);

    expect(remove).toHaveBeenCalledTimes(1);
    pending.resolve?.([DEFAULT_TPL]);
  });
});
