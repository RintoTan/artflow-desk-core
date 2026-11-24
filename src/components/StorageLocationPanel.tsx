import { useEffect, useState } from "react";

import {
  api,
  describeError,
  type MigratePreview,
  type MigrateReport,
  type StorageStatus,
} from "../bridge/commands";
import ConfirmDialog from "./ConfirmDialog";

/**
 * DEV-0.1.1-05：数据存储位置。
 *
 * 迁移搬的是整个数据环境（含全部历史代际、备份、恢复证据），所以这里必须先把
 * 「要搬什么、占多少、空间够不够」摆出来给人看，再让人按确认。
 * 迁移成功后指针已经切走，必须重启才能真正用上新位置。
 */

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export default function StorageLocationPanel({
  onError,
}: {
  onError: (message: string) => void;
}) {
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [preview, setPreview] = useState<MigratePreview | null>(null);
  const [report, setReport] = useState<MigrateReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmDefault, setConfirmDefault] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .storageStatus()
      .then(setStatus)
      .catch((e) => onError(describeError(e)));
  }, [onError]);

  async function pick() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false, title: "选择新的数据位置" });
    if (typeof picked !== "string") return;
    setTarget(picked);
    setReport(null);
    setPreview(null);
    try {
      setPreview(await api.storagePreview(picked));
    } catch (e) {
      const message = describeError(e);
      setDialogError(message);
      onError(message);
    }
  }

  async function migrate() {
    if (!target) return;
    setBusy(true);
    setDialogError(null);
    try {
      const result = await api.storageMigrate(target);
      setReport(result);
      setConfirming(false);
      setPreview(null);
      setStatus(await api.storageStatus());
    } catch (e) {
      const message = describeError(e);
      setDialogError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  async function useDefault() {
    setBusy(true);
    setDialogError(null);
    try {
      await api.storageUseDefault();
      setConfirmDefault(false);
      setStatus(await api.storageStatus());
      setReport(null);
    } catch (e) {
      const message = describeError(e);
      setDialogError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  const needsRestart = report?.switched === true;

  return (
    <section className="panel settings-module settings-module-full" data-testid="storage-location">
      <h2>数据存储位置</h2>
      <p className="muted">
        数据默认保存在本机的应用数据目录。迁移会把整个数据环境一起搬走：全部历史代际、备份、恢复证据。
      </p>

      <dl className="storage-facts">
        <dt>当前位置</dt>
        <dd>
          <code>{status?.root ?? "…"}</code>
          {status && (
            <span className={`storage-badge ${status.custom ? "is-custom" : ""}`}>
              {status.custom ? "自定义位置 · 使用中" : "默认位置 · 使用中"}
            </span>
          )}
        </dd>
        <dt>默认位置</dt>
        <dd>
          <code>{status?.defaultRoot ?? "…"}</code>
        </dd>
      </dl>

      <div className="reset-actions">
        <button type="button" className="btn" onClick={() => void pick()} disabled={busy}>
          选择新位置…
        </button>
        {status?.custom && (
          <button
            type="button"
            className="btn"
            onClick={() => setConfirmDefault(true)}
            disabled={busy}
          >
            切回默认位置
          </button>
        )}
      </div>

      {preview && (
        <div className="storage-preview" data-testid="storage-preview">
          <h3>将迁移到</h3>
          <p>
            <code>{preview.targetRoot}</code>
          </p>
          <ul className="storage-list">
            <li>
              文件 {preview.files} 个 · 合计 {formatBytes(preview.bytes)}
            </li>
            <li>
              数据代际 {preview.generations.length} 个（含全部历史代际）
            </li>
            <li>{preview.hasBackups ? "包含本地备份" : "没有本地备份"}</li>
            <li>{preview.hasQuarantineEvidence ? "包含失败恢复的诊断目录" : "没有恢复诊断目录"}</li>
            <li>
              目标可用 {formatBytes(preview.availableBytes)}，需要{" "}
              {formatBytes(preview.requiredBytes)}（含 1.2 倍余量）
            </li>
          </ul>
          {!preview.fits && (
            <p className="reset-option-risk">目标位置空间不足，无法迁移。</p>
          )}
          <div className="reset-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !preview.fits}
              onClick={() => {
                setDialogError(null);
                setConfirming(true);
              }}
            >
              迁移到此处
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                setPreview(null);
                setTarget(null);
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {report && (
        <div className="reset-report" data-testid="storage-report">
          <h3 className="reset-overall is-all_ok">迁移完成</h3>
          <ul className="storage-list">
            <li>
              已复制 {report.copiedFiles} 个文件，逐个校验 {report.verifiedFiles} 个
            </li>
            <li>数据代际 {report.generations.length} 个，全部通过完整性检查</li>
            <li>
              新位置：<code>{report.targetRoot}</code>
            </li>
            <li>
              旧位置保留在 <code>{report.sourceRoot}</code>，不会自动删除。
            </li>
            {report.snapshotPath && (
              <li>
                迁移前的安全快照：<code>{report.snapshotPath}</code>
              </li>
            )}
          </ul>
          {needsRestart && (
            <>
              <p className="reset-restart-warning">
                数据指针已经切到新位置，但当前窗口仍在读旧位置。请重启应用，否则新写入会进旧目录。
              </p>
              <div className="reset-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void api.restartApp()}
                >
                  重启应用以使用新位置
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        title="确认迁移数据位置"
        confirmLabel={busy ? "正在迁移…" : "开始迁移"}
        danger
        busy={busy}
        error={dialogError}
        onCancel={() => setConfirming(false)}
        onConfirm={migrate}
      >
        <p>迁移过程中会先做一次安全快照，然后把整个数据环境复制到新位置并逐个校验。</p>
        <ul className="reset-confirm-list">
          <li>目标：{target}</li>
          <li>旧位置不会被删除，可与新位置并存。</li>
          <li>完成后需要重启应用，数据指针才会真正生效。</li>
        </ul>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmDefault}
        title="切回默认位置"
        confirmLabel={busy ? "正在切换…" : "切回默认位置"}
        danger
        busy={busy}
        error={dialogError}
        onCancel={() => setConfirmDefault(false)}
        onConfirm={useDefault}
      >
        <p className="reset-option-risk">
          默认位置里的数据可能不是最新版本。切回后不会自动合并，两份数据各自独立。
        </p>
        <p className="muted">
          当前自定义位置的数据不会被删除，只是不再被使用。需要时可以通过「选择新位置」重新指回去。
        </p>
      </ConfirmDialog>
    </section>
  );
}
