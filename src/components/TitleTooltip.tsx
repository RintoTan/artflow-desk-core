import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * 长标题的应用内提示。
 *
 * 为什么不用原生 `title`：截断是用 `-webkit-line-clamp` 做的，文字被裁在
 * 一个 overflow:hidden 的盒子里，WKWebView 在这个组合下（尤其是行内元素嵌在
 * <button> 里时）并不会稳定弹出原生 tooltip。用户实机截图已证实：悬停无反应。
 *
 * 这里改成自绘气泡：
 *   - 只在真的被截断时出现，短标题永不弹；
 *   - 有显示延迟，鼠标扫过列表不会满屏闪；
 *   - portal 到 body + position:fixed，不会被列表滚动容器裁切；
 *   - 指针事件穿透，不影响点击、拖动排序与键盘导航。
 */

const SHOW_DELAY_MS = 450;
const GAP = 8;
const EDGE = 8;

/**
 * -webkit-line-clamp 的盒子量不出溢出：scrollHeight 恒等于裁剪后的高度，
 * Range.getClientRects() 也只返回保留的那两行（实测 36 / 36 / 2 行）。
 * 所以只能复制一份去掉行数限制的克隆，按同宽量真实高度。
 */
export const titleMetrics = {
  fullHeight(el: HTMLElement): number {
    const host = el.closest("li") ?? el.parentElement ?? document.body;
    const clone = el.cloneNode(true) as HTMLElement;
    clone.setAttribute("aria-hidden", "true");
    Object.assign(clone.style, {
      position: "absolute",
      visibility: "hidden",
      pointerEvents: "none",
      left: "0",
      top: "0",
      width: `${el.clientWidth}px`,
      height: "auto",
      maxHeight: "none",
      display: "block",
      overflow: "visible",
    });
    clone.style.setProperty("-webkit-line-clamp", "unset");
    clone.style.setProperty("-webkit-box-orient", "initial");
    host.appendChild(clone);
    const full = clone.getBoundingClientRect().height;
    host.removeChild(clone);
    return full;
  },
};

/** 单独导出便于直接断言：完全高度超过按钮盒高度即视为被截断。 */
export function isTruncated(el: { clientHeight: number }, fullHeight: number): boolean {
  return fullHeight > el.clientHeight + 1;
}

export type TooltipPlacement = "top" | "bottom";

export function placeTooltip(
  trigger: { x: number; y: number; w: number; h: number },
  size: { w: number; h: number },
  viewport: { width: number; height: number },
): { top: number; left: number; placement: TooltipPlacement } {
  const below = trigger.y + trigger.h + GAP;
  const above = trigger.y - GAP - size.h;
  // 优先放下方；下方放不下且上方放得下才翻上去。
  const placement: TooltipPlacement =
    below + size.h <= viewport.height - EDGE || above < EDGE ? "bottom" : "top";
  const rawTop = placement === "bottom" ? below : above;
  const maxTop = Math.max(EDGE, viewport.height - EDGE - size.h);
  const top = Math.min(Math.max(rawTop, EDGE), maxTop);

  const centered = trigger.x + (trigger.w - size.w) / 2;
  const maxLeft = Math.max(EDGE, viewport.width - EDGE - size.w);
  const left = Math.min(Math.max(centered, EDGE), maxLeft);

  return { top, left, placement };
}

type Props = {
  text: string;
  className?: string;
  children?: React.ReactNode;
};

export function TruncatedTitle({ text, className, children }: Props) {
  const tipId = useId();
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; placement: TooltipPlacement } | null>(
    null,
  );

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const close = useCallback(() => {
    clearTimer();
    setOpen(false);
    setPos(null);
  }, [clearTimer]);

  const openIfTruncated = useCallback(() => {
    const el = anchorRef.current;
    if (!el || !isTruncated(el, titleMetrics.fullHeight(el))) return;
    clearTimer();
    timer.current = window.setTimeout(() => setOpen(true), SHOW_DELAY_MS);
  }, [clearTimer]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  // 键盘：焦点落在整行的 <button> 上，所以监听按钮而不是这个 span。
  useEffect(() => {
    const host = anchorRef.current?.closest("button");
    if (!host) return;
    const onFocus = () => openIfTruncated();
    const onBlur = () => close();
    host.addEventListener("focus", onFocus);
    host.addEventListener("blur", onBlur);
    return () => {
      host.removeEventListener("focus", onFocus);
      host.removeEventListener("blur", onBlur);
    };
  }, [openIfTruncated, close]);

  // 键盘用户听到的是 describedby，而不是只有一张悬停才出现的浮层。
  useEffect(() => {
    const host = anchorRef.current?.closest("button");
    if (!host || !open) return;
    host.setAttribute("aria-describedby", tipId);
    return () => host.removeAttribute("aria-describedby");
  }, [open, tipId]);

  // 滚动、改窗口大小、Esc、窗口失焦都立刻收起：气泡不能停在旧位置。
  useEffect(() => {
    if (!open) return;
    const onScroll = () => close();
    const onResize = () => close();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onResize);
    };
  }, [open, close]);

  // 先渲染再量尺寸，避免用估算宽度算错左右边界。
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const tip = tipRef.current;
    if (!anchor || !tip) return;
    const a = anchor.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const next = placeTooltip(
      { x: a.x, y: a.y, w: a.width, h: a.height },
      { w: t.width, h: t.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPos((current) =>
      current && current.top === next.top && current.left === next.left
        ? current
        : next,
    );
  }, [open, text]);

  return (
    <>
      <span
        ref={anchorRef}
        className={className}
        onPointerEnter={openIfTruncated}
        onPointerLeave={close}
      >
        {children ?? text}
      </span>
      {open
        ? createPortal(
            <div
              ref={tipRef}
              className="title-tooltip"
              id={tipId}
              role="tooltip"
              data-placement={pos?.placement ?? "bottom"}
              style={
                pos
                  ? { top: `${pos.top}px`, left: `${pos.left}px` }
                  : { top: 0, left: 0, visibility: "hidden" }
              }
            >
              {text}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
