import { useCallback, useEffect, useState } from "react";

import ConfirmDialog from "../components/ConfirmDialog";
import UnsavedChangesDialog from "../components/UnsavedChangesDialog";
import { usePageShortcuts } from "../lib/shortcuts";
import { useUnsavedGuard } from "../lib/unsavedRegistry";
import { describeError, isConflict, templateApi, type TemplateView } from "../bridge/commands";

type DraftStep = { stepId: string | null; title: string };
type Draft = { name: string; steps: DraftStep[] };

function draftFrom(template: TemplateView): Draft {
  return {
    name: template.name,
    steps: template.steps.map((s) => ({ stepId: s.stepId, title: s.title })),
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  if (a.name.trim() !== b.name.trim()) return false;
  if (a.steps.length !== b.steps.length) return false;
  return a.steps.every(
    (step, i) => step.stepId === b.steps[i]?.stepId && step.title.trim() === b.steps[i]?.title.trim(),
  );
}

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<TemplateView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newStepTitle, setNewStepTitle] = useState("");

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<{ id: string } | { create: true } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TemplateView | null>(null);
  const [deleteReplacement, setDeleteReplacement] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const selected = templates.find((t) => t.id === selectedId) ?? null;
  const dirty = selected !== null && draft !== null && !sameDraft(draft, draftFrom(selected));
  const creatingDirty = creating && newName.trim() !== "";

  useUnsavedGuard({
    id: "templates",
    label: dirty ? "流程模板" : "新建模板",
    dirty: dirty || creatingDirty,
    save: async () => {
      if (dirty) return save();
      if (creatingDirty) return create();
      return null;
    },
    discard: () => {
      if (selected) setDraft(draftFrom(selected));
      setNewName("");
      setCreating(false);
    },
  });

  usePageShortcuts({
    onNew: () => {
      if (!creating) setCreating(true);
    },
    onSave: () => {
      if (dirty && !busy) void save();
    },
  });

  const load = useCallback(async () => {
    const list = await templateApi.list();
    setTemplates(list);
    return list;
  }, []);

  const select = useCallback((id: string, list?: TemplateView[]) => {
    const source = list ?? templates;
    const target = source.find((t) => t.id === id);
    setSelectedId(id);
    setDraft(target ? draftFrom(target) : null);
    setCreating(false);
    setError(null);
    setNotice(null);
  }, [templates]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await templateApi.list();
        if (!alive) return;
        setTemplates(list);
        if (list[0]) {
          setSelectedId(list[0].id);
          setDraft(draftFrom(list[0]));
        }
      } catch (e) {
        if (alive) setError(describeError(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function save(): Promise<string | null> {
    if (!selected || !draft) return null;
    setBusy(true);
    setError(null);
    try {
      const updated = await templateApi.update({
        templateId: selected.id,
        expectedRevision: selected.revision,
        name: draft.name,
        steps: draft.steps.map((s) => ({ stepId: s.stepId, title: s.title })),
      });
      const list = await load();
      setSelectedId(updated.id);
      setDraft(draftFrom(updated));
      setNotice(`模板已保存（${list.length} 个模板）`);
      return null;
    } catch (e) {
      const message = isConflict(e)
        ? `${describeError(e)} 修改仍保留在表单中。`
        : describeError(e);
      setError(message);
      return message;
    } finally {
      setBusy(false);
    }
  }

  async function create(): Promise<string | null> {
    setBusy(true);
    setError(null);
    try {
      const created = await templateApi.create({
        name: newName,
        steps: [{ stepId: null, title: "草稿" }],
        makeDefault: templates.length === 0,
      });
      const list = await load();
      setNewName("");
      setCreating(false);
      select(created.id, list);
      setNotice("模板已创建，请继续编辑阶段");
      return null;
    } catch (e) {
      const message = describeError(e);
      setError(message);
      return message;
    } finally {
      setBusy(false);
    }
  }

  async function duplicate() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const copy = await templateApi.duplicate({
        sourceId: selected.id,
        name: `${selected.name} 副本`,
      });
      const list = await load();
      select(copy.id, list);
      setNotice("已复制为新模板");
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const replacementCandidates = deleteTarget
    ? templates.filter((t) => t.id !== deleteTarget.id)
    : [];

  function requestDelete() {
    if (!selected) return;
    if (templates.length <= 1) {
      setError("至少需要保留一个模板，无法删除");
      return;
    }
    const others = templates.filter((t) => t.id !== selected.id);
    setDeleteTarget(selected);
    setDeleteReplacement(selected.isDefault ? (others[0]?.id ?? "") : "");
    setDeleteError(null);
  }

  function cancelDelete() {
    if (deleteBusy) return;
    setDeleteTarget(null);
    setDeleteError(null);
  }

  async function confirmDelete() {
    const target = deleteTarget;
    if (!target || deleteBusy) return;
    if (target.isDefault && !deleteReplacement) {
      setDeleteError("请先选择替代的默认模板");
      return;
    }
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const list = await templateApi.remove({
        templateId: target.id,
        expectedRevision: target.revision,
        replacementDefaultId: target.isDefault ? deleteReplacement : null,
      });
      setTemplates(list);
      setDeleteTarget(null);
      if (list[0]) {
        setSelectedId(list[0].id);
        setDraft(draftFrom(list[0]));
      } else {
        setSelectedId(null);
        setDraft(null);
      }
      setNotice(`模板「${target.name}」已删除`);
    } catch (e) {
      // 失败保持对话框打开并说明原因，绝不假装成功。
      setDeleteError(describeError(e));
      if (isConflict(e)) {
        try {
          const list = await load();
          const fresh = list.find((t) => t.id === target.id);
          if (fresh) {
            setDeleteTarget(fresh);
            setDeleteReplacement(fresh.isDefault ? (list.find((t) => t.id !== fresh.id)?.id ?? "") : "");
          }
        } catch {
          /* 保留原始错误 */
        }
      }
    } finally {
      setDeleteBusy(false);
    }
  }

  async function makeDefault() {
    if (!selected || selected.isDefault) return;
    setBusy(true);
    setError(null);
    try {
      const list = await templateApi.setDefault({ templateId: selected.id });
      setTemplates(list);
      const updated = list.find((t) => t.id === selected.id);
      if (updated) setDraft(draftFrom(updated));
      setNotice("已设为默认模板");
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  function attemptSelect(id: string) {
    if (id === selectedId) return;
    if (dirty) {
      setPendingSwitch({ id });
      return;
    }
    select(id);
  }

  function patchStep(index: number, title: string) {
    if (!draft) return;
    const steps = draft.steps.map((s, i) => (i === index ? { ...s, title } : s));
    setDraft({ ...draft, steps });
  }

  function moveStep(index: number, delta: number) {
    if (!draft) return;
    const target = index + delta;
    if (target < 0 || target >= draft.steps.length) return;
    const steps = [...draft.steps];
    const [moved] = steps.splice(index, 1);
    if (!moved) return;
    steps.splice(target, 0, moved);
    setDraft({ ...draft, steps });
  }

  function removeStep(index: number) {
    if (!draft) return;
    if (draft.steps.length <= 1) {
      setError("模板至少需要保留一个阶段");
      return;
    }
    setDraft({ ...draft, steps: draft.steps.filter((_, i) => i !== index) });
  }

  if (loading) return <section className="panel">正在读取流程模板…</section>;

  return (
    <div className="orders-layout">
      <aside className="orders-list panel">
        <header className="panel-head compact">
          <div>
            <h2>流程模板</h2>
            <p className="muted">{templates.length} 个 · 唯一默认</p>
          </div>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => {
              if (dirty) {
                setPendingSwitch({ create: true });
                return;
              }
              setCreating(true);
            }}
          >
            新建
          </button>
        </header>

        <ul className="order-rows">
          {templates.map((template) => (
            <li key={template.id}>
              <button
                type="button"
                className={`order-row${template.id === selectedId ? " order-row-active" : ""}`}
                onClick={() => attemptSelect(template.id)}
              >
                <span className="order-row-top">
                  <span className="order-row-title">{template.name}</span>
                  {template.isDefault && <span className="chip chip-active">默认</span>}
                </span>
                <span className="order-row-meta">
                  {template.stepCount} 个阶段 · {template.usageCount} 单使用
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="orders-detail">
        {error && (
          <div className="banner banner-error">
            <span>{error}</span>
            <button type="button" className="btn btn-sm" onClick={() => setError(null)}>
              关闭
            </button>
          </div>
        )}
        {notice && (
          <div className="banner banner-ok">
            <span>{notice}</span>
            <button type="button" className="btn btn-sm" onClick={() => setNotice(null)}>
              关闭
            </button>
          </div>
        )}

        {creating ? (
          <section className="panel">
            <header className="panel-head compact">
              <h2>新建模板</h2>
              <span className="muted">先起一个名字，再从「草稿」开始加阶段</span>
            </header>
            <label className="field">
              <span>模板名称 *</span>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={80}
                autoFocus
                disabled={busy}
              />
            </label>
            <div className="actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || newName.trim() === ""}
                onClick={() => void create()}
              >
                创建模板
              </button>
              <button type="button" className="btn" onClick={() => setCreating(false)} disabled={busy}>
                取消
              </button>
            </div>
          </section>
        ) : !selected || !draft ? (
          <section className="panel empty">
            <p>从左侧选择一个模板。</p>
          </section>
        ) : (
          <section className="panel">
            <header className="panel-head">
              <div>
                <h1 className="detail-title">{selected.name}</h1>
                <p className="muted">
                  {selected.stepCount} 个阶段 · 版本 {selected.revision} · {selected.usageCount} 单使用
                  {selected.isDefault ? " · 默认模板" : ""}
                  {dirty ? " · 有未保存修改" : ""}
                </p>
              </div>
            </header>

            <label className="field field-wide">
              <span>模板名称 *</span>
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                maxLength={80}
                disabled={busy}
              />
            </label>

            <div className="stage-list-wrap">
              <ol className="stage-list">
                {draft.steps.map((step, index) => (
                  <li key={step.stepId ?? `new-${index}`} className="stage">
                    <span className="stage-index">{index + 1}</span>
                    <input
                      className="stage-input"
                      value={step.title}
                      onChange={(e) => patchStep(index, e.target.value)}
                      maxLength={80}
                      disabled={busy}
                      aria-label={`阶段 ${index + 1} 名称`}
                    />
                    <span className="stage-tools">
                      <button
                        type="button"
                        className="link-btn"
                        disabled={busy || index === 0}
                        onClick={() => moveStep(index, -1)}
                      >
                        上移
                      </button>
                      <button
                        type="button"
                        className="link-btn"
                        disabled={busy || index === draft.steps.length - 1}
                        onClick={() => moveStep(index, 1)}
                      >
                        下移
                      </button>
                      <button
                        type="button"
                        className="link-btn link-danger"
                        disabled={busy || draft.steps.length <= 1}
                        onClick={() => removeStep(index)}
                      >
                        删除
                      </button>
                    </span>
                  </li>
                ))}
              </ol>
            </div>

            <div className="stage-add">
              <input
                value={newStepTitle}
                onChange={(e) => setNewStepTitle(e.target.value)}
                placeholder="新增阶段名称"
                maxLength={80}
                disabled={busy}
              />
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy || newStepTitle.trim() === "" || draft.steps.length >= 20}
                onClick={() => {
                  setDraft({
                    ...draft,
                    steps: [...draft.steps, { stepId: null, title: newStepTitle.trim() }],
                  });
                  setNewStepTitle("");
                }}
              >
                添加阶段
              </button>
              <span className="muted">最多 20 个阶段</span>
            </div>

            <div className="actions action-bar">
              <div className="action-group" role="group" aria-label="保存模板">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void save()}
                  disabled={busy || !dirty}
                >
                  保存模板
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setDraft(draftFrom(selected))}
                  disabled={busy || !dirty}
                >
                  还原修改
                </button>
              </div>
              <div className="action-group" role="group" aria-label="模板操作">
                <button
                  type="button"
                  className="btn"
                  onClick={() => void makeDefault()}
                  disabled={busy || selected.isDefault}
                >
                  设为默认
                </button>
                <button type="button" className="btn" onClick={() => void duplicate()} disabled={busy}>
                  复制为新模板
                </button>
              </div>
              <div className="action-group action-group-end" role="group" aria-label="危险操作">
                <button
                  type="button"
                  className="btn btn-quiet-danger"
                  onClick={requestDelete}
                  disabled={busy || templates.length <= 1}
                >
                  删除模板…
                </button>
              </div>
            </div>

            <p className="muted">
              修改模板不会影响已经创建的订单：订单在创建时复制了当时的阶段。
            </p>
          </section>
        )}

        <ConfirmDialog
          open={deleteTarget !== null}
          title="确认删除流程模板？"
          danger
          confirmLabel="确认删除"
          busy={deleteBusy}
          error={deleteError}
          confirmDisabled={deleteTarget !== null && deleteTarget.isDefault && deleteReplacement === ""}
          onCancel={cancelDelete}
          onConfirm={confirmDelete}
        >
          {deleteTarget && (
            <>
              <p>
                即将删除模板 <strong>「{deleteTarget.name}」</strong>（{deleteTarget.stepCount} 个阶段）。
              </p>
              <p>删除模板不会改变已经创建订单的独立制作流程——订单在创建时就复制了当时的阶段。</p>
              {deleteTarget.isDefault && (
                <label className="field">
                  <span>该模板是当前的默认模板，请先选择替代的默认模板 *</span>
                  <select
                    value={deleteReplacement}
                    onChange={(e) => setDeleteReplacement(e.target.value)}
                    disabled={deleteBusy}
                  >
                    <option value="">请选择</option>
                    {replacementCandidates.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name}（{candidate.stepCount} 个阶段）
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}
        </ConfirmDialog>

        <UnsavedChangesDialog
          open={pendingSwitch !== null}
          detail="切换模板会丢失尚未保存的修改。"
          busy={busy}
          onSaveAndLeave={async () => {
            await save();
            const target = pendingSwitch;
            setPendingSwitch(null);
            if (!target) return;
            if ("create" in target) setCreating(true);
            else select(target.id);
          }}
          onDiscard={() => {
            const target = pendingSwitch;
            setPendingSwitch(null);
            if (!target) return;
            if ("create" in target) setCreating(true);
            else select(target.id);
          }}
          onStay={() => setPendingSwitch(null)}
        />
      </section>
    </div>
  );
}
