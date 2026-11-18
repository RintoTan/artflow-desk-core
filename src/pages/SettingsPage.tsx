import { useEffect, useRef, useState } from "react";
import { api, describeError, type TimezoneInfo } from "../bridge/commands";
import { AppIconImage } from "../components/AppIconImage";
import {
  DEFAULT_ICON_VARIANT,
  ICON_DESCRIPTION,
  ICON_LABEL,
  ICON_VARIANTS,
  clearIconPreview,
  hasIconPreview,
  persistIcon,
  savedIcon,
  setIconPreview,
  subscribeIcon,
  type IconVariant,
} from "../lib/appIcon";
import { useAppearance } from "../lib/useAppearance";
import { usePageShortcuts } from "../lib/shortcuts";
import { useUnsavedGuard } from "../lib/unsavedRegistry";
import {
  DEFAULT_CHOICE,
  checkAccent,
  clearPreview,
  hasPreview,
  normalizeAccent,
  subscribeTheme,
  persistTheme,
  resolveTheme,
  savedChoice,
  setPreview,
  systemPrefersDark,
  type ThemeChoice,
  type ThemeMode,
} from "../lib/theme";

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

/** 离页提示要说清"哪些东西还没存"，否则用户不知道关掉会丢什么。 */
function dirtyLabel(parts: { timezoneDirty: boolean; themeDirty: boolean; iconDirty: boolean }) {
  const names: string[] = [];
  if (parts.themeDirty) names.push("主题");
  if (parts.iconDirty) names.push("应用图标");
  if (parts.timezoneDirty) names.push("工作时区");
  return names.length ? names.join("与") : "设置";
}

const MODE_LABEL: Record<ThemeMode, string> = {
  arctic: "Arctic Blue（默认浅色）",
  dark: "深色",
  system: "跟随系统",
};

export default function SettingsPage() {
  const [info, setInfo] = useState<TimezoneInfo | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [themeDraft, setThemeDraft] = useState<ThemeChoice>(() => savedChoice());
  const [themeSaved, setThemeSaved] = useState<ThemeChoice>(() => savedChoice());
  const [iconDraft, setIconDraft] = useState<IconVariant>(() => savedIcon());
  const [iconSaved, setIconSaved] = useState<IconVariant>(() => savedIcon());
  const themeDirtyRef = useRef(false);
  const iconDirtyRef = useRef(false);
  const syncedRef = useRef(false);
  const iconSyncedRef = useRef(false);

  useEffect(() => {
    api
      .timezoneGet()
      .then((value) => {
        setInfo(value);
        setDraft(value.workingTimezone);
      })
      .catch((e) => setError(describeError(e)));
  }, []);

  // 主题可能在设置页打开后才加载完成；只有"当前没有草稿"时才同步，避免覆盖用户的修改。
  useEffect(
    () =>
      subscribeTheme(() => {
        // 只在"还没同步过、且没有草稿"时同步一次。
        // 预览也会触发通知，若这里无条件覆盖，用户刚选的模式会被立刻打回去。
        if (themeDirtyRef.current || syncedRef.current || hasPreview()) return;
        const next = savedChoice();
        setThemeSaved(next);
        setThemeDraft(next);
        syncedRef.current = true;
      }),
    [],
  );

  // 图标同理：后端读盘完成后才同步一次，不覆盖用户已经点过的预览。
  useEffect(
    () =>
      subscribeIcon(() => {
        if (iconDirtyRef.current || iconSyncedRef.current || hasIconPreview()) return;
        const next = savedIcon();
        setIconSaved(next);
        setIconDraft(next);
        iconSyncedRef.current = true;
      }),
    [],
  );

  // 卡片主图跟着"当前实际生效外观"走（主题预览已经过 setPreview，这里读到的是预览值）
  const iconAppearance = useAppearance();

  const timezoneDirty =
    info !== null && draft.trim() !== "" && draft.trim() !== info.workingTimezone;
  const themeDirty =
    themeDraft.mode !== themeSaved.mode ||
    normalizeAccent(themeDraft.accent) !== normalizeAccent(themeSaved.accent);
  const iconDirty = iconDraft !== iconSaved;
  const dirty = timezoneDirty || themeDirty || iconDirty;
  themeDirtyRef.current = themeDirty;
  iconDirtyRef.current = iconDirty;

  function previewTheme(next: ThemeChoice) {
    setThemeDraft(next);
    setPreview(next);
  }

  function previewIcon(next: IconVariant) {
    setIconDraft(next);
    setIconPreview(next);
  }

  async function apply(): Promise<string | null> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (themeDirty) {
        const themeError = await persistTheme(themeDraft);
        if (themeError) {
          // 主题没存上：不清预览、不改已保存值，用户还能继续调整。
          setError(`主题：${themeError}`);
          return themeError;
        }
        setThemeSaved(savedChoice());
      }
      if (iconDirty) {
        const iconError = await persistIcon(iconDraft);
        if (iconError) {
          // 图标没存上：保留预览与草稿，主题已经落库的不回滚。
          setError(`应用图标：${iconError}`);
          return iconError;
        }
        setIconSaved(savedIcon());
      }
      if (timezoneDirty) {
        const next = await api.timezoneSet(draft.trim());
        setInfo(next);
        setDraft(next.workingTimezone);
      }
      setMessage("设置已保存。");
      return null;
    } catch (e) {
      const text = describeError(e);
      setError(text);
      return text;
    } finally {
      setBusy(false);
    }
  }

  useUnsavedGuard({
    id: "settings",
    // 传函数：保存掉一项之后，提示里就不该再写着它
    label: () => dirtyLabel({ timezoneDirty, themeDirty, iconDirty }),
    dirty,
    save: () => apply(),
    discard: () => {
      clearPreview();
      clearIconPreview();
      setThemeDraft(themeSaved);
      setIconDraft(iconSaved);
      if (info) setDraft(info.workingTimezone);
    },
  });

  usePageShortcuts({
    onSave: () => {
      if (dirty && !busy) void apply();
    },
  });

  const resolved = resolveTheme(themeDraft.mode, systemPrefersDark());
  const accent = normalizeAccent(themeDraft.accent);
  const accentCheck = accent ? checkAccent(accent, resolved) : null;

  return (
    <>
      <section className="panel">
        <header className="panel-head">
          <div>
            <h2>外观</h2>
            <p className="muted">
              选择的是「模式」，实际外观由模式和系统共同决定。跟随系统时改的是系统的深色开关，
              这里不会把当前外观记成你的选择。
            </p>
          </div>
        </header>

        <div className="row">
          <span className="row-label">用户选择</span>
          <span className="row-value">{MODE_LABEL[themeDraft.mode]}</span>
        </div>
        <div className="row">
          <span className="row-label">当前实际外观</span>
          <span className="row-value">
            {resolved === "dark" ? "深色" : "浅色"}
            {themeDraft.mode === "system" ? `（系统当前：${systemPrefersDark() ? "深色" : "浅色"}）` : ""}
          </span>
        </div>
        <div className="row">
          <span className="row-label">已保存</span>
          <span className="row-value">
            {MODE_LABEL[themeSaved.mode]}
            {themeSaved.accent ? ` · 强调色 ${themeSaved.accent}` : " · 主题自带强调色"}
          </span>
        </div>

        <div className="settings-modules">
        <section className="settings-module">
        <div className="field">
          <span>主题模式</span>
          <div className="segmented" role="group" aria-label="主题模式">
            {(["arctic", "dark", "system"] as ThemeMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className={themeDraft.mode === mode ? "btn btn-primary" : "btn"}
                aria-pressed={themeDraft.mode === mode}
                onClick={() => previewTheme({ ...themeDraft, mode })}
              >
                {MODE_LABEL[mode]}
              </button>
            ))}
          </div>
          <p className="hint">切换会立刻预览，但只有点「保存设置」才会写入。</p>
        </div>

        </section>
        <section className="settings-module">
        <div className="field">
          <label htmlFor="accent">
            <span>强调色</span>
          </label>
          <div className="inline-row">
            <input
              id="accent"
              type="color"
              className="color-input"
              value={accent ?? "#2c6fb5"}
              onChange={(e) => previewTheme({ ...themeDraft, accent: e.target.value })}
            />
            <input
              aria-label="强调色十六进制"
              value={accent ?? ""}
              placeholder="留空用主题自带色，例如 #2c6fb5"
              spellCheck={false}
              onChange={(e) => {
                const raw = e.target.value.trim();
                previewTheme({ ...themeDraft, accent: raw === "" ? null : raw });
              }}
            />
            <button
              type="button"
              className="btn"
              onClick={() => previewTheme({ ...themeDraft, accent: null })}
            >
              用默认色
            </button>
          </div>
          <p className="hint">
            只接受 #rrggbb；只影响强调色相关的按钮、焦点与选中态，不改动页面结构。
          </p>
          {accent === null && themeDraft.accent !== null && (
            <p className="notice notice-error" role="alert">
              强调色格式不对（需要 #rrggbb），已按默认色预览，保存时会拒绝。
            </p>
          )}
          {accentCheck?.message && (
            <p className={accentCheck.level === "warn" ? "notice notice-warn" : "notice"} role="status">
              {accentCheck.message}
            </p>
          )}
        </div>

        </section>
        <section className="settings-module settings-module-wide">
        <div className="field field-wide">
          <span>应用图标</span>
          <div className="icon-grid" role="group" aria-label="应用图标">
            {ICON_VARIANTS.map((variant) => {
              const selected = iconDraft === variant;
              return (
                <button
                  key={variant}
                  type="button"
                  className={selected ? "icon-card icon-card-active" : "icon-card"}
                  aria-pressed={selected}
                  aria-label={`应用图标 ${ICON_LABEL[variant]}（${ICON_DESCRIPTION[variant]}）`}
                  onClick={() => previewIcon(variant)}
                >
                  <AppIconImage
                    className="icon-card-art"
                    variant={variant}
                    appearance={iconAppearance}
                    size={64}
                  />
                  <span className="icon-card-name">{ICON_LABEL[variant]}</span>
                  <span className="icon-card-desc">{ICON_DESCRIPTION[variant]}</span>
                  <span className="icon-card-state" aria-hidden={!selected}>
                    {selected ? (iconSaved === variant ? "已保存" : "未保存") : ""}
                  </span>
                  {/* 只做展示：两套配色都给你看一眼，不构成第二套主题设置 */}
                  <span className="icon-card-pair">
                    <AppIconImage
                      className="icon-card-mini"
                      variant={variant}
                      appearance="light"
                      size={26}
                    />
                    <span className="icon-card-pair-label">浅色</span>
                    <AppIconImage
                      className="icon-card-mini"
                      variant={variant}
                      appearance="dark"
                      size={26}
                    />
                    <span className="icon-card-pair-label">深色</span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="icon-scale-row">
            <span className="muted">32px 实际大小</span>
            {ICON_VARIANTS.map((variant) => (
              <AppIconImage
                key={variant}
                className="icon-scale-item"
                variant={variant}
                appearance={iconAppearance}
                size={32}
                alt={ICON_LABEL[variant]}
              />
            ))}
            <button
              type="button"
              className="link-btn"
              onClick={() => previewIcon(DEFAULT_ICON_VARIANT)}
            >
              恢复默认图标
            </button>
          </div>
          <p className="hint">
            点卡片立刻预览左上角品牌图标；只有点「保存设置」才会写入。图标只换品牌图形，
            不会改动主题强调色、订单状态色和错误提示色。
          </p>
          <p className="hint">
            目前只切换<b>应用内</b>品牌图标。macOS Dock 图标与安装包图标不随此设置变化，
            原因与可选方案见 <code>docs/DEV06B-ICON-RESULTS.md</code>。
          </p>
        </div>
        </section>
        </div>

        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={apply} disabled={busy || !dirty}>
            {busy ? "保存中…" : "保存设置"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!dirty || busy}
            onClick={() => {
              clearPreview();
              clearIconPreview();
              setThemeDraft(themeSaved);
              setIconDraft(iconSaved);
              if (info) setDraft(info.workingTimezone);
            }}
          >
            放弃修改
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => previewTheme({ ...DEFAULT_CHOICE })}
          >
            恢复默认主题
          </button>
        </div>
        {dirty && (
          <p className="hint">
            有未保存的修改。离开本页或关闭窗口会先问你。
          </p>
        )}

        {message && <p className="notice notice-ok">{message}</p>}
        {/* 保存失败必须被读屏念出来，否则用户会以为已经存上了 */}
        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
      </section>

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
      </section>

      <section className="panel panel-quiet">
        <h2>本阶段尚未提供的设置</h2>
        <p className="muted">
          启动页面、备份提醒等属于后续阶段，界面在此明确标注，不会用占位控件伪装成已实现功能。
        </p>
      </section>
    </>
  );
}
