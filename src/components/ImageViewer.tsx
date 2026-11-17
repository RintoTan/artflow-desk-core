import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { createPortal } from "react-dom";

import type { AttachmentView } from "../bridge/commands";

type Props = {
  items: AttachmentView[];
  index: number;
  busy: boolean;
  onClose: () => void;
  onChangeIndex: (index: number) => void;
  onSaveMeta: (meta: { displayName: string | null; note: string | null; tag: string | null }) => void;
  onRemove: () => void;
  onRepair: () => void;
};

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 6;

/**
 * 轻量大图查看器：适配画面 / 缩放 / 平移 / 前后切换。
 * 编辑区只改元数据（展示名称、备注、标签），不碰原图。
 */
export default function ImageViewer({
  items,
  index,
  busy,
  onClose,
  onChangeIndex,
  onSaveMeta,
  onRemove,
  onRepair,
}: Props) {
  const item = items[index];
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState<{ x: number; y: number } | null>(null);
  const [displayName, setDisplayName] = useState(item?.displayName ?? "");
  const [note, setNote] = useState(item?.note ?? "");
  const [tag, setTag] = useState(item?.tag ?? "");
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const reset = useCallback(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    reset();
    setDisplayName(item?.displayName ?? "");
    setNote(item?.note ?? "");
    setTag(item?.tag ?? "");
  }, [index, item, reset]);

  useEffect(() => {
    const handle = window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => window.cancelAnimationFrame(handle);
  }, []);

  const step = useCallback(
    (delta: number) => {
      const next = index + delta;
      if (next < 0 || next >= items.length) return;
      onChangeIndex(next);
    },
    [index, items.length, onChangeIndex],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        step(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        step(1);
      } else if (event.key === "0") {
        reset();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose, step, reset]);

  if (!item) return null;

  const source = item.fileExists ? item.originalPath : null;
  const isDirty =
    (displayName.trim() || null) !== (item.displayName ?? null) ||
    (note.trim() || null) !== (item.note ?? null) ||
    (tag.trim() || null) !== (item.tag ?? null);

  return createPortal(
    <div className="viewer-overlay" role="dialog" aria-modal="true" aria-label="图片查看器">
      <div className="viewer">
        <header className="viewer-head">
          <div>
            <strong>{item.displayName ?? item.originalName}</strong>
            <span className="muted">
              {" "}
              · {item.width ?? "?"}×{item.height ?? "?"} · {(item.byteSize / 1024).toFixed(0)} KB
              {item.tag ? ` · ${item.tag}` : ""}
            </span>
          </div>
          <div className="viewer-head-actions">
            <button type="button" className="btn btn-sm" onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - 0.25))}>
              −
            </button>
            <span className="mono viewer-zoom">{Math.round(zoom * 100)}%</span>
            <button type="button" className="btn btn-sm" onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + 0.25))}>
              +
            </button>
            <button type="button" className="btn btn-sm" onClick={reset}>
              适应
            </button>
            <button type="button" className="btn btn-sm" ref={closeRef} onClick={onClose}>
              关闭
            </button>
          </div>
        </header>

        <div
          className={`viewer-stage${dragging ? " viewer-dragging" : ""}`}
          onPointerDown={(e) => {
            setDragging({ x: e.clientX - offset.x, y: e.clientY - offset.y });
          }}
          onPointerMove={(e) => {
            if (!dragging) return;
            setOffset({ x: e.clientX - dragging.x, y: e.clientY - dragging.y });
          }}
          onPointerUp={() => setDragging(null)}
          onPointerLeave={() => setDragging(null)}
          onWheel={(e) => {
            const next = zoom + (e.deltaY > 0 ? -0.15 : 0.15);
            setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)));
          }}
        >
          {source ? (
            <img
              className="viewer-image"
              src={convertFileSrc(source)}
              alt={item.displayName ?? item.originalName}
              draggable={false}
              style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
            />
          ) : (
            <div className="viewer-missing">
              <p>原图缺失，无法预览。</p>
              <button type="button" className="btn btn-sm" onClick={onRepair} disabled={busy}>
                重新选择原图
              </button>
            </div>
          )}
        </div>

        <footer className="viewer-foot">
          <div className="viewer-nav">
            <button type="button" className="btn btn-sm" disabled={index === 0} onClick={() => step(-1)}>
              上一张
            </button>
            <span className="muted">
              {index + 1} / {items.length}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={index >= items.length - 1}
              onClick={() => step(1)}
            >
              下一张
            </button>
          </div>

          <div className="viewer-meta">
            <label className="field compact-field">
              <span>展示名称</span>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={item.originalName}
                maxLength={120}
              />
            </label>
            <label className="field compact-field">
              <span>标签</span>
              <input value={tag} onChange={(e) => setTag(e.target.value)} maxLength={40} />
            </label>
            <label className="field compact-field field-wide">
              <span>备注</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
            </label>
            <div className="viewer-meta-actions">
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busy || !isDirty}
                onClick={() =>
                  onSaveMeta({
                    displayName: displayName.trim() === "" ? null : displayName,
                    note: note.trim() === "" ? null : note,
                    tag: tag.trim() === "" ? null : tag,
                  })
                }
              >
                保存信息
              </button>
              <button type="button" className="btn btn-sm" onClick={onRepair} disabled={busy}>
                替换原图
              </button>
              <button type="button" className="btn btn-sm btn-danger" onClick={onRemove} disabled={busy}>
                移除这张
              </button>
            </div>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
