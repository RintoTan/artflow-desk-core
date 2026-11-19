import { useCallback, useEffect, useState } from "react";

import {
  api,
  describeError,
  type JobsReport,
  type QuarantineReport,
} from "../bridge/commands";

function bytesLabel(bytes: number): string {
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

/**
 * 附件维护：只做「看清 + 手动清」，不做任何自动清理。
 *
 * - quarantine 是崩溃恢复时的可疑文件暂存区，用于人工比对，不是垃圾箱；
 * - 作业记录（attachment_jobs）里 pending 是崩溃恢复的唯一线索，永不参与清理。
 */
export default function AttachmentMaintenancePanel({
  onError,
}: {
  onError: (message: string) => void;
}) {
  const [quarantine, setQuarantine] = useState<QuarantineReport | null>(null);
  const [jobs, setJobs] = useState<JobsReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pruneDays, setPruneDays] = useState(90);
  const [confirming, setConfirming] = useState<"quarantine" | "jobs" | null>(null);
  // 读取失败只在本模块内提示，不占用页面级错误区（否则会盖掉其它模块的真实错误）。
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [q, j] = await Promise.all([api.maintenanceQuarantine(), api.maintenanceJobs(90)]);
      setQuarantine(q);
      setJobs(j);
      setLoadError(null);
    } catch (e) {
      setLoadError(describeError(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function clearQuarantine() {
    if (!quarantine) return;
    const targets = quarantine.items.filter((i) => !i.referenced).map((i) => i.name);
    setConfirming(null);
    if (targets.length === 0) {
      setNotice("没有可清理的文件：剩下的都还被数据库引用。");
      return;
    }
    setBusy(true);
    try {
      const result = await api.maintenanceQuarantineClear(targets);
      setNotice(
        `已清理 ${result.removed} 个文件（${bytesLabel(result.bytesFreed)}）` +
          (result.skippedReferenced > 0 ? `，跳过 ${result.skippedReferenced} 个仍有引用的` : "") +
          (result.errors.length > 0 ? `；${result.errors.length} 个失败` : ""),
      );
      await refresh();
    } catch (e) {
      onError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function pruneJobs() {
    setConfirming(null);
    setBusy(true);
    try {
      const result = await api.maintenanceJobsPrune({ olderThanDays: pruneDays, dryRun: false });
      setNotice(
        `已清理 ${result.removed} 条历史作业记录，保留 pending ${result.keptPending} 条、近期 ${result.keptRecent} 条。`,
      );
      await refresh();
    } catch (e) {
      onError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const referenced = quarantine?.items.filter((i) => i.referenced) ?? [];
  const removable = quarantine?.items.filter((i) => !i.referenced) ?? [];

  return (
    <section
      className="panel settings-module settings-module-full"
      aria-labelledby="maintenance-title"
    >
      <header className="panel-head compact">
        <h2 id="maintenance-title">附件维护</h2>
        <span className="muted">只在你确认后手动清理 · 没有自动清理</span>
      </header>

      <h3 className="maintenance-sub">隔离文件（quarantine）</h3>
      {quarantine ? (
        <>
          <dl className="backup-facts">
            <div>
              <dt>占用</dt>
              <dd>
                {quarantine.items.length} 个文件 · {bytesLabel(quarantine.totalBytes)}
              </dd>
            </div>
            <div>
              <dt>其中仍被引用</dt>
              <dd>{quarantine.referencedCount} 个（清理时会跳过）</dd>
            </div>
            <div>
              <dt>可清理</dt>
              <dd>
                {quarantine.removableCount} 个 · {bytesLabel(quarantine.removableBytes)}
              </dd>
            </div>
          </dl>
          {quarantine.items.length === 0 ? (
            <p className="muted">当前没有隔离文件。</p>
          ) : (
            <ul className="maintenance-list">
              {[...referenced, ...removable].map((item) => (
                <li key={item.name}>
                  <span className="maintenance-name">{item.name}</span>
                  <span className="muted">
                    {bytesLabel(item.bytes)}
                    {item.referenced ? " · 仍被引用" : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="backup-actions">
            <button
              type="button"
              className="btn"
              disabled={busy || removable.length === 0}
              onClick={() => setConfirming("quarantine")}
            >
              清理可清理的 {removable.length} 个文件…
            </button>
          </div>
          <p className="muted">
            隔离文件是异常恢复时挪出来的可疑文件，用于和原件人工比对。这里不会按时间自动删除。
          </p>
        </>
      ) : (
        <p className="muted">{loadError ? `读取失败：${loadError}` : "正在读取隔离目录…"}</p>
      )}

      <h3 className="maintenance-sub">导入作业记录（attachment_jobs）</h3>
      {jobs ? (
        <>
          <dl className="backup-facts">
            <div>
              <dt>总记录</dt>
              <dd>{jobs.counts.total} 条</dd>
            </div>
            <div>
              <dt>状态</dt>
              <dd>
                待处理 {jobs.counts.pending} · 完成 {jobs.counts.done} · 失败 {jobs.counts.failed}
              </dd>
            </div>
            <div>
              <dt>最早一条</dt>
              <dd>{jobs.oldestDoneAt ? jobs.oldestDoneAt.slice(0, 10) : "—"}</dd>
            </div>
          </dl>
          <div className="backup-actions">
            <label className="backup-reminder-field">
              <span>清理早于</span>
              <select
                value={pruneDays}
                disabled={busy}
                onChange={(e) => setPruneDays(Number(e.target.value))}
              >
                {[30, 90, 180, 365].map((d) => (
                  <option key={d} value={d}>
                    {d} 天
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn"
              disabled={busy || (jobs.prunable === 0 && jobs.counts.total === 0)}
              onClick={() => setConfirming("jobs")}
            >
              清理历史记录…
            </button>
          </div>
          <p className="muted">
            只清理「完成 / 失败」且早于所选天数的记录；待处理记录是崩溃恢复的唯一线索，永不清理。
          </p>
        </>
      ) : (
        <p className="muted">{loadError ? `读取失败：${loadError}` : "正在读取作业记录…"}</p>
      )}

      {notice && (
        <p className="backup-notice" role="status">
          {notice}
        </p>
      )}

      {confirming === "quarantine" && quarantine && (
        <div className="maintenance-confirm" role="alertdialog" aria-label="确认清理隔离文件">
          <p>
            将删除 {removable.length} 个隔离文件（{bytesLabel(quarantine.removableBytes)}）：
          </p>
          <p className="muted">{removable.map((i) => i.name).join("、")}</p>
          <p className="muted">这些文件没有任何数据库记录引用，删除后不可恢复。</p>
          <div className="backup-actions">
            <button type="button" className="btn btn-danger" onClick={clearQuarantine}>
              确认删除
            </button>
            <button type="button" className="btn" onClick={() => setConfirming(null)}>
              取消
            </button>
          </div>
        </div>
      )}

      {confirming === "jobs" && jobs && (
        <div className="maintenance-confirm" role="alertdialog" aria-label="确认清理作业记录">
          <p>
            将删除「完成 / 失败」且早于 {pruneDays} 天的作业记录，当前匹配 {jobs.prunable} 条。
          </p>
          <p className="muted">
            待处理 {jobs.counts.pending} 条会保留；这只是历史记录，不影响任何附件文件。
          </p>
          <div className="backup-actions">
            <button type="button" className="btn btn-danger" onClick={pruneJobs}>
              确认清理
            </button>
            <button type="button" className="btn" onClick={() => setConfirming(null)}>
              取消
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
