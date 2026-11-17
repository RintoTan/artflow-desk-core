import { useCallback, useEffect, useState } from "react";

import UnsavedChangesDialog from "../components/UnsavedChangesDialog";
import { usePageShortcuts } from "../lib/shortcuts";
import { useUnsavedGuard } from "../lib/unsavedRegistry";
import {
  clientApi,
  describeError,
  isConflict,
  type ClientDetail,
  type ClientView,
} from "../bridge/commands";

type Draft = { displayName: string; contact: string; note: string };

function draftFrom(client: ClientView): Draft {
  return {
    displayName: client.displayName,
    contact: client.contact ?? "",
    note: client.note ?? "",
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.displayName.trim() === b.displayName.trim() &&
    a.contact.trim() === b.contact.trim() &&
    a.note.trim() === b.note.trim()
  );
}

export default function ClientsPage() {
  const [clients, setClients] = useState<ClientView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ClientDetail | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<{ id: string } | { create: true } | null>(null);

  const dirty = detail !== null && draft !== null && !sameDraft(draft, draftFrom(detail.client));
  const creatingDirty = creating && newName.trim() !== "";

  useUnsavedGuard({
    id: "clients",
    dirty: dirty || creatingDirty,
    save: async () => {
      if (dirty) return save();
      if (creatingDirty) return create();
      return null;
    },
    discard: () => {
      if (detail) setDraft(draftFrom(detail.client));
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

  const loadList = useCallback(async () => {
    const list = await clientApi.list();
    setClients(list);
  }, []);

  const select = useCallback(async (id: string) => {
    setError(null);
    setNotice(null);
    try {
      const next = await clientApi.detail(id);
      setSelectedId(id);
      setDetail(next);
      setDraft(draftFrom(next.client));
      setCreating(false);
    } catch (e) {
      setError(describeError(e));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await clientApi.list();
        if (!alive) return;
        setClients(list);
        if (list[0]) await select(list[0].id);
      } catch (e) {
        if (alive) setError(describeError(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [select]);

  async function save(): Promise<string | null> {
    if (!detail || !draft) return null;
    setBusy(true);
    setError(null);
    try {
      const updated = await clientApi.update({
        clientId: detail.client.id,
        expectedRevision: detail.client.revision,
        displayName: draft.displayName,
        contact: draft.contact.trim() === "" ? null : draft.contact,
        note: draft.note.trim() === "" ? null : draft.note,
      });
      setDetail({ ...detail, client: updated });
      setDraft(draftFrom(updated));
      setNotice("客户资料已保存");
      void loadList();
      return null;
    } catch (e) {
      const message = isConflict(e)
        ? `${describeError(e)} 你的修改仍保留在表单中。`
        : describeError(e);
      setError(message);
      if (isConflict(e)) {
        try {
          const latest = await clientApi.detail(detail.client.id);
          setDetail({ ...latest, orders: detail.orders });
        } catch {
          /* 保留原错误 */
        }
      }
      return message;
    } finally {
      setBusy(false);
    }
  }

  async function create(): Promise<string | null> {
    setBusy(true);
    setError(null);
    try {
      const created = await clientApi.create({ displayName: newName });
      setNewName("");
      setCreating(false);
      await loadList();
      await select(created.id);
      setNotice(`已创建客户「${created.displayName}」`);
      return null;
    } catch (e) {
      const message = describeError(e);
      setError(message);
      return message;
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
    void select(id);
  }

  if (loading) return <section className="panel">正在读取客户…</section>;

  return (
    <div className="orders-layout">
      <aside className="orders-list panel">
        <header className="panel-head compact">
          <div>
            <h2>客户</h2>
            <p className="muted">{clients.length} 位 · 同名不合并</p>
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
              setDetail(null);
              setSelectedId(null);
              setDraft(null);
            }}
          >
            新建
          </button>
        </header>

        {clients.length === 0 ? (
          <div className="empty">
            <p>还没有客户档案。</p>
            <p className="muted">新建订单时也可以直接创建客户。</p>
          </div>
        ) : (
          <ul className="order-rows">
            {clients.map((client) => (
              <li key={client.id}>
                <button
                  type="button"
                  className={`order-row${client.id === selectedId ? " order-row-active" : ""}`}
                  onClick={() => attemptSelect(client.id)}
                >
                  <span className="order-row-title">{client.displayName}</span>
                  <span className="order-row-meta">
                    {client.orderCount} 单
                    {client.activeCount > 0 ? ` · 活动中 ${client.activeCount}` : ""}
                    {client.completedCount > 0 ? ` · 已完成 ${client.completedCount}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
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
              <h2>新建客户</h2>
            </header>
            <label className="field">
              <span>客户名称 *</span>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={120}
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
                创建客户
              </button>
              <button type="button" className="btn" onClick={() => setCreating(false)} disabled={busy}>
                取消
              </button>
            </div>
          </section>
        ) : !detail || !draft ? (
          <section className="panel empty">
            <p>从左侧选择一位客户。</p>
          </section>
        ) : (
          <>
            <section className="panel">
              <header className="panel-head">
                <div>
                  <h1 className="detail-title">{detail.client.displayName}</h1>
                  <p className="muted">
                    {detail.client.orderCount} 单 · 版本 {detail.client.revision}
                    {dirty ? " · 有未保存修改" : ""}
                  </p>
                </div>
              </header>

              <div className="form-grid">
                <label className="field field-wide">
                  <span>显示名称 *</span>
                  <input
                    value={draft.displayName}
                    onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                    maxLength={120}
                    disabled={busy}
                  />
                </label>
                <label className="field">
                  <span>联系方式</span>
                  <input
                    value={draft.contact}
                    onChange={(e) => setDraft({ ...draft, contact: e.target.value })}
                    maxLength={200}
                    disabled={busy}
                  />
                </label>
                <label className="field field-wide">
                  <span>备注</span>
                  <textarea
                    value={draft.note}
                    onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                    rows={2}
                    maxLength={2000}
                    disabled={busy}
                  />
                </label>
              </div>

              <div className="actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void save()}
                  disabled={busy || !dirty}
                >
                  保存客户资料
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setDraft(draftFrom(detail.client))}
                  disabled={busy || !dirty}
                >
                  还原修改
                </button>
              </div>
            </section>

            <section className="panel">
              <header className="panel-head compact">
                <h2>关联订单</h2>
                <span className="muted">{detail.orders.length} 单</span>
              </header>
              {detail.orders.length === 0 ? (
                <p className="muted">这位客户还没有关联订单。</p>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>编号</th>
                      <th>标题</th>
                      <th>状态</th>
                      <th>当前阶段</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.orders.map((order) => (
                      <tr key={order.id}>
                        <td className="mono">{order.code}</td>
                        <td>{order.title}</td>
                        <td>{order.status}</td>
                        <td>{order.currentStageTitle ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </>
        )}

        <UnsavedChangesDialog
          open={pendingSwitch !== null}
          detail="切换客户会丢失尚未保存的资料修改。"
          busy={busy}
          onSaveAndLeave={async () => {
            await save();
            const target = pendingSwitch;
            setPendingSwitch(null);
            if (!target) return;
            if ("create" in target) {
              setCreating(true);
              setDetail(null);
              setDraft(null);
            } else {
              await select(target.id);
            }
          }}
          onDiscard={() => {
            const target = pendingSwitch;
            setPendingSwitch(null);
            if (!target) return;
            if ("create" in target) {
              setCreating(true);
              setDetail(null);
              setDraft(null);
            } else {
              void select(target.id);
            }
          }}
          onStay={() => setPendingSwitch(null)}
        />
      </section>
    </div>
  );
}
