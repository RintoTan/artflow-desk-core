import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Option = { value: string; label: string };

type Props = {
  open: boolean;
  anchor: HTMLElement | null;
  onClose: () => void;
  sources: Option[];
  source: string;
  status: string;
  onSource: (value: string) => void;
  onStatus: (value: string) => void;
  onClear: () => void;
};

/**
 * 统一筛选面板。
 *
 * 用 portal + fixed 定位，避免被列表/看板的滚动容器裁切（QA 里已经栽过一次）。
 * 打开后点外部或 Esc 关闭；条件即时生效，面板本身只是一个容器。
 */
export default function FilterMenu({
  open,
  anchor,
  onClose,
  sources,
  source,
  status,
  onSource,
  onStatus,
  onClear,
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useEffect(() => {
    if (!open || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    setPos({ top: rect.bottom + 6, left: Math.max(8, rect.left - 80) });
  }, [open, anchor]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    const onDown = (event: MouseEvent) => {
      const node = event.target as Node;
      if (ref.current?.contains(node)) return;
      if (anchor?.contains(node)) return;
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, onClose, anchor]);

  if (!open) return null;

  return createPortal(
    <div
      ref={ref}
      className="filter-menu panel"
      role="dialog"
      aria-label="筛选条件"
      style={{ top: pos.top, left: pos.left }}
    >
      <label className="filter-row">
        <span>来源</span>
        <select value={source} onChange={(e) => onSource(e.target.value)} aria-label="按来源筛选">
          {sources.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <label className="filter-row">
        <span>状态</span>
        <select value={status} onChange={(e) => onStatus(e.target.value)} aria-label="按状态筛选">
          <option value="all">全部状态</option>
          <option value="active">活动</option>
          <option value="complete">已完成</option>
          <option value="cancelled">已取消</option>
        </select>
      </label>
      <div className="filter-actions">
        <button type="button" className="link-btn" onClick={onClear}>
          清除条件
        </button>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          完成
        </button>
      </div>
    </div>,
    document.body,
  );
}
