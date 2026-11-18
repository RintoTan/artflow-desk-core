import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import ConfirmDialog from "./ConfirmDialog";
import ImageViewer from "./ImageViewer";
import { attachmentApi, describeError, type AttachmentView } from "../bridge/commands";
import { partitionImagePaths } from "../lib/attachmentDrop";

const STATE_LABEL: Record<string, string> = {
  ok: "正常",
  missing: "原图缺失",
  corrupt: "原图损坏",
};

const IMAGE_FILTER = {
  name: "图片",
  extensions: ["png", "jpg", "jpeg", "webp"],
};

export default function AttachmentPanel({
  orderId,
  onError,
  onNotice,
}: {
  orderId: string;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const [items, setItems] = useState<AttachmentView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [removeTarget, setRemoveTarget] = useState<AttachmentView | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [importing, setImporting] = useState(0);
  const sectionRef = useRef<HTMLElement | null>(null);
  /** 事件订阅只建一次，用 ref 指向最新实现，避免 orderId 变化后闭包过期。 */
  const importPathsRef = useRef<(paths: string[]) => Promise<void>>(async () => {});

  const load = useCallback(async () => {
    const list = await attachmentApi.list(orderId);
    setItems(list);
    return list;
  }, [orderId]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    attachmentApi
      .list(orderId)
      .then((list) => {
        if (alive) setItems(list);
      })
      .catch((e) => {
        if (alive) onError(describeError(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [orderId, onError]);

  async function importImages() {
    try {
      const picked = await openDialog({
        multiple: true,
        filters: [IMAGE_FILTER],
        title: "选择参考图片",
      });
      if (!picked) return;
      const paths = Array.isArray(picked) ? picked : [picked];
      if (paths.length === 0) return;

      await importPaths(paths);
    } catch (e) {
      onError(describeError(e));
    }
  }

  /**
   * 统一入口：对话框与拖拽都走这里。
   * 先按扩展名过滤（后端仍会做魔数校验），避免一张 GIF 让整批静默失败。
   */
  async function importPaths(paths: string[]) {
    const { accepted, rejected } = partitionImagePaths(paths);
    if (rejected.length > 0) {
      onError(rejected.map((r) => `${r.name}：${r.reason}`).join("；"));
    }
    if (accepted.length === 0) return;

    setBusy(true);
    setImporting(accepted.length);
    try {
      const outcomes = await attachmentApi.import({ orderId, sourcePaths: accepted });
      await load();

      const ok = outcomes.filter((o) => o.ok).length;
      const failed = outcomes.filter((o) => !o.ok);
      if (failed.length === 0) {
        onNotice(`已导入 ${ok} 张图片`);
      } else {
        onNotice(`成功 ${ok} 张，失败 ${failed.length} 张`);
        onError(
          failed
            .map((f) => `${f.sourceName}：${f.error ?? "导入失败"}`)
            .join("；"),
        );
      }
    } catch (e) {
      onError(describeError(e));
    } finally {
      setBusy(false);
      setImporting(0);
    }
  }

  /**
   * 真实的文件拖拽由 Tauri 在窗口层接管，HTML5 drop 拿不到磁盘路径。
   * 所以订阅 webview 的拖拽事件，再用落点是否在面板内决定高亮与接收。
   */
  useEffect(() => {
    let dispose: (() => void) | null = null;
    const inside = (position?: { x: number; y: number }) => {
      const node = sectionRef.current;
      if (!node || !position) return false;
      const scale = window.devicePixelRatio || 1;
      const x = position.x / scale;
      const y = position.y / scale;
      const r = node.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };

    try {
      const webview = getCurrentWebview();
      void webview
        .onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === "over") {
            setDragActive(inside(payload.position));
          } else if (payload.type === "leave") {
            setDragActive(false);
          } else if (payload.type === "drop") {
            const hit = inside(payload.position);
            setDragActive(false);
            if (hit && payload.paths.length > 0) {
              void importPathsRef.current(payload.paths);
            }
          }
        })
        .then((unlisten) => {
          dispose = unlisten;
        })
        .catch(() => {
          /* 浏览器预览里没有 webview 事件，退回点击选择 */
        });
    } catch {
      /* 非 Tauri 环境 */
    }
    return () => {
      dispose?.();
    };
  }, []);

  importPathsRef.current = importPaths;

  async function verifyAll() {
    setBusy(true);
    try {
      const report = await attachmentApi.verify(orderId);
      setItems(report.attachments);
      const problems = report.missing + report.corrupt;
      onNotice(
        problems === 0
          ? `校验完成：${report.ok} 张全部正常`
          : `校验完成：正常 ${report.ok}，缺失 ${report.missing}，损坏 ${report.corrupt}`,
      );
    } catch (e) {
      onError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function rebuildThumbs() {
    setBusy(true);
    try {
      const report = await attachmentApi.rebuildThumbs(orderId);
      await load();
      onNotice(
        report.failed === 0
          ? `缩略图：重建 ${report.rebuilt}，跳过 ${report.skipped}`
          : `缩略图：重建 ${report.rebuilt}，失败 ${report.failed}`,
      );
      if (report.failed > 0) onError(report.failures.join("；"));
    } catch (e) {
      onError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function repair(target: AttachmentView) {
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [IMAGE_FILTER],
        title: `为「${target.originalName}」重新选择原图`,
      });
      if (!picked || Array.isArray(picked)) return;
      setBusy(true);
      await attachmentApi.repair({ attachmentId: target.id, sourcePath: picked });
      await load();
      onNotice("原图已替换，附件关联保持不变");
    } catch (e) {
      onError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmRemove() {
    const target = removeTarget;
    if (!target) return;
    setBusy(true);
    try {
      await attachmentApi.remove(target.id);
      setRemoveTarget(null);
      setViewerIndex(null);
      await load();
      onNotice("图片已从订单移除");
    } catch (e) {
      onError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const current = viewerIndex !== null ? items[viewerIndex] ?? null : null;

  return (
    <section className="panel">
      <header className="panel-head compact">
        <div>
          <h2>参考图片</h2>
          <p className="muted">
            {items.length} 张 · 原图保存在应用数据目录，缩略图可随时重建
          </p>
        </div>
        <div className="attach-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void importImages()}
            disabled={busy}
          >
            {items.length === 0 ? "选择图片" : "添加图片"}
          </button>
          {items.length > 0 && (
            <>
              <button type="button" className="btn btn-sm" onClick={() => void verifyAll()} disabled={busy}>
                校验
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void rebuildThumbs()}
                disabled={busy}
              >
                重建缩略图
              </button>
            </>
          )}
        </div>
      </header>

      {loading ? (
        <p className="muted">正在读取图片…</p>
      ) : items.length === 0 ? (
        <button
          type="button"
          className="attach-dropzone"
          onClick={() => void importImages()}
          disabled={busy}
        >
          <strong>{importing > 0 ? `正在导入 ${importing} 张…` : dragActive ? "松开即可导入" : "把参考图片拖到这里"}</strong>
          <span className="muted">或点击选择图片 · 支持 PNG / JPEG / WebP，单张最大 100 MB</span>
        </button>
      ) : (
        <>
        {dragActive && <p className="attach-drop-hint">松开鼠标，把图片追加到这张订单</p>}
        <ul className="attach-grid">
          {items.map((item, index) => (
            <li key={item.id} className={`attach-card attach-${item.state}`}>
              <button
                type="button"
                className="attach-thumb"
                onClick={() => setViewerIndex(index)}
                aria-label={`查看 ${item.displayName ?? item.originalName}`}
              >
                {item.thumbExists && item.thumbPath ? (
                  <img src={convertFileSrc(item.thumbPath)} alt={item.displayName ?? item.originalName} />
                ) : item.fileExists ? (
                  <img src={convertFileSrc(item.originalPath)} alt={item.originalName} />
                ) : (
                  <span className="attach-placeholder">无预览</span>
                )}
              </button>
              <div className="attach-meta">
                <span className="attach-name" title={item.displayName ?? item.originalName}>
                  {item.displayName ?? item.originalName}
                </span>
                <span className="attach-sub">
                  {item.width && item.height ? `${item.width}×${item.height}` : "尺寸未知"}
                  {item.tag ? ` · ${item.tag}` : ""}
                </span>
                {item.state !== "ok" && (
                  <span className="chip chip-warn">{STATE_LABEL[item.state] ?? item.state}</span>
                )}
              </div>
              <div className="attach-row-actions">
                {item.state !== "ok" && (
                  <button
                    type="button"
                    className="link-btn"
                    disabled={busy}
                    onClick={() => void repair(item)}
                  >
                    重新选择原图
                  </button>
                )}
                <button
                  type="button"
                  className="link-btn link-danger"
                  disabled={busy}
                  onClick={() => setRemoveTarget(item)}
                >
                  移除
                </button>
              </div>
            </li>
          ))}
        </ul>
        </>
      )}

      <ConfirmDialog
        open={removeTarget !== null}
        title="确认移除这张参考图片？"
        danger
        confirmLabel="确认移除"
        busy={busy}
        onCancel={() => setRemoveTarget(null)}
        onConfirm={confirmRemove}
      >
        {removeTarget && (
          <p>
            即将移除 <strong>「{removeTarget.displayName ?? removeTarget.originalName}」</strong>
            ，原图与缩略图会一并从数据目录中删除，此操作不可撤销。
          </p>
        )}
      </ConfirmDialog>

      {current && viewerIndex !== null && (
        <ImageViewer
          items={items}
          index={viewerIndex}
          busy={busy}
          onClose={() => setViewerIndex(null)}
          onChangeIndex={setViewerIndex}
          onSaveMeta={async (meta) => {
            try {
              setBusy(true);
              const updated = await attachmentApi.updateMeta({
                attachmentId: current.id,
                ...meta,
              });
              setItems((list) => list.map((a) => (a.id === updated.id ? updated : a)));
              onNotice("图片信息已保存");
            } catch (e) {
              onError(describeError(e));
            } finally {
              setBusy(false);
            }
          }}
          onRemove={() => setRemoveTarget(current)}
          onRepair={() => void repair(current)}
        />
      )}
    </section>
  );
}
