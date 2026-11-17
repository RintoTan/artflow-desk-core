import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("测试环境", () => {
  it("可以渲染 DOM 并使用 jest-dom 断言", () => {
    render(<p>你好</p>);
    expect(screen.getByText("你好")).toBeInTheDocument();
  });
});
