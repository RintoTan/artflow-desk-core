import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { iconAsset } from "../lib/appIcon";
import { AppIconImage } from "./AppIconImage";

function img(container: HTMLElement) {
  return container.querySelector("img") as HTMLImageElement;
}

describe("应用图标资源回退", () => {
  it("按变体与外观取图", () => {
    const { container } = render(
      <AppIconImage variant="layers" appearance="dark" size={64} />,
    );
    const el = img(container);
    expect(el.getAttribute("src")).toBe(iconAsset("layers", "dark"));
    expect(el.dataset.iconVariant).toBe("layers");
    expect(el.dataset.iconAppearance).toBe("dark");
    expect(el.getAttribute("width")).toBe("64");
    // 纯装饰：旁边已有文字时不该被读屏重复念出来
    expect(el.getAttribute("aria-hidden")).toBe("true");
  });

  it("传了 alt 就不隐藏", () => {
    const { container } = render(
      <AppIconImage variant="orbit" appearance="light" size={32} alt="Orbit" />,
    );
    expect(img(container).getAttribute("alt")).toBe("Orbit");
    expect(img(container).getAttribute("aria-hidden")).toBeNull();
  });

  it("图片加载失败时回退到**同一外观**的 Orbit，而不是另一套配色", () => {
    const { container } = render(
      <AppIconImage variant="wave-a" appearance="dark" size={64} />,
    );
    fireEvent.error(img(container));

    const el = img(container);
    expect(el.dataset.iconFallback).toBe("orbit");
    expect(el.getAttribute("src")).toBe(iconAsset("orbit", "dark"));
    // 深色界面上不能突然出现一块浅色底
    expect(el.dataset.iconAppearance).toBe("dark");
  });

  it("换外观后重新给一次加载机会", () => {
    const { container, rerender } = render(
      <AppIconImage variant="layers" appearance="light" size={64} />,
    );
    fireEvent.error(img(container));
    expect(img(container).dataset.iconFallback).toBe("orbit");

    rerender(<AppIconImage variant="layers" appearance="dark" size={64} />);
    expect(img(container).dataset.iconFallback).toBeUndefined();
    expect(img(container).getAttribute("src")).toBe(iconAsset("layers", "dark"));
  });
});
