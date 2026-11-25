import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { popModal, pushModal, useIsTopModal } from "../lib/modalStack";
import Notice from "./Notice";

type Props = {
  open: boolean;
  title: string;
  /** 正文说明，可以是节点（例如需要插入一个下拉选择）。 */
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** 危险操作：确认按钮使用危险色。 */
  danger?: boolean;
  /** 处理中：禁用全部操作并阻止重复提交。 */
  busy?: boolean;
  /** 失败信息，展示在对话框内且不关闭。 */
  error?: string | null;
  /** 额外条件（例如未选择替代默认模板时禁用确认）。 */
  confirmDisabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
};

const TITLE_ID = "confirm-dialog-title";
const DESC_ID = "confirm-dialog-desc";

/**
 * 通用确认对话框。
 *
 * 为什么不用 `window.confirm`：在 Tauri 的 WKWebView 里它是空实现，
 * 调用会**直接返回真值**——删除确认因此被静默跳过。所以危险操作一律走应用内模态。
 *
 * 约定：
 * - 默认焦点在「取消」，Esc 等同取消，永远不会误触发删除。
 * - 处理中禁用全部按钮，内部用 ref 拦住重复提交。
 * - 关闭后焦点回到打开前的元素。
 */
export default function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = "取消",
  danger = false,
  busy = false,
  error,
  confirmDisabled = false,
  onCancel,
  onConfirm,
}: Props) {
  const modalId = useId();
  const isTop = useIsTopModal(modalId);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const inFlightRef = useRef(false);
  const [localBusy, setLocalBusy] = useState(false);
  const locked = busy || localBusy;

  // 入栈/出栈：只有栈顶模态响应 Esc，并且据此禁用背景交互。
  useEffect(() => {
    if (!open) return;
    pushModal(modalId);
    return () => popModal(modalId);
  }, [open, modalId]);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inFlightRef.current = false;
    setLocalBusy(false);
    const handle = window.requestAnimationFrame(() => cancelRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(handle);
      const target = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (target && document.contains(target)) target.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 只看自己是不是栈顶：否则 Esc 会同时关掉下层的查看器。
      if (!isTop) return;
      event.preventDefault();
      event.stopPropagation();
      if (!locked) onCancel();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, locked, onCancel, isTop]);

  const submit = useCallback(() => {
    if (inFlightRef.current || locked || confirmDisabled) return;
    inFlightRef.current = true;
    setLocalBusy(true);
    Promise.resolve()
      .then(onConfirm)
      .catch(() => {
        /* 错误由父组件写入 error */
      })
      .finally(() => {
        inFlightRef.current = false;
        setLocalBusy(false);
      });
  }, [locked, confirmDisabled, onConfirm]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const focusable = Array.from(
      root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hasAttribute("disabled"));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    }
  }, []);

  if (!open) return null;

  return createPortal(
    <div className="modal-overlay" data-testid="confirm-overlay" data-modal-layer="modal">
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        aria-describedby={DESC_ID}
        ref={dialogRef}
        onKeyDown={handleKeyDown}
      >
        <h2 id={TITLE_ID} className="modal-title">
          {title}
        </h2>
        <div id={DESC_ID} className="modal-body">
          {children}
        </div>

        {error && (
          <Notice variant="error" className="notice-inline">
            {error}
          </Notice>
        )}

        <div className="modal-actions" aria-busy={locked}>
          <button
            type="button"
            className={danger ? "btn btn-danger" : "btn btn-primary"}
            disabled={locked || confirmDisabled}
            onClick={submit}
          >
            {confirmLabel}
          </button>
          <button
            type="button"
            className="btn"
            ref={cancelRef}
            disabled={locked}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
        </div>

        <p className="modal-hint">按 Esc 等同于「{cancelLabel}」，不会执行任何更改。</p>
      </div>
    </div>,
    document.body,
  );
}
