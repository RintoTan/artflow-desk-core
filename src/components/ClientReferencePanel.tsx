import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";

import { clientRefApi, describeError, type ClientRef } from "../bridge/commands";
import { decideDrop, isInsideRect, partitionImagePaths, physicalToCss, type Rect } from "../lib/attachmentDrop";
import ConfirmDialog from "./ConfirmDialog";

type Props = {
  clientId: string;
};

function rectOf(node: HTMLElement | null): Rect | null {
  if (!node) return null;
  const box = node.getBoundingClientRect();
  return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
}

/**
 * 客户参考图。
 *
 * 与订单附件是两套归属：这里的图属于客户，订单删了也不该跟着消失。
 * 交互刻意不同：订单列表里的缩略图是装饰（点卡片进详情），
 * 这里点缩略图直接看原图——客户资料页没有别的地方可以看图。
 */
export default function ClientReferencePanel({ clientId }: Props) {
  const [items, setItems] = useState<ClientRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [viewing, setViewing] = useState<ClientRef | null>(null);
  const [pending, setPending] = useState<ClientRef | null>(null);

  const sectionRef = useRef<HTMLElement | null>(null);
  const clientIdRef = useRef(clientId);
  clientIdRef.current = clientId;
  const dragClientIdRef = useRef<string | null>(null);
  const lastDropAtRef = useRef(0);
  /** 事件订阅只建一次，实现通过 ref 取最新值，避免切客户后闭包过期。 */
  const importRef = useRef<(paths: string[]) => Promise<void>>(async () => {});

  const load = useCallback(async () => {
    try {
      setItems(await clientRefApi.list(clientId));
    } catch (e) {
      setError(describeError(e));
    }
  }, [clientId]);

  useEffect(() => {
    setItems([]);
    setError(null);
    setNotice(null);
    setViewing(null);
    void load();
  }, [load]);

  const importPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      const { accepted, rejected } = partitionImagePaths(paths);
      setError(
        rejected.length === 0
          ? null
          : rejected.map((item) => `${item.name}：${item.reason}`).join("；"),
      );
      if (accepted.length === 0) return;

      setBusy(true);
      setNotice(null);
      try {
        const outcomes = await clientRefApi.import({ clientId: clientIdRef.current, sourcePaths: accepted });
        const failed = outcomes.filter((item) => !item.ok);
        const done = outcomes.length - failed.length;
        if (failed.length > 0) {
          setError(failed.map((item) => `${item.sourceName}：${item.error ?? "导入失败"}`).join("；"));
        }
        if (done > 0) setNotice(`已添加 ${done} 张参考图。`);
        await load();
      } catch (e) {
        setError(describeError(e));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );
  importRef.current = importPaths;

  // 拖拽进面板 = 给这个客户加参考图。屏幕坐标判定的细节与订单附件共用同一套纯函数。
  useEffect(() => {
    let dispose: (() => void) | null = null;
    try {
      const webview = getCurrentWebview();
      let cancelled = false;
      void webview
        .onDragDropEvent((event) => {
          const payload = event.payload;
          const dpr = window.devicePixelRatio || 1;
          const rect = rectOf(sectionRef.current);
          if (payload.type === "enter" || payload.type === "over") {
            if (dragClientIdRef.current === null) dragClientIdRef.current = clientIdRef.current;
            setDragActive(isInsideRect(physicalToCss(payload.position, dpr), rect));
            return;
          }
          if (payload.type === "leave") {
            dragClientIdRef.current = null;
            setDragActive(false);
            return;
          }
          const now = Date.now();
          const decision = decideDrop({
            position: payload.position,
            devicePixelRatio: dpr,
            rect,
            paths: payload.paths,
            // 判定函数里的 owner 参数原本是为订单写的；参考图的归属是客户，
            // 语义相同（拖拽期间换了归属就不导入），直接复用同一套规则。
            dragOrderId: dragClientIdRef.current,
            activeOrderId: clientIdRef.current,
            now,
            lastDropAt: lastDropAtRef.current,
          });
          dragClientIdRef.current = null;
          setDragActive(false);
          if (decision.import) {
            lastDropAtRef.current = now;
            void importRef.current(decision.paths);
          }
        })
        .then((unlisten) => {
          if (cancelled) unlisten();
          else dispose = unlisten;
        });
      return () => {
        cancelled = true;
        dispose?.();
      };
    } catch {
      // 非 Tauri 环境（测试/浏览器预览）没有 webview 事件：只保留按钮上传。
      return;
    }
  }, []);

  async function pick() {
    setError(null);
    setNotice(null);
    try {
      const picked = await open({
        title: "选择参考图",
        multiple: true,
        filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
      });
      const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
      await importPaths(paths);
    } catch (e) {
      setError(describeError(e));
    }
  }

  async function confirmRemove() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await clientRefApi.remove(clientId, pending.id);
      setPending(null);
      await load();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className={`panel client-refs${dragActive ? " is-drop-target" : ""}`}
      ref={sectionRef}
      aria-label="客户参考图"
    >
      <header className="panel-head compact">
        <div>
          <h2>参考图</h2>
          <p className="muted">
            {items.length > 0 ? `${items.length} 张 · 点缩略图看原图` : "还没有参考图，可以上传或把图片拖进来"}
          </p>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => void pick()} disabled={busy}>
          {busy ? "处理中…" : "上传参考图"}
        </button>
      </header>

      {items.length > 0 && (
        <ul className="ref-grid">
          {items.map((item) => {
            const src = item.thumbPath ?? (item.fileExists ? item.originalPath : null);
            return (
              <li key={item.id} className="ref-item">
                <button
                  type="button"
                  className="ref-thumb"
                  onClick={() => setViewing(item)}
                  aria-label={`查看 ${item.originalName}`}
                  disabled={!item.fileExists}
                >
                  {src ? (
                    <img src={convertFileSrc(src)} alt={item.originalName} loading="lazy" />
                  ) : (
                    <span className="order-thumb-empty" aria-hidden="true" />
                  )}
                </button>
                <button
                  type="button"
                  className="ref-remove"
                  onClick={() => setPending(item)}
                  aria-label={`删除 ${item.originalName}`}
                >
                  ×
                </button>
                <span className="ref-name" title={item.originalName}>
                  {item.originalName}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {notice && <p className="notice notice-ok">{notice}</p>}
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}

      <ConfirmDialog
        open={pending !== null}
        title="删除这张参考图？"
        confirmLabel="删除"
        danger
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={() => void confirmRemove()}
      >
        删除后原图与缩略图都会从本机移除，不能撤销。
        {pending ? `（${pending.originalName}）` : ""}
      </ConfirmDialog>

      {viewing && (
        <div className="ref-viewer" role="dialog" aria-modal="true" aria-label={`查看 ${viewing.originalName}`}>
          <button
            type="button"
            className="ref-viewer-close"
            onClick={() => setViewing(null)}
            aria-label="关闭原图"
          >
            ×
          </button>
          {viewing.fileExists ? (
            <img src={convertFileSrc(viewing.originalPath)} alt={viewing.originalName} />
          ) : (
            <p className="muted">原图文件不在这台机器上。</p>
          )}
        </div>
      )}
    </section>
  );
}
