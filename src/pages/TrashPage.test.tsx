import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import TrashPage from "./TrashPage";

describe("回收站页面骨架", () => {
  it("渲染标题与说明，并明示尚未接入", () => {
    render(<TrashPage />);
    expect(screen.getByRole("heading", { name: "回收站" })).toBeInTheDocument();
    expect(screen.getByText(/直到你手动清空/)).toBeInTheDocument();
    // 本阶段没有真实数据：宁可写明「待接入」，也不画一个假的空态。
    expect(screen.getByText("待接入")).toBeInTheDocument();
  });
});
