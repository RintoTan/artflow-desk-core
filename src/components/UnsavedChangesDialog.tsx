import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Props = {
  open: boolean;
  /** 具体场景说明，例如"切换订单会丢失…" */
  detail?: string;
  /** 保存失败等错误，展示在对话框内，不关闭对话框 */
  error?: string | null;
  /** 父组件正在处理（保存中），期间禁用操作并阻止重复导航 */
  busy?: boolean;
  onSaveAndLeave: () => void | Promise<void>;
  onDiscard: () => void | Promise<void>;
  onStay: () => void;
};

const TITLE_ID = "unsaved-dialog-title";
const DESC_ID = "unsaved-dialog-desc";

/**
 * 未保存修改的模态确认。
 *
 * 明确约定：
 * - 默认焦点在「继续编辑」，Esc 等同于「继续编辑」，**任何情况下都不会因为 Esc 丢草稿**。
 * - 关闭后把焦点还给打开前的元素。
 * - `busy` 期间所有操作禁用，且内部用 ref 拦住重复触发，避免重复导航。
 */
export default function UnsavedChangesDialog({
  open,
  detail,
  error,
  busy = false,
  onSaveAndLeave,
  onDiscard,
  onStay,
}: Props) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const stayRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const inFlightRef = useRef(false);
  const [localBusy, setLocalBusy] = useState(false);

  const locked = busy || localBusy;

  // 打开时记录原焦点并聚焦「继续编辑」；关闭时还回去。
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inFlightRef.current = false;
    setLocalBusy(false);
    const handle = window.requestAnimationFrame(() => stayRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(handle);
      const target = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (target && document.contains(target)) {
        target.focus();
      }
    };
  }, [open]);

  // Esc 在任何焦点位置都生效：监听挂在 document 上，避免焦点意外落在对话框外时
  // Esc 变成"什么都没发生"进而被误认为已取消。
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (!locked) onStay();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, locked, onStay]);

  const runOnce = useCallback(
    (action: () => void | Promise<void>) => {
      if (inFlightRef.current || locked) return;
      inFlightRef.current = true;
      setLocalBusy(true);
      Promise.resolve()
        .then(action)
        .catch(() => {
          /* 具体错误由父组件写进 error；这里只保证不把异常抛到控制台之外 */
        })
        .finally(() => {
          // 父组件若保持对话框打开（保存失败），需要允许再次操作。
          inFlightRef.current = false;
          setLocalBusy(false);
        });
    },
    [locked],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Tab") return;

      const root = dialogRef.current;
      if (!root) return;
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true");
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
    },
    [],
  );

  if (!open) return null;

  return createPortal(
    <div className="modal-overlay" data-testid="unsaved-overlay">
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
          有尚未保存的修改
        </h2>
        <p id={DESC_ID} className="modal-body">
          {detail ?? "离开当前页面会丢失尚未保存的资料修改。"}
        </p>

        {error && (
          <p className="modal-error" role="alert">
            {error}
          </p>
        )}

        <div className="modal-actions" aria-busy={locked}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={locked}
            onClick={() => runOnce(onSaveAndLeave)}
          >
            保存并离开
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={locked}
            onClick={() => runOnce(onDiscard)}
          >
            放弃修改
          </button>
          <button
            type="button"
            className="btn"
            ref={stayRef}
            disabled={locked}
            onClick={() => runOnce(onStay)}
          >
            继续编辑
          </button>
        </div>

        <p className="modal-hint">按 Esc 等同于「继续编辑」，不会丢失草稿。</p>
      </div>
    </div>,
    document.body,
  );
}
