import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 布局回归守卫。
 *
 * jsdom 不做排版，任何"元素没重叠"的 DOM 断言都是假的。所以这里只验证
 * **规则本身**：单栏降级存在、粘性定位在窄容器里被解除、命中区域够大。
 * 真实是否重叠仍要人眼看截图。
 */
const raw = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

/** 取从 marker 开始的整块（按大括号配对），用于 @container 这种嵌套块。 */
function blockAt(marker: string): string {
  const start = css.indexOf(marker);
  if (start < 0) return "";
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return "";
}

function rule(selector: string): string {
  const pattern = new RegExp(`(^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  return pattern.exec(css)?.[2] ?? "";
}

describe("窄窗口布局降级", () => {
  it("主内容区是内容宽度容器，而不是按窗口宽度猜", () => {
    expect(rule(".main")).toContain("container-type: inline-size");
  });

  it("内容区不足 780px 时两栏改单栏，并解除列表粘性定位", () => {
    const narrow = blockAt("@container workspace (max-width: 780px)");
    expect(narrow, "缺少 780px 的容器查询").not.toBe("");
    expect(narrow).toMatch(/\.orders-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(narrow).toMatch(/\.orders-list\s*\{[^}]*position:\s*static/);
  });

  it("再窄一档会把表单网格压成单列", () => {
    const tighter = blockAt("@container workspace (max-width: 560px)");
    expect(tighter).not.toBe("");
    expect(tighter).toMatch(/\.form-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it("不支持容器查询时退化为窗口宽度判断", () => {
    expect(css).toContain("@supports not (container-type: inline-size)");
    expect(blockAt("@media (max-width: 1120px)")).toMatch(/\.orders-layout/);
  });

  it("没有用裁切/隐藏横向溢出来掩盖重叠", () => {
    const main = rule(".main");
    expect(main).not.toContain("overflow-x: hidden");
    const layout = rule(".orders-layout");
    expect(layout).not.toContain("overflow: hidden");
    expect(css).not.toContain("body { overflow-x: hidden");
  });
});

describe("导航命中区域", () => {
  it("导航项高度不小于 44px", () => {
    expect(rule(".nav-item")).toMatch(/min-height:\s*44px/);
  });

  it("折叠后每个导航按钮至少 44×44", () => {
    expect(css).toMatch(/\.shell-sidebar-collapsed\s+\.nav-item\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/s);
  });

  it("折叠按钮本身也够大，图标统一 20px", () => {
    expect(css).toMatch(/\.shell-sidebar-collapsed\s+\.sidebar-collapse\s*\{[^}]*min-width:\s*44px/s);
    expect(rule(".nav-icon")).toMatch(/width:\s*20px/);
    expect(rule(".nav-icon")).toMatch(/height:\s*20px/);
  });
});
