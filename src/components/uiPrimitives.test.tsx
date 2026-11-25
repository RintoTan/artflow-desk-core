import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import EmptyState from "./EmptyState";
import Notice from "./Notice";
import PageHeader from "./PageHeader";

/**
 * 三个共享组件的契约。
 *
 * 这里刻意只测**语义与结构**：颜色和留白由 CSS 决定，jsdom 不参与层叠计算，
 * 断言 `getComputedStyle` 只会测到默认值，属于空转。真正的观感留给原生 QA。
 */
describe("Notice", () => {
  it("error 用 alert 角色，会打断播报", () => {
    render(<Notice variant="error">保存失败</Notice>);
    const node = screen.getByRole("alert");
    expect(node.textContent).toBe("保存失败");
    expect(node.className).toContain("notice-error");
  });

  it("ok 与 warn 用 status 角色，不打断", () => {
    const { rerender } = render(<Notice variant="ok">已保存</Notice>);
    expect(screen.getByRole("status").className).toContain("notice-ok");

    rerender(<Notice variant="warn">有 2 条待处理</Notice>);
    expect(screen.getByRole("status").className).toContain("notice-warn");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("可以在不改配色的前提下追加局部类名", () => {
    render(
      <Notice variant="error" className="notice-inline">
        出错了
      </Notice>,
    );
    const node = screen.getByRole("alert");
    expect(node.className).toContain("notice-error");
    expect(node.className).toContain("notice-inline");
  });
});

describe("EmptyState", () => {
  it("只有标题时不渲染说明与操作", () => {
    const { container } = render(<EmptyState title="还没有订单" />);
    expect(screen.getByText("还没有订单")).toBeTruthy();
    expect(container.querySelector(".empty-state-desc")).toBeNull();
    expect(container.querySelector(".empty-state-action")).toBeNull();
  });

  it("标题 + 说明", () => {
    render(<EmptyState title="还没有付款计划" description="没有计划也可以直接记录收款。" />);
    expect(screen.getByText("还没有付款计划")).toBeTruthy();
    expect(screen.getByText("没有计划也可以直接记录收款。")).toBeTruthy();
  });

  it("带操作按钮时保留入口可点", () => {
    render(
      <EmptyState title="还没有订单" action={<button type="button">新建订单</button>} />,
    );
    expect(screen.getByRole("button", { name: "新建订单" })).toBeTruthy();
  });

  it("inline 变体用于单元格内的紧凑位置", () => {
    const { container } = render(<EmptyState inline title="暂无" />);
    expect(container.querySelector(".empty-state")?.className).toContain("empty-state-inline");
  });
});

describe("PageHeader", () => {
  it("标题是一个 h1，副标题可选", () => {
    const { rerender } = render(<PageHeader title="订单" />);
    expect(screen.getByRole("heading", { level: 1, name: "订单" })).toBeTruthy();

    rerender(<PageHeader title="订单" description="管理委托与制作进度" />);
    expect(screen.getByText("管理委托与制作进度")).toBeTruthy();
  });

  it("右侧操作区原样渲染，不改变按钮顺序", () => {
    render(
      <PageHeader
        title="统计"
        actions={
          <>
            <button type="button">导出</button>
            <button type="button">刷新</button>
          </>
        }
      />,
    );
    const buttons = screen.getAllByRole("button").map((node) => node.textContent);
    expect(buttons).toEqual(["导出", "刷新"]);
  });

  it("外壳类名透传，页面既有的布局规则继续生效", () => {
    const { container } = render(
      <PageHeader className="stats-toolbar" textClassName="stats-heading" title="数据统计" />,
    );
    const header = container.querySelector("header");
    expect(header?.className).toContain("stats-toolbar");
    expect(container.querySelector(".stats-heading")).toBeTruthy();
  });
});
