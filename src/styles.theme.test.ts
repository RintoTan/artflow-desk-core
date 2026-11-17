import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 样式回归守卫：防止"浅底浅字"再次出现。
 *
 * 上一轮的缺陷不是某个颜色写错，而是一整类：结构性背景（侧边栏、说明面板、
 * 状态卡片）用了写死的浅色，文字却走主题令牌，深色下就成了浅底浅字。
 * 所以这里直接扫 CSS 源码，而不是渲染组件——jsdom 没有层叠计算，
 * 靠渲染断言根本发现不了这类问题。
 */
const raw = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
// 注释里也会出现 { } 和 var(--x)，解析前先剥掉，避免污染选择器与令牌扫描。
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

type Rule = { selector: string; body: string };

function parseRules(source: string): Rule[] {
  const rules: Rule[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const selector = (match[1] ?? "").trim();
    const body = match[2] ?? "";
    if (!selector || selector.startsWith("@")) continue;
    rules.push({ selector, body });
  }
  return rules;
}

const rules = parseRules(css);

function declarations(body: string): { prop: string; value: string }[] {
  return body
    .split(";")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const index = chunk.indexOf(":");
      return { prop: chunk.slice(0, index).trim(), value: chunk.slice(index + 1).trim() };
    })
    .filter((item) => item.prop.length > 0);
}

function tokensOf(selector: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rule of rules.filter((item) => item.selector === selector)) {
    for (const decl of declarations(rule.body)) {
      if (decl.prop.startsWith("--")) map.set(decl.prop, decl.value);
    }
  }
  return map;
}

const lightTokens = tokensOf(":root");
const darkTokens = tokensOf('[data-theme="dark"]');

function luminance(hex: string): number {
  const clean = hex.replace("#", "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  const channels = [0, 2, 4].map((i) => {
    const v = parseInt(full.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

/** 结构性背景：这些令牌必须两套主题都有，否则深色会退回浅色值。 */
const STRUCTURAL_TOKENS = [
  "--sidebar-bg",
  "--panel-quiet-bg",
  "--tone-accent-bg",
  "--tone-warn-bg",
  "--tone-danger-bg",
  "--chip-today-bg",
  "--chip-neutral-bg",
];

describe("主题令牌完整性", () => {
  it("每个结构性命中都在深色主题里单独定义过", () => {
    for (const token of STRUCTURAL_TOKENS) {
      expect(lightTokens.has(token), `${token} 未在 :root 定义`).toBe(true);
      expect(darkTokens.has(token), `${token} 缺少深色定义`).toBe(true);
      expect(darkTokens.get(token)).not.toBe(lightTokens.get(token));
    }
  });

  it("页面里用到的 var(--x) 都有定义", () => {
    const used = new Set<string>();
    for (const rule of rules) {
      for (const decl of declarations(rule.body)) {
        const found = decl.value.matchAll(/var\((--[a-z0-9-]+)/gi);
        for (const hit of found) used.add(hit[1] ?? "");
      }
    }
    // 局部定义也算数：--plot-h 之类是图表组件自己的尺寸常量，
    // 故意不放进 :root（改了它只影响图表）。这里只拦"用了但根本没定义"。
    const localTokens = new Set(
      [...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((hit) => hit[1] ?? ""),
    );
    for (const token of used) {
      expect(
        lightTokens.has(token) || darkTokens.has(token) || localTokens.has(token),
        `${token} 未定义`,
      ).toBe(true);
    }
  });
});

describe("深色下不允许出现写死的浅色背景", () => {
  // :root 与深色块本身就是在定义颜色，跳过。
  const exempt = new Set([":root", '[data-theme="dark"]']);

  it("规则里的 background 不得直接写浅色字面量", () => {
    const offenders: string[] = [];

    for (const rule of rules) {
      if (exempt.has(rule.selector)) continue;
      for (const decl of declarations(rule.body)) {
        if (decl.prop !== "background" && decl.prop !== "background-color") continue;
        const value = decl.value;

        // 半透明白用来做"叠加层"是安全的（查看器按钮底），只要不透明度够低
        const whites = [...value.matchAll(/rgba\(\s*255,\s*255,\s*255,\s*([0-9.]+)\s*\)/g)];
        for (const hit of whites) {
          if (Number(hit[1]) > 0.4) offenders.push(`${rule.selector} → ${value}`);
        }

        for (const hit of value.matchAll(/#([0-9a-f]{3,8})\b/gi)) {
          const hex = hit[1] ?? "";
          if (hex.length !== 3 && hex.length !== 6) continue;
          if (luminance(`#${hex}`) > 0.7) {
            offenders.push(`${rule.selector} → ${value}`);
          }
        }
      }
    }

    expect(offenders, `这些背景在深色下会变成浅底浅字：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("侧边栏与说明面板使用令牌而不是字面量", () => {
    const sidebar = rules.find((rule) => rule.selector === ".sidebar");
    expect(sidebar?.body).toContain("var(--sidebar-bg)");

    const quiet = rules.find((rule) => rule.selector === ".panel-quiet");
    expect(quiet?.body).toContain("var(--panel-quiet-bg)");

    for (const selector of [".tone-warn", ".tone-danger", ".tone-accent"]) {
      const rule = rules.find((item) => item.selector === selector);
      expect(rule?.body, `${selector} 应使用语义令牌`).toMatch(/var\(--tone-(warn|danger|accent)-bg\)/);
    }
  });
});
