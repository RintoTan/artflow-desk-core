import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { placeContextMenu } from "../lib/contextMenuPlacement";
import { isTopLayer, popLayer, pushLayer } from "../lib/layers";

export type ContextMenuItem = {
  id: string;
  label: string;
  onSelect: () => void;
  /** 破坏性操作：用危险色，和详情里的「取消订单…」保持一致。 */
  danger?: boolean;
};

type Props = {
  /** 指针的视口坐标（`clientX` / `clientY`），不是页面绝对坐标。 */
  x: number;
  y: number;
  items: ContextMenuItem[];
  label?: string;
  onClose: () => void;
};

/**
 * 按指针位置打开的菜单。
 *
 * 与 `ActionMenu` 的差别只有一个：锚点是指针坐标而不是触发按钮的矩形。
 * 视觉、关闭时机、外部点击判定全部沿用同一套（`.action-menu` 样式 + portal 到 body），
 * 所以两处菜单不会长成两种东西。`ActionMenu` 的公开 API 没有改动。
 *
 * 挂载即打开、卸载即关闭：调用方按需渲染，组件本身不持「开/关」状态，
 * 免得 open 与坐标更新不同步时先画在旧位置再跳一下。
 */
export default function ContextMenu({ x, y, items, label = "订单操作", onClose }: Props) {
  const menuId = useId();
  const layerId = `context-menu${menuId}`;
  const menuRef = useRef<HTMLDivElement | null>(null);
  // 在首次渲染时就记住「菜单打开前焦点在哪」：等 effect 跑起来时，焦点已经被
  // 下面的布局副作用搬进菜单了，那时再读只会读到菜单自己的按钮。
  const restoreRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const firstRun = useRef(true);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  // 开：登记层级、记住原来的焦点；关：退栈并把焦点还回去。
  useEffect(() => {
    pushLayer(layerId);
    return () => {
      popLayer(layerId);
      const previous = restoreRef.current;
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [layerId]);

  // 量一次菜单尺寸再定位：高度取决于条目数，算不出来就只能等渲染后量。
  useLayoutEffect(() => {
    const node = menuRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setCoords(
      placeContextMenu(
        { x, y },
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
    if (firstRun.current) {
      firstRun.current = false;
      node.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    }
  }, [x, y, items.length]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      onClose();
    };
    // Esc 只关最上层：底下还有抽屉时，这一次按键不该连它一起关掉。
    // 判层用栈而不是阻止冒泡——抽屉的监听同样挂在 document 上，且注册更早，
    // 冒泡阶段拦不住它；真正的边界是「谁在最上层」。
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!isTopLayer(layerId)) return;
      onClose();
    };
    // 菜单是 fixed 定位，跟随滚动会脱离指针，直接关掉比跟着乱飘更可预期。
    const onScrollOrResize = () => onClose();

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("contextmenu", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("contextmenu", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [layerId, onClose]);

  // 上下键在条目间移动；Tab 交给浏览器（按钮本身可聚焦）。
  const moveFocus = useCallback((delta: 1 | -1) => {
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
    );
    if (buttons.length === 0) return;
    const current = buttons.findIndex((button) => button === document.activeElement);
    const next = current < 0 ? 0 : (current + delta + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }, []);

  return createPortal(
    <div
      ref={menuRef}
      className="action-menu context-menu"
      role="menu"
      aria-label={label}
      style={coords ? { top: coords.top, left: coords.left } : { top: -9999, left: -9999 }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          moveFocus(1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          moveFocus(-1);
        }
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        className="action-menu-inner"
        onClick={(event) => {
          // 点中可用条目后收起；禁用项保持打开，方便看到原因。
          const target = event.target as HTMLElement;
          if (target.closest("button:not(:disabled)")) onClose();
        }}
      >
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`btn${item.danger ? " btn-quiet-danger" : ""}`}
            role="menuitem"
            onClick={item.onSelect}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
