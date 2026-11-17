import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 图表配色的对比度守卫。
 *
 * 上一版是硬编码的 #9fb6cb / #d9b3a8，对白色面板只有 2.1:1 与 1.9:1，
 * 低于图形元素 3:1 的下限。这里直接从 CSS 里读色值算，改回去就会失败。
 */

const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `找不到 ${selector}`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("}", start));
}

function token(selector: string, name: string): string {
  const value = new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(block(selector))?.[1];
  expect(value, `${selector} 缺少 --${name}`).toBeTruthy();
  return value!;
}

function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
  const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(channels[0]!) + 0.7152 * linear(channels[1]!) + 0.0722 * linear(channels[2]!);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const SERIES = ["chart-created", "chart-completed", "chart-cancelled"];

describe("图表柱子对比度", () => {
  for (const selector of [":root", '[data-theme="dark"]']) {
    const label = selector === ":root" ? "浅色" : "深色";

    it(`${label}主题：三根柱子对面板底色都不低于 3:1`, () => {
      const surface = token(selector, "surface");
      for (const name of SERIES) {
        const ratio = contrast(token(selector, name), surface);
        expect(ratio, `${label} --${name} 只有 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
      }
    });

    it(`${label}主题：三根柱子彼此可区分`, () => {
      const values = SERIES.map((name) => token(selector, name));
      expect(new Set(values).size).toBe(3);
    });

    it(`${label}主题：网格线不抢柱子`, () => {
      const ratio = contrast(token(selector, "chart-grid"), token(selector, "surface"));
      expect(ratio).toBeLessThan(1.6);
    });
  }

  it("柱子不再写死颜色，全部走令牌", () => {
    const rules = ["bar-created", "bar-completed", "bar-cancelled"].map((cls) => {
      const start = css.indexOf(`.${cls} {`);
      expect(start, `.${cls} 规则不存在`).toBeGreaterThan(-1);
      return css.slice(start, css.indexOf("}", start));
    });
    for (const rule of rules) {
      expect(rule).toContain("var(--chart-");
      expect(rule).not.toMatch(/#[0-9A-Fa-f]{6}/);
    }
  });

  it("零值用中性边框色，不是某一类柱子的颜色", () => {
    const start = css.indexOf(".bar-zero {");
    const rule = css.slice(start, css.indexOf("}", start));
    expect(rule).toContain("var(--border)");
    expect(rule).toMatch(/height:\s*2px/);
  });
});
