import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CHOICE,
  applyTheme,
  checkAccent,
  contrastRatio,
  contrastTextOn,
  normalizeAccent,
  normalizeMode,
  resetThemeForTests,
  resolveTheme,
  softAccent,
} from "./theme";

afterEach(() => {
  resetThemeForTests();
});

describe("主题模式", () => {
  it("非法模式回退到 arctic，跟随系统原样保留", () => {
    expect(normalizeMode("dark")).toBe("dark");
    expect(normalizeMode("system")).toBe("system");
    expect(normalizeMode("solarized")).toBe("arctic");
    expect(normalizeMode(null)).toBe("arctic");
  });

  it("system 的解析取决于系统偏好，而不是记住上次结果", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("arctic");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("arctic", true)).toBe("arctic");
  });
});

describe("强调色", () => {
  it("只接受 #rrggbb", () => {
    expect(normalizeAccent("#1A2B3C")).toBe("#1a2b3c");
    expect(normalizeAccent("  #ffffff ")).toBe("#ffffff");
    expect(normalizeAccent("red")).toBeNull();
    expect(normalizeAccent("#12345")).toBeNull();
    expect(normalizeAccent("")).toBeNull();
    expect(normalizeAccent(null)).toBeNull();
  });

  it("对比度符合 WCAG 公式", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 1);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 2);
  });

  it("挑文字颜色时选对比更高的那一个", () => {
    expect(contrastTextOn("#ffffff")).toBe("#16283c");
    expect(contrastTextOn("#111111")).toBe("#ffffff");
  });

  it("浅色强调色会给出可读性警告", () => {
    const check = checkAccent("#ffe9a8", "arctic");
    expect(check?.level).toBe("warn");
    expect(check?.message).toContain("对比度");
  });

  it("正常强调色不报警", () => {
    const check = checkAccent("#2c6fb5", "arctic");
    expect(check?.level).toBe("ok");
    expect(check?.message).toBeNull();
  });

  it("soft 背景跟着主题深浅走", () => {
    expect(softAccent("#2c6fb5", "arctic")).toMatch(/^rgb/);
    expect(softAccent("#2c6fb5", "dark")).toMatch(/^rgb/);
    expect(softAccent("#2c6fb5", "dark")).not.toBe(softAccent("#2c6fb5", "arctic"));
  });
});

describe("applyTheme", () => {
  it("写入 data-theme，并在无自定义色时清掉内联变量", () => {
    const root = document.createElement("div");
    root.style.setProperty("--accent", "#ff0000");

    applyTheme(root, { mode: "dark", accent: null }, false);

    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(root.style.getPropertyValue("--accent")).toBe("");
  });

  it("有自定义色时写入三个强调色变量", () => {
    const root = document.createElement("div");
    applyTheme(root, { mode: "system", accent: "#7b5cff" }, true);

    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(root.style.getPropertyValue("--accent")).toBe("#7b5cff");
    expect(root.style.getPropertyValue("--accent-soft")).toMatch(/^rgb/);
    expect(["#ffffff", "#16283c"]).toContain(
      root.style.getPropertyValue("--accent-contrast"),
    );
  });

  it("默认选择是 Arctic Blue", () => {
    expect(DEFAULT_CHOICE).toEqual({ mode: "arctic", accent: null });
    const root = document.createElement("div");
    applyTheme(root, DEFAULT_CHOICE, true);
    expect(root.getAttribute("data-theme")).toBe("arctic");
  });
});
