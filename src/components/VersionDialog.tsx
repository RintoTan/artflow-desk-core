import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { api, describeError, type EnvironmentStatus } from "../bridge/commands";
import { buildId, buildKindLabel, releaseLabel } from "../lib/buildInfo";
import { popModal, pushModal, useIsTopModal } from "../lib/modalStack";
import { ABOUT_MODULES } from "../pages/AboutPage";

type Props = {
  open: boolean;
  onClose: () => void;
  /** 打开完整关于页（模块说明、使用指引）。 */
  onOpenAbout?: () => void;
};

const MODAL_ID = "version-info";

/**
 * 版本信息弹窗。
 *
 * 三个概念刻意分开显示，不许互相顶替：
 * - **发布渠道**：这份构建是正式包还是 QA 包（由运行环境判定）；
 * - **发布标记**：GitHub 上的 Demo 迭代（如 v0.1.2-demo.1），不影响应用版本；
 * - **应用版本**：来自 Cargo.toml，经后端 status 读出。
 *
 * 数据库结构显示的是**实际打开的那份库**的版本，不是程序支持的目标版本——
 * 拿目标版本冒充实际版本，会在升级失败时给出一个看起来很正常的错答案。
 */
export default function VersionDialog({ open, onClose, onOpenAbout }: Props) {
  const [status, setStatus] = useState<EnvironmentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const isTop = useIsTopModal(MODAL_ID);

  useEffect(() => {
    if (!open) return;
    pushModal(MODAL_ID);
    return () => popModal(MODAL_ID);
  }, [open]);

  // 每次打开都重新读：版本信息跟着实际运行的那份数据走，不用缓存糊弄。
  useEffect(() => {
    if (!open) return;
    setError(null);
    api
      .status()
      .then(setStatus)
      .catch((e) => setError(describeError(e)));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handle = window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => window.cancelAnimationFrame(handle);
  }, [open]);

  const handleKey = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!isTop) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    },
    [isTop, onClose],
  );

  if (!open) return null;

  const channel = status ? (status.qaMode ? "QA 测试环境" : "Production") : "读取中…";
  const label = releaseLabel();
  const platform = detectPlatform();

  return createPortal(
    <div
      className="modal-overlay"
      data-testid="version-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal version-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleKey}
      >
        <div className="version-head">
          <div>
            <h2 id={titleId} className="modal-title">
              ArtFlow Desk Core
            </h2>
            <p className="muted">
              {status ? `v${status.appVersion}` : "版本读取中…"}
              {status ? ` · ${buildKindLabel(channel, label)}` : ""}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onClose}
            ref={closeRef}
            aria-label="关闭版本信息"
          >
            关闭
          </button>
        </div>

        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}

        <dl className="version-facts">
          <div>
            <dt>软件名称</dt>
            <dd>ArtFlow Desk Core</dd>
          </div>
          <div>
            <dt>应用版本</dt>
            <dd>{status ? status.appVersion : "读取中…"}</dd>
          </div>
          <div>
            <dt>发布渠道</dt>
            <dd>{channel}</dd>
          </div>
          {label !== "" && (
            <div>
              <dt>发布标记</dt>
              <dd>{label}</dd>
            </div>
          )}
          <div>
            <dt>Git SHA</dt>
            <dd>
              <code>{buildId()}</code>
            </dd>
          </div>
          <div>
            <dt>数据库结构</dt>
            <dd>{status ? `v${status.schemaVersion}` : "读取中…"}</dd>
          </div>
          <div>
            <dt>运行平台</dt>
            <dd>{platform}</dd>
          </div>
          <div>
            <dt>开发者</dt>
            <dd>RINTO</dd>
          </div>
          <div>
            <dt>项目归属</dt>
            <dd>ArtFlow Desk Core</dd>
          </div>
        </dl>

        <section className="version-modules" aria-label="功能模块">
          <h3>功能模块</h3>
          <ul>
            {ABOUT_MODULES.map((module) => (
              <li key={module.title}>
                <strong>{module.title}</strong>
                <span>{module.summary}</span>
              </li>
            ))}
          </ul>
        </section>

        {onOpenAbout && (
          <div className="version-actions">
            <button type="button" className="btn" onClick={onOpenAbout}>
              查看完整关于页
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** 只做展示用的平台判断：不引入新的插件依赖，也不影响任何构建逻辑。 */
function detectPlatform(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Linux/i.test(ua)) return "Linux";
  return "未知";
}
