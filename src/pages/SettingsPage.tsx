import { useEffect, useState } from "react";
import { api, describeError, type TimezoneInfo } from "../bridge/commands";
import { usePageShortcuts } from "../lib/shortcuts";
import { useUnsavedGuard } from "../lib/unsavedRegistry";

const COMMON_ZONES = [
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
  "UTC",
];

export default function SettingsPage() {
  const [info, setInfo] = useState<TimezoneInfo | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .timezoneGet()
      .then((value) => {
        setInfo(value);
        setDraft(value.workingTimezone);
      })
      .catch((e) => setError(describeError(e)));
  }, []);

  async function apply(): Promise<string | null> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = await api.timezoneSet(draft.trim());
      setInfo(next);
      setDraft(next.workingTimezone);
      setMessage("工作时区已保存。历史事件的时间点不会改变，只影响展示、提醒与统计月份归属。");
      return null;
    } catch (e) {
      const text = describeError(e);
      setError(text);
      return text;
    } finally {
      setBusy(false);
    }
  }

  const dirty = info !== null && draft.trim() !== "" && draft.trim() !== info.workingTimezone;

  useUnsavedGuard({
    id: "settings",
    dirty,
    save: () => apply(),
    discard: () => {
      if (info) setDraft(info.workingTimezone);
    },
  });

  usePageShortcuts({
    onSave: () => {
      if (dirty && !busy) void apply();
    },
  });

  return (
    <>
      <section className="panel">
        <header className="panel-head">
          <div>
            <h2>工作时区</h2>
            <p className="muted">
              计划日期是日历日期，事件时间是真实时间点。修改时区不会改动已保存的时间点。
            </p>
          </div>
        </header>

        {info && (
          <div className="row">
            <span className="row-label">当前</span>
            <span className="row-value mono">{info.workingTimezone}</span>
          </div>
        )}
        {info && (
          <div className="row">
            <span className="row-label">系统时区</span>
            <span className="row-value mono">
              {info.systemTimezone}
              {info.sameAsSystem ? "" : "（与工作时区不同）"}
            </span>
          </div>
        )}

        <div className="field">
          <label htmlFor="tz">IANA 时区名称</label>
          <input
            id="tz"
            list="tz-options"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            placeholder="例如 Asia/Shanghai"
          />
          <datalist id="tz-options">
            {COMMON_ZONES.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
          <p className="hint">必须是有效的 IANA 名称；非法值会被拒绝保存。</p>
        </div>

        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={apply} disabled={busy}>
            {busy ? "保存中…" : "保存时区"}
          </button>
        </div>

        {message && <p className="notice notice-ok">{message}</p>}
        {error && <p className="notice notice-error">{error}</p>}
      </section>

      <section className="panel panel-quiet">
        <h2>本阶段尚未提供的设置</h2>
        <p className="muted">
          主题编辑、列表密度、启动页面、备份提醒等属于后续阶段，界面在此明确标注，
          不会用占位控件伪装成已实现功能。
        </p>
      </section>
    </>
  );
}
