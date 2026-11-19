import { useCallback, useEffect, useState } from "react";

import {
  api,
  describeError,
  type BackupCreated,
  type BackupPreview,
  type BackupRestored,
  type BackupStatus,
} from "../bridge/commands";
import ConfirmDialog from "./ConfirmDialog";

/** 提醒周期只给这几个档位；0 = 关闭，不由程序默认替用户选。 */
const REMINDER_OPTIONS: Array<{ days: number; label: string }> = [
  { days: 0, label: "关闭提醒" },
  { days: 7, label: "每 7 天" },
  { days: 14, label: "每 14 天" },
  { days: 30, label: "每 30 天" },
  { days: 90, label: "每 90 天" },
];

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatMoment(iso: string | null): string {
  if (!iso) return "从未备份";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** 相对天数的人话描述，避免用户自己算。 */
export function daysLabel(status: BackupStatus): string {
  if (status.daysSinceLast === null) return "还没有备份过";
  if (status.daysSinceLast <= 0) return "今天已备份";
  return `${status.daysSinceLast} 天前`;
}

const RELATION_LABEL: Record<string, string> = {
  current: "结构版本与应用一致",
  older: "结构版本较旧，将在隔离代际内升级",
  newer: "结构版本较新，当前应用无法恢复",
};

export default function BackupPanel({ onError }: { onError: (message: string) => void }) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [restored, setRestored] = useState<BackupRestored | null>(null);

  // 状态读取失败只在本模块内提示：它不该占用页面级错误区，也不该盖掉别的提示。
  const refresh = useCallback(async () => {
    try {
      setStatus(await api.backupStatus());
      setStatusError(null);
    } catch (e) {
      setStatusError(describeError(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function runExport() {
    setBusy(true);
    setNotice(null);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const stamp = new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/[-:T]/g, "")
        .slice(0, 13);
      const target = await save({
        title: "导出数据备份",
        defaultPath: `artflow-backup-${stamp}.zip`,
        filters: [{ name: "ArtFlow 备份包", extensions: ["zip"] }],
      });
      if (!target) {
        return;
      }
      const created: BackupCreated = await api.backupCreate(target);
      setNotice(
        `已导出 ${created.files} 个文件 · ${formatBytes(created.bytes)} · ${created.path}`,
      );
      await refresh();
    } catch (e) {
      onError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function chooseRestoreFile() {
    setBusy(true);
    setNotice(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        title: "选择备份包",
        multiple: false,
        directory: false,
        filters: [{ name: "ArtFlow 备份包", extensions: ["zip"] }],
      });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) {
        return;
      }
      setPreview(await api.backupInspect(path));
    } catch (e) {
      onError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmRestore() {
    const target = preview;
    setPreview(null);
    if (!target) return;
    setBusy(true);
    try {
      const done = await api.backupRestore(target.path);
      setRestored(done);
      await refresh();
    } catch (e) {
      onError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function changeReminder(days: number) {
    try {
      setStatus(await api.backupSetReminder(days));
    } catch (e) {
      onError(describeError(e));
    }
  }

  return (
    <section className="panel settings-module settings-module-full" aria-labelledby="backup-title">
      <header className="panel-head compact">
        <h2 id="backup-title">数据备份</h2>
        <span className="muted">手动导出 / 恢复 · 本地文件</span>
      </header>

      {status ? (
        <>
          <dl className="backup-facts">
            <div>
              <dt>上次成功备份</dt>
              <dd>
                {formatMoment(status.lastSuccessAt)}
                <span className="muted"> · {daysLabel(status)}</span>
              </dd>
            </div>
            <div>
              <dt>结构版本 / 备份格式</dt>
              <dd>
                v{status.schemaVersion} / v{status.formatVersion}
              </dd>
            </div>
            <div>
              <dt>当前数据代际</dt>
              <dd className="mono">{status.generation}</dd>
            </div>
            <div>
              <dt>数据量</dt>
              <dd>
                订单 {status.orders} · 附件 {status.attachments} · {formatBytes(status.databaseBytes)}
              </dd>
            </div>
          </dl>

          {status.reminderDue && (
            <p className="backup-reminder" role="status">
              已有 {status.daysSinceLast ?? "多"} 天没有备份，建议现在导出一份。
            </p>
          )}
          {status.lastError && (
            <p className="muted">上次失败：{status.lastError}</p>
          )}

          <div className="backup-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={runExport}>
              导出备份…
            </button>
            <button type="button" className="btn" disabled={busy} onClick={chooseRestoreFile}>
              从备份恢复…
            </button>
            <label className="backup-reminder-field">
              <span>备份提醒</span>
              <select
                value={status.reminderDays}
                disabled={busy}
                onChange={(e) => void changeReminder(Number(e.target.value))}
              >
                {REMINDER_OPTIONS.map((option) => (
                  <option key={option.days} value={option.days}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <p className="muted">
            备份包含全部订单、客户、制作流程、历史事件与附件原图，可在另一台机器上恢复。
            备份包未加密，请妥善保存。
          </p>
        </>
      ) : statusError ? (
        <p className="muted">备份状态读取失败：{statusError}</p>
      ) : (
        <p className="muted">正在读取备份状态…</p>
      )}

      {notice && (
        <p className="backup-notice" role="status">
          {notice}
        </p>
      )}

      <ConfirmDialog
        open={preview !== null}
        title="从备份恢复"
        confirmLabel="确认恢复"
        cancelLabel="取消"
        danger
        busy={busy}
        onCancel={() => setPreview(null)}
        onConfirm={confirmRestore}
        confirmDisabled={preview !== null && !preview.canRestore}
      >
        {preview && (
          <div className="stage-adjust backup-preview">
            <p>
              <strong>{preview.path.split("/").pop() ?? preview.path}</strong>
            </p>
            <p className="muted">创建时间：{formatMoment(preview.createdAt)}</p>
            <p>
              备份结构 v{preview.schemaVersion} · 备份格式 v{preview.formatVersion} · 应用{" "}
              {preview.appVersion}
            </p>
            <p>
              内容：订单 {preview.summary.orders}（活动 {preview.summary.activeOrders}） · 客户{" "}
              {preview.summary.clients} · 模板 {preview.summary.templates} · 事件{" "}
              {preview.summary.events} · 附件 {preview.summary.attachments}
            </p>
            <p>
              跳级 {preview.summary.stageSkips} 条 · 改期 {preview.summary.reschedules} 条 · 文件{" "}
              {preview.files} 个 · {formatBytes(preview.bytes)}
            </p>
            <p className={preview.canRestore ? "muted" : "backup-danger"}>
              兼容性：{RELATION_LABEL[preview.schemaRelation] ?? preview.schemaRelation}
              {preview.blockReason ? `（${preview.blockReason}）` : ""}
            </p>
            <p className="muted">
              恢复会先自动备份当前数据，再在新的数据代际里解包并校验；全部通过才切换。
              失败时当前数据保持不变。恢复完成后需要重启应用。
            </p>
          </div>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={restored !== null}
        title="恢复完成"
        confirmLabel="立即重启"
        cancelLabel="稍后"
        onCancel={() => setRestored(null)}
        onConfirm={async () => {
          try {
            await api.restartApp();
          } catch (e) {
            onError(describeError(e));
          }
        }}
      >
        {restored && (
          <div className="stage-adjust">
            <p>
              已恢复 {restored.summary.orders} 笔订单 · {restored.summary.attachments} 个附件，结构版本 v
              {restored.schemaVersion}。
            </p>
            {restored.preRestoreBackup && (
              <p className="muted">恢复前已自动备份：{restored.preRestoreBackup}</p>
            )}
            {restored.raisedWatermarks.length > 0 && (
              <p className="muted">
                已合并编号高水位：{restored.raisedWatermarks.map((w) => `${w.year}→${w.lastAllocated}`).join("，")}
              </p>
            )}
            <p className="muted">重启后才会读到新数据。</p>
          </div>
        )}
      </ConfirmDialog>
    </section>
  );
}
