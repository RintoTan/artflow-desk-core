import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import UnsavedChangesDialog from "../components/UnsavedChangesDialog";
import { usePageShortcuts } from "../lib/shortcuts";
import { useUnsavedGuard } from "../lib/unsavedRegistry";
import {
  api,
  clientApi,
  clientTagApi,
  describeError,
  isConflict,
  type ClientDetail,
  type ClientTag,
  type ClientView,
} from "../bridge/commands";

type Draft = { displayName: string; contact: string; note: string };

/** 金额展示：NULL 表示未知，绝不显示成 0。 */
function formatKnownAmount(cents: number): string {
  return `¥${(cents / 100).toFixed(2).replace(/\.00$/, "")}`;
}

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

  const [allTags, setAllTags] = useState<ClientTag[]>([]);
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [newTagName, setNewTagName] = useState("");
  const [tagBusy, setTagBusy] = useState(false);
  const [timezone, setTimezone] = useState<string | null>(null);
  const navigate = useNavigate();

  const dirty = detail !== null && draft !== null && !sameDraft(draft, draftFrom(detail.client));
  const creatingDirty = creating && newName.trim() !== "";

  useUnsavedGuard({
    id: "clients",
    label: dirty ? "客户资料" : "新建客户",
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

  /** 最近下单时间按工作时时区格式化，不能用 UTC 直接截日期。 */
  const formatMoment = useCallback(
    (value: string | null) => {
      if (!value) return "—";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      try {
        return new Intl.DateTimeFormat("zh-CN", {
          timeZone: timezone ?? undefined,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(date);
      } catch {
        return date.toLocaleDateString("zh-CN");
      }
    },
    [timezone],
  );

  const refreshTags = useCallback(async () => {
    const [tags, list] = await Promise.all([clientTagApi.list(), clientApi.list()]);
    setAllTags(tags);
    setClients(list);
    if (selectedId) {
      const next = await clientApi.detail(selectedId);
      setDetail(next);
    }
  }, [selectedId]);

  const runTag = useCallback(
    async (action: () => Promise<void>) => {
      setTagBusy(true);
      setError(null);
      try {
        await action();
      } catch (e) {
        setError(describeError(e));
      } finally {
        setTagBusy(false);
      }
    },
    [],
  );

  const addTagToClient = useCallback(
    (tagId: string) => {
      if (!selectedId) return;
      void runTag(async () => {
        const tags = await clientTagApi.link(selectedId, tagId);
        setDetail((current) =>
          current ? { ...current, client: { ...current.client, tags } } : current,
        );
        setAllTags(await clientTagApi.list());
      });
    },
    [runTag, selectedId],
  );

  const removeTagFromClient = useCallback(
    (tagId: string) => {
      if (!selectedId) return;
      void runTag(async () => {
        const tags = await clientTagApi.unlink(selectedId, tagId);
        setDetail((current) =>
          current ? { ...current, client: { ...current.client, tags } } : current,
        );
        setAllTags(await clientTagApi.list());
      });
    },
    [runTag, selectedId],
  );

  const createTag = useCallback(() => {
    const name = newTagName.trim();
    if (name === "") return;
    void runTag(async () => {
      const tag = await clientTagApi.create(name);
      setNewTagName("");
      setAllTags(await clientTagApi.list());
      if (selectedId) {
        const tags = await clientTagApi.link(selectedId, tag.id);
        setDetail((current) =>
          current ? { ...current, client: { ...current.client, tags } } : current,
        );
        setAllTags(await clientTagApi.list());
      }
    });
  }, [newTagName, runTag, selectedId]);

  const deleteTag = useCallback(
    (tagId: string) => {
      void runTag(async () => {
        await clientTagApi.remove(tagId);
        await refreshTags();
        if (tagFilter === tagId) setTagFilter("all");
      });
    },
    [refreshTags, runTag, tagFilter],
  );

  const visibleClients = useMemo(() => {
    if (tagFilter === "all") return clients;
    return clients.filter((client) => client.tags.some((tag) => tag.id === tagFilter));
  }, [clients, tagFilter]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [list, tags, status] = await Promise.all([
          clientApi.list(),
          clientTagApi.list(),
          api.status(),
        ]);
        if (!alive) return;
        setClients(list);
        setAllTags(tags);
        setTimezone(status.workingTimezone);
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
    <div className="orders-layout clients-page">
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

        <div className="list-tools">
          <select
            className="select-inline"
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
            aria-label="按标签筛选客户"
          >
            <option value="all">所有标签</option>
            {allTags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}（{tag.clientCount}）
              </option>
            ))}
          </select>
        </div>

        {clients.length === 0 ? (
          <div className="empty">
            <p>还没有客户档案。</p>
            <p className="muted">新建订单时也可以直接创建客户。</p>
          </div>
        ) : (
          <ul className="order-rows">
            {visibleClients.map((client) => (
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
                  {client.tags.length > 0 && (
                    <span className="tag-row">
                      {client.tags.map((tag) => (
                        <span key={tag.id} className="tag-chip">
                          {tag.name}
                        </span>
                      ))}
                    </span>
                  )}
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
                <h2>客户概览</h2>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => navigate(`/orders?client=${encodeURIComponent(detail.client.id)}`)}
                >
                  查看该客户的订单
                </button>
              </header>
              <dl className="stat-row">
                <div>
                  <dt>当前关联订单</dt>
                  <dd>{detail.client.orderCount}</dd>
                  <p className="muted">
                    活动中 {detail.client.activeCount} · 已完成 {detail.client.completedCount}
                  </p>
                </div>
                <div>
                  <dt>已知委托金额</dt>
                  <dd>{formatKnownAmount(detail.client.knownAmountCents)}</dd>
                  <p className="muted">金额未知的订单不计入，也不算 0 元</p>
                </div>
                <div>
                  <dt>最近下单</dt>
                  <dd>{formatMoment(detail.client.lastOrderAt)}</dd>
                  <p className="muted">取现存订单里最晚的一次创建时间</p>
                </div>
              </dl>
              <p className="muted stat-note">
                以上都是按现存订单实时统计：完成与已取消的订单仍然计入；
                订单被永久删除后会随剩余订单重算。这里没有收款事实，所以不叫「实收」。
              </p>
            </section>

            <section className="panel">
              <header className="panel-head compact">
                <h2>标签</h2>
                <span className="muted">手工维护，不自动生成等级</span>
              </header>

              <div className="tag-row">
                {detail.client.tags.length === 0 && (
                  <span className="muted">还没有标签</span>
                )}
                {detail.client.tags.map((tag) => (
                  <span key={tag.id} className="tag-chip">
                    {tag.name}
                    <button
                      type="button"
                      className="tag-remove"
                      aria-label={`移除标签 ${tag.name}`}
                      disabled={tagBusy}
                      onClick={() => removeTagFromClient(tag.id)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>

              <div className="tag-editor">
                <select
                  className="select-inline"
                  value=""
                  aria-label="添加已有标签"
                  disabled={tagBusy || allTags.length === 0}
                  onChange={(e) => {
                    if (e.target.value) addTagToClient(e.target.value);
                  }}
                >
                  <option value="">添加已有标签…</option>
                  {allTags
                    .filter((tag) => !detail.client.tags.some((mine) => mine.id === tag.id))
                    .map((tag) => (
                      <option key={tag.id} value={tag.id}>
                        {tag.name}
                      </option>
                    ))}
                </select>
                <input
                  className="list-search"
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  maxLength={20}
                  placeholder="新建标签，例如 长期客户"
                  aria-label="新建标签名称"
                  disabled={tagBusy}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={tagBusy || newTagName.trim() === ""}
                  onClick={createTag}
                >
                  新建并添加
                </button>
              </div>

              {allTags.length > 0 && (
                <details className="tag-manage">
                  <summary>管理全部标签</summary>
                  <ul>
                    {allTags.map((tag) => (
                      <li key={tag.id}>
                        <span>{tag.name}</span>
                        <span className="muted">{tag.clientCount} 位客户</span>
                        <button
                          type="button"
                          className="link-btn"
                          disabled={tagBusy || tag.clientCount > 0}
                          title={
                            tag.clientCount > 0
                              ? "仍有客户使用，请先移除关联"
                              : "删除这个标签"
                          }
                          onClick={() => deleteTag(tag.id)}
                        >
                          删除
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
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
