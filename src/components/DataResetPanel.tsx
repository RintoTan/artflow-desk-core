import { useMemo, useState } from "react";

import {
  api,
  describeError,
  type DataResetInput,
  type ResetReport,
} from "../bridge/commands";
import ConfirmDialog from "./ConfirmDialog";

/**
 * DEV-0.1.1-04：数据重置。
 *
 * 界面的职责是把「影响范围」讲清楚，并且绝不把部分成功说成成功。
 * 六项默认全不勾：这里每一条都是不可逆的用户数据操作。
 */

type OptionId = "business" | "settings" | "reminder" | "backups" | "logs" | "quarantine";

type Option = {
  id: OptionId;
  label: string;
  scope: string;
  note: string;
  /** 需要单独强调的风险 */
  risk?: string;
};

const OPTIONS: Option[] = [
  {
    id: "business",
    label: "业务数据包",
    scope: "客户、委托订单、制作阶段与历史、改期历史、附件原图与缩略图、流程模板、队列状态、客户标签",
    note: "整体重置，不可拆分。执行方式为新建数据代际：旧数据保留在旧代际目录中，可人工取回。",
  },
  {
    id: "settings",
    label: "用户设置与偏好",
    scope: "工作时区、列表密度、启动页、当前主题、自定义主题",
    note: "恢复为程序内置的默认值，自定义主题会被删除，内置主题保留。",
  },
  {
    id: "reminder",
    label: "备份提醒状态",
    scope: "提醒周期与上次错误信息",
    note: "提醒周期归零（等于关闭提醒）；最近一次成功备份的时间会保留。",
  },
  {
    id: "backups",
    label: "本地备份文件",
    scope: "数据目录下 backups/ 中由本应用管理的文件",
    note: "只清理本应用的备份目录，不会越界删除其它文件。",
  },
  {
    id: "logs",
    label: "运行日志",
    scope: "应用数据目录下 logs/ 中的日志文件",
    note: "只影响日志，不影响任何业务数据。",
  },
  {
    id: "quarantine",
    label: "附件隔离区",
    scope: "当前代际的 attachments/quarantine/",
    note: "隔离区存放导入失败时被移走的文件。",
    risk: "清理后将失去崩溃恢复的比对线索。",
  },
];

const LABEL: Record<string, string> = Object.fromEntries(
  OPTIONS.map((option) => [option.id, option.label]),
);

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

const OVERALL_TEXT: Record<string, string> = {
  all_ok: "全部成功",
  partial: "部分成功",
  all_failed: "全部失败",
};

export default function DataResetPanel({ onError }: { onError: (message: string) => void }) {
  const [picked, setPicked] = useState<OptionId[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ResetReport | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const pendingOptions = useMemo(
    () => OPTIONS.filter((option) => picked.includes(option.id)),
    [picked],
  );
  const failed = useMemo(
    () => (report?.items ?? []).filter((item) => item.status === "failed"),
    [report],
  );

  function toggle(id: OptionId) {
    setPicked((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );
  }

  function flags(list: OptionId[]): DataResetInput {
    return {
      business: list.includes("business"),
      settings: list.includes("settings"),
      reminder: list.includes("reminder"),
      backups: list.includes("backups"),
      logs: list.includes("logs"),
      quarantine: list.includes("quarantine"),
    };
  }

  async function run(input: DataResetInput) {
    setBusy(true);
    setDialogError(null);
    try {
      const result = await api.dataReset(input);
      setReport(result);
      setConfirming(false);
      if (result.overall === "all_failed") {
        const reason = result.items.find((i) => i.reason)?.reason ?? "全部项目失败";
        onError(reason);
      }
    } catch (e) {
      const message = describeError(e);
      setDialogError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  const needsRestart =
    report?.newGeneration !== null && report?.newGeneration !== undefined;

  return (
    <section className="panel settings-module settings-module-full" data-testid="data-reset">
      <h2>数据重置</h2>
      <p className="muted">
        选择要清理的内容。每一项都会被单独执行并单独报告结果，部分失败不会掩盖已完成的项目。
      </p>

      <ul className="reset-options">
        {OPTIONS.map((option) => (
          <li key={option.id} className="reset-option">
            <label className="reset-option-head">
              <input
                type="checkbox"
                checked={picked.includes(option.id)}
                onChange={() => toggle(option.id)}
                disabled={busy}
              />
              <span className="reset-option-label">{option.label}</span>
            </label>
            <p className="reset-option-scope">影响范围：{option.scope}</p>
            <p className="muted reset-option-note">{option.note}</p>
            {option.risk && <p className="reset-option-risk">{option.risk}</p>}
          </li>
        ))}
      </ul>

      <div className="reset-actions">
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy || picked.length === 0}
          onClick={() => {
            setDialogError(null);
            setConfirming(true);
          }}
        >
          {picked.length === 0 ? "请先选择要重置的项目" : `重置选中的 ${picked.length} 项`}
        </button>
        <span className="muted reset-hint">
          重置不会删除订单编号记录，历史编号永不复用。
        </span>
      </div>

      {report && (
        <div className="reset-report" data-testid="reset-report">
          <h3 className={`reset-overall is-${report.overall}`}>
            {OVERALL_TEXT[report.overall] ?? report.overall}
          </h3>
          <ul className="reset-results">
            {report.items.map((item) => (
              <li key={item.option} className={`reset-result is-${item.status}`}>
                <span className="reset-result-name">{LABEL[item.option] ?? item.option}</span>
                <span className="reset-result-status">
                  {item.status === "ok" ? "已完成" : item.status === "failed" ? "失败" : "未执行"}
                </span>
                {item.detail && <span className="muted reset-result-detail">{item.detail}</span>}
                {item.reason && <span className="reset-result-reason">{item.reason}</span>}
              </li>
            ))}
          </ul>

          {report.snapshotPath && (
            <p className="muted reset-note">
              重置前的安全快照：<code>{report.snapshotPath}</code>
            </p>
          )}

          {report.newGeneration && (
            <p className="muted reset-note">
              已切换到新代际 <code>{report.newGeneration}</code>；旧代际保留在{" "}
              <code>{report.oldGenerationPath}</code>（约 {formatBytes(report.oldGenerationBytes)}）。
              旧代际不会自动删除。
            </p>
          )}

          <div className="reset-actions">
            {failed.length > 0 && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void run({ ...flags([]), only: failed.map((i) => i.option) })}
              >
                仅重试失败的 {failed.length} 项
              </button>
            )}
            {needsRestart && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void api.restartApp()}
              >
                重启应用以使用新数据
              </button>
            )}
          </div>

          {needsRestart && (
            <p className="reset-restart-warning">
              业务数据已经切换到新代际，但当前窗口仍在读取旧数据。请重启应用后再继续使用，否则新操作会写进旧代际。
            </p>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        title="确认重置数据"
        confirmLabel={busy ? "正在执行…" : "确认重置"}
        danger
        busy={busy}
        error={dialogError}
        onCancel={() => setConfirming(false)}
        onConfirm={() => run(flags(picked))}
      >
        <p>以下项目会被清理，且无法通过撤销恢复：</p>
        <ul className="reset-confirm-list">
          {pendingOptions.map((option) => (
            <li key={option.id}>
              <strong>{option.label}</strong>
              <span className="muted">：{option.scope}</span>
              {option.risk && <span className="reset-option-risk">（{option.risk}）</span>}
            </li>
          ))}
        </ul>
        {picked.includes("business") && (
          <p className="muted">
            业务数据会先自动生成一份安全快照，再切换到新的空代际；旧代际目录完整保留。
          </p>
        )}
      </ConfirmDialog>
    </section>
  );
}
