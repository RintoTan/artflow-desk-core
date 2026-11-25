import { useEffect, useRef } from "react";

import { topLayer } from "./layers";
import { topModal } from "./modalStack";

export type PageShortcuts = {
  /** Cmd/Ctrl+N：新建（页面不支持时不要传，避免"按了没反应"以外还吞掉默认行为） */
  onNew?: () => void;
  /** Cmd/Ctrl+S：保存当前可保存的内容 */
  onSave?: () => void;
  /** Cmd/Ctrl+F：聚焦本页搜索框 */
  onFocusSearch?: () => void;
  /** 上下方向键移动列表选择 */
  onMoveSelection?: (delta: 1 | -1) => void;
  /** Enter 打开当前选择 */
  onOpenSelection?: () => void;
};

/** 文本输入类元素：方向键属于光标移动，不能拿去切订单。 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (target as HTMLInputElement).type;
  return !["checkbox", "radio", "button", "submit", "reset", "range", "color"].includes(type);
}

/**
 * 页面级快捷键。
 *
 * 约定（都写在测试里）：
 * - 有模态打开时整页快捷键失效，底层页面不得抢键；
 * - 正在输入文本时方向键/Enter 不触发列表导航；
 * - Cmd+N / Cmd+S 由页面自己的 busy 状态保证不重复执行；
 * - 事件已被更内层处理（defaultPrevented）或正在输入法组合（isComposing）时直接返回。
 */
export function usePageShortcuts(bindings: PageShortcuts, enabled = true): void {
  const ref = useRef(bindings);
  ref.current = bindings;

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      // 任何模态（包括关窗确认）打开时，页面快捷键一律不执行。
      if (topModal() !== null) return;
      // 右键菜单这类非模态浮层同样要独占键盘：开着菜单还让 ⌘N 之类穿透，
      // 等于在用户看着一份菜单时替他打开了别的东西。
      if (topLayer() !== null) return;

      const handler = ref.current;
      const mod = event.metaKey || event.ctrlKey;

      if (mod && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === "n" && handler.onNew) {
          event.preventDefault();
          handler.onNew();
          return;
        }
        if (key === "s" && handler.onSave) {
          event.preventDefault();
          handler.onSave();
          return;
        }
        if (key === "f" && handler.onFocusSearch) {
          event.preventDefault();
          handler.onFocusSearch();
        }
        return;
      }

      if (mod || event.altKey) return;
      if (isEditableTarget(event.target)) return;

      if (event.key === "ArrowDown" && handler.onMoveSelection) {
        event.preventDefault();
        handler.onMoveSelection(1);
        return;
      }
      if (event.key === "ArrowUp" && handler.onMoveSelection) {
        event.preventDefault();
        handler.onMoveSelection(-1);
        return;
      }
      if (event.key === "Enter" && handler.onOpenSelection) {
        event.preventDefault();
        handler.onOpenSelection();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
