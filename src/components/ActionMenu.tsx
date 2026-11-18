import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * 操作栏「更多操作」菜单。
 *
 * 用受控状态 + portal 实现，而不是原生 <details>：
 * details 不会因外部点击或 Escape 关闭，也无法把菜单放到滚动容器外面。
 * 菜单用 fixed 定位，打开时按触发按钮的位置计算，空间不足就向上翻。
 */
export default function ActionMenu({
  label = "更多操作",
  children,
  disabled = false,
}: {
  label?: string;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const menuHeight = menu?.offsetHeight ?? 0;
    const menuWidth = menu?.offsetWidth ?? 200;
    const gap = 6;
    const below = rect.bottom + gap;
    const fitsBelow = below + menuHeight <= window.innerHeight - 8;
    const top = fitsBelow ? below : Math.max(8, rect.top - gap - menuHeight);
    const left = Math.min(
      Math.max(8, rect.right - menuWidth),
      Math.max(8, window.innerWidth - menuWidth - 8),
    );
    setCoords({ top, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close(true);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  // 滚动或窗口尺寸变化时菜单会脱离按钮，直接关掉比跟着乱飘更可预期。
  useEffect(() => {
    if (!open) return;
    const onScroll = () => close(false);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, close]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="btn action-more-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            className="action-menu"
            role="menu"
            aria-label={label}
            style={coords ? { top: coords.top, left: coords.left } : { top: -9999, left: -9999 }}
          >
            <div
              className="action-menu-inner"
              onClick={(event) => {
                // 点中可用的操作项后收起菜单；禁用项保持打开，方便看到原因。
                const target = event.target as HTMLElement;
                if (target.closest("button:not(:disabled)")) close(false);
              }}
            >
              {children}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
