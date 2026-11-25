import { useCallback, useEffect, useRef, useState } from "react";

import {
  describeError,
  financeApi,
  type DeletePlatformReport,
  type PlatformView,
} from "../bridge/commands";
import ConfirmDialog from "./ConfirmDialog";
import EmptyState from "./EmptyState";

/**
 * FIN-02：接单平台与默认手续费率。
 *
 * 界面上有三件事必须让人一眼看懂，否则财务数据从一开始就是错的：
 * 1. **「未设置」不是「0%」**。前者是费率还没配过，后者是明确免费。
 * 2. **归档只是不再可选**，配置和名称都还在，随时能恢复。
 * 3. **删除只删配置行**，历史收款流水的平台名、费率、手续费快照仍然保留。
 *
 * 费率的解析和校验全在后端：这里只把用户输入的原文送过去，不在前端另写一套。
 */

type Props = {
  onError: (message: string | null) => void;
};

type FormState = {
  /** 有 id = 编辑；没有 = 新建。 */
  id?: string;
  name: string;
  rate: string;
};

/** 基点 → 界面百分比。整数运算，不经过浮点。 */
export function formatRate(bp: number | null): string {
  if (bp === null) return "未设置";
  const whole = Math.trunc(bp / 100);
  const cents = Math.abs(bp % 100);
  return `${whole}.${String(cents).padStart(2, "0")}%`;
}

/** 反向：把已有的基点回显到输入框（不带百分号）。 */
export function rateToInput(bp: number | null): string {
  if (bp === null) return "";
  const whole = Math.trunc(bp / 100);
  const cents = Math.abs(bp % 100);
  return `${whole}.${String(cents).padStart(2, "0")}`;
}

export default function PlatformsPanel({ onError }: Props) {
  const [platforms, setPlatforms] = useState<PlatformView[] | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PlatformView | null>(null);
  const [deleteReport, setDeleteReport] = useState<DeletePlatformReport | null>(null);
  const [drag, setDrag] = useState<{ id: string; index: number } | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await financeApi.platforms();
      setPlatforms(rows);
      onError(null);
    } catch (error) {
      onError(describeError(error));
      setPlatforms([]);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (form) nameRef.current?.focus();
  }, [form]);

  const active = (platforms ?? []).filter((p) => !p.archived);
  const archived = (platforms ?? []).filter((p) => p.archived);

  function startCreate() {
    setNotice(null);
    setFormError(null);
    setForm({ name: "", rate: "" });
  }

  function startEdit(platform: PlatformView) {
    setNotice(null);
    setFormError(null);
    setForm({ id: platform.id, name: platform.name, rate: rateToInput(platform.feeRateBp) });
  }

  async function save() {
    if (!form || busy) return;
    setBusy(true);
    setFormError(null);
    try {
      const payload = {
        name: form.name,
        feeRate: form.rate.trim() === "" ? null : form.rate.trim(),
      };
      if (form.id) {
        await financeApi.updatePlatform({ id: form.id, ...payload });
        setNotice(`已保存「${form.name.trim()}」`);
      } else {
        await financeApi.createPlatform(payload);
        setNotice(`已添加「${form.name.trim()}」`);
      }
      setForm(null);
      await load();
    } catch (error) {
      // 失败时保留用户正在编辑的内容，绝不静默清空。
      setFormError(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  async function archive(platform: PlatformView) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await financeApi.archivePlatform(platform.id);
      setNotice(`已归档「${platform.name}」。它不再出现在新收款的选择里，随时可恢复。`);
      await load();
    } catch (error) {
      setFormError(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  async function restore(platform: PlatformView) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await financeApi.restorePlatform(platform.id);
      setNotice(`已恢复「${platform.name}」`);
      await load();
    } catch (error) {
      setFormError(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete || busy) return;
    setBusy(true);
    try {
      const report = await financeApi.deletePlatform(pendingDelete.id);
      setDeleteReport(report);
      setPendingDelete(null);
      await load();
    } catch (error) {
      setFormError(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  const commitOrder = useCallback(
    async (next: PlatformView[]) => {
      setBusy(true);
      try {
        const rows = await financeApi.reorderPlatforms(next.map((p) => p.id));
        setPlatforms(rows);
        setNotice("排序已保存");
        setFormError(null);
      } catch (error) {
        setFormError(describeError(error));
        await load();
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= active.length || busy) return;
    const next = [...active];
    const moved = next[index];
    if (!moved) return;
    next.splice(index, 1);
    next.splice(target, 0, moved);
    void commitOrder(next);
  }

  // 指针拖拽：只在「正常使用」组内生效，归档组不参与。
  useEffect(() => {
    if (!drag) return;

    function indexAt(clientY: number): number | null {
      const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-platform-row]");
      if (!rows) return null;
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows.item(i);
        if (!row) continue;
        const rect = row.getBoundingClientRect();
        if (clientY >= rect.top && clientY <= rect.bottom) return i;
      }
      return null;
    }

    function onMove(event: PointerEvent) {
      setHoverIndex(indexAt(event.clientY));
    }
    function onUp(event: PointerEvent) {
      const target = indexAt(event.clientY);
      const from = drag?.index ?? null;
      setDrag(null);
      setHoverIndex(null);
      if (from === null || target === null || target === from) return;
      const next = [...active];
      const moved = next[from];
      if (!moved) return;
      next.splice(from, 1);
      next.splice(target, 0, moved);
      void commitOrder(next);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // active 由 platforms 派生，commitOrder 依赖 load；这里只需在拖动期间绑定一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, platforms, commitOrder]);

  return (
    <section className="panel settings-module settings-module-full platform-panel">
      <h2>接单平台与手续费</h2>
      <p className="muted">
        这里维护的是<strong>收款渠道</strong>与它们的默认手续费率。平台是工具配置，重置业务数据时会保留；
        修改默认费率只影响以后新建的收款记录，不会改写历史流水里已经记下的费率与手续费。
      </p>

      {notice && <p className="notice notice-ok">{notice}</p>}
      {formError && (
        <p className="notice notice-error" role="alert">
          {formError}
        </p>
      )}

      {deleteReport && (
        <p className="notice notice-ok">
          已删除「{deleteReport.name}」的配置。
          {deleteReport.detachedPayments > 0
            ? `有 ${deleteReport.detachedPayments} 笔收款流水失去了平台关联，但它们的平台名称、费率与手续费快照仍然保留，历史金额不受影响。`
            : "没有收款流水引用它。"}
        </p>
      )}

      {form && (
        <form
          className="platform-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="field">
            <label htmlFor="platform-name">平台名称</label>
            <input
              id="platform-name"
              ref={nameRef}
              value={form.name}
              maxLength={40}
              placeholder="例如：米画师、画加、私信"
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="platform-rate">默认手续费率（%）</label>
            <input
              id="platform-rate"
              value={form.rate}
              inputMode="decimal"
              placeholder="留空表示未设置"
              onChange={(event) => setForm({ ...form, rate: event.target.value })}
            />
            <p className="hint">
              最多两位小数，范围 0–100。留空不等于 0：留空表示「还没配过」，0 表示明确不收手续费。
            </p>
          </div>
          <div className="platform-form-actions">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "保存中…" : form.id ? "保存修改" : "添加平台"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                setForm(null);
                setFormError(null);
              }}
            >
              取消
            </button>
          </div>
        </form>
      )}

      {!form && (
        <div className="platform-toolbar">
          <button type="button" className="btn btn-primary" onClick={startCreate} disabled={busy}>
            添加平台
          </button>
        </div>
      )}

      {platforms === null ? (
        <p className="muted">正在读取平台配置…</p>
      ) : platforms.length === 0 ? (
        <div className="platform-empty">
          <EmptyState title="还没有任何平台" />
          <p className="muted">
            程序不会替你预置平台。按你实际接单的渠道添加即可；不添加也可以，未关联平台的收款仍然允许记录。
          </p>
        </div>
      ) : (
        <>
          <h3 className="platform-group-title">正常使用</h3>
          {active.length === 0 ? (
            <p className="muted">没有正常使用的平台，全部已归档。</p>
          ) : (
            <ul className="platform-list" ref={listRef}>
              {active.map((platform, index) => (
                <li
                  key={platform.id}
                  data-platform-row
                  className={`platform-row${
                    drag?.id === platform.id ? " is-dragging" : ""
                  }${hoverIndex === index && drag && drag.index !== index ? " is-drop-target" : ""}`}
                >
                  <span
                    className="platform-grip"
                    role="button"
                    tabIndex={-1}
                    aria-label={`拖动 ${platform.name} 调整顺序`}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.preventDefault();
                      setDrag({ id: platform.id, index });
                    }}
                  >
                    ⋮⋮
                  </span>
                  <span className="platform-name">{platform.name}</span>
                  <span className="platform-rate">{formatRate(platform.feeRateBp)}</span>
                  <span className="platform-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-label={`上移 ${platform.name}`}
                      disabled={busy || index === 0}
                      onClick={() => move(index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-label={`下移 ${platform.name}`}
                      disabled={busy || index === active.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      ↓
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => startEdit(platform)}>
                      编辑
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => void archive(platform)}>
                      归档
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm platform-danger"
                      onClick={() => setPendingDelete(platform)}
                    >
                      删除
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {archived.length > 0 && (
            <>
              <h3 className="platform-group-title">已归档</h3>
              <p className="hint">
                归档的平台不会出现在新收款的选择里，但名称仍被占用；恢复后按原位置参与排序。
              </p>
              <ul className="platform-list">
                {archived.map((platform) => (
                  <li key={platform.id} className="platform-row is-archived">
                    <span className="platform-grip is-disabled" aria-hidden="true">
                      ⋮⋮
                    </span>
                    <span className="platform-name">{platform.name}</span>
                    <span className="platform-rate">{formatRate(platform.feeRateBp)}</span>
                    <span className="platform-actions">
                      <button type="button" className="btn btn-sm" onClick={() => startEdit(platform)}>
                        编辑
                      </button>
                      <button type="button" className="btn btn-sm" onClick={() => void restore(platform)}>
                        恢复
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm platform-danger"
                        onClick={() => setPendingDelete(platform)}
                      >
                        删除
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="永久删除这个平台？"
        confirmLabel="永久删除"
        danger
        busy={busy}
        error={formError}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
      >
        <p>
          即将删除平台「{pendingDelete?.name}」的配置。删除后名称可以重新使用。
        </p>
        <p className="muted">
          已有收款流水<strong>不会</strong>被删除：它们的平台名称、费率和实际手续费快照会继续保留，
          历史金额不受影响。
        </p>
      </ConfirmDialog>
    </section>
  );
}
