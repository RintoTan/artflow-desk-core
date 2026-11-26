import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import ClientReferencePanel from "../components/ClientReferencePanel";
import OrderThumb from "../components/OrderThumb";
import ConfirmDialog from "../components/ConfirmDialog";
import UnsavedChangesDialog from "../components/UnsavedChangesDialog";
import ClientFinancePanel from "../components/ClientFinancePanel";
import { filterAndSortClients } from "../lib/clientsView";
import { orderStatusLabel } from "../lib/orderStatus";
import { usePageShortcuts } from "../lib/shortcuts";
import { useUnsavedGuard } from "../lib/unsavedRegistry";
import { useQaRefresh } from "../lib/qaRefresh";
import {
  api,
  clientApi,
  clientTagApi,
  clientRefApi,
  describeError,
  isConflict,
  trashApi,
  type ClientCover,
  type ClientDeleteImpact,
  type ClientDetail,
  type ClientTag,
  type ClientView,
  type OrderView,
} from "../bridge/commands";
import EmptyState from "../components/EmptyState";

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
  // 客户列表封面：clientId -> 该客户最近一张参考图
  const [covers, setCovers] = useState<Record<string, ClientCover>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    const ids = clients.map((client) => client.id);
    if (ids.length === 0) {
      setCovers({});
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const list = await clientRefApi.covers(ids);
        if (!alive) return;
        const next: Record<string, ClientCover> = {};
        for (const cover of list) next[cover.clientId] = cover;
        setCovers(next);
      } catch {
        // 封面只是装饰，拿不到就显示占位块，不影响列表本身
        if (alive) setCovers({});
      }
    })();
    return () => {
      alive = false;
    };
  }, [clients]);
  const [detail, setDetail] = useState<ClientDetail | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteImpact, setDeleteImpact] = useState<ClientDeleteImpact | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteInFlight = useRef(false);
  /** 影响范围请求的序号：旧请求返回时如果序号已变，就不再写回状态。 */
  const impactSeq = useRef(0);
  const refreshQa = useQaRefresh();
  const [pendingSwitch, setPendingSwitch] = useState<{ id: string } | { create: true } | null>(null);

  const [allTags, setAllTags] = useState<ClientTag[]>([]);
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"default" | "recent" | "orders">("default");
  /** 详情里的订单分组要用完整订单（含归档、计划交付），list_clients 的 brief 没有这些字段。 */
  const [orders, setOrders] = useState<OrderView[]>([]);
  const [newTagName, setNewTagName] = useState("");
  /** 标签编辑器默认收起：右栏常驻的是「当前有哪些标签」，改标签是低频动作。 */
  const [tagEditorOpen, setTagEditorOpen] = useState(false);
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

  /** 打开删除确认前先取影响范围：订单总数与「其中已在回收站」的数量都必须来自服务端。 */
  const openDeleteClient = useCallback(async () => {
    if (!detail) return;
    const seq = ++impactSeq.current;
    setDeleteImpact(null);
    setDeleteError(null);
    setDeleteOpen(true);
    try {
      const impact = await trashApi.clientDeleteImpact(detail.client.id);
      // 期间可能已经取消并换了别的客户；旧结果一律丢弃。
      if (seq !== impactSeq.current) return;
      setDeleteImpact(impact);
    } catch (e) {
      if (seq !== impactSeq.current) return;
      setDeleteError(describeError(e));
    }
  }, [detail]);

  const moveClientToTrash = useCallback(async () => {
    if (!detail || !deleteImpact || deleteInFlight.current) return;
    // 确认框展示的影响范围必须就是当前这个客户，否则不执行。
    if (deleteImpact.clientId !== detail.client.id) return;

    const targetId = deleteImpact.clientId;
    deleteInFlight.current = true;
    setDeleteBusy(true);
    setDeleteError(null);

    let result;
    try {
      result = await trashApi.deleteClient(targetId);
    } catch (e) {
      setDeleteError(describeError(e));
      deleteInFlight.current = false;
      setDeleteBusy(false);
      return;
    }

    // 删除已经成功。之后的列表刷新失败属于「数据已变、界面没跟上」，
    // 不能写回确认框当成删除失败，更不能再显示一次确认框。
    setDeleteOpen(false);
    setDeleteImpact(null);
    setDetail(null);
    setDraft(null);
    setNotice(
      result.ordersTrashed > 0
        ? `已移入回收站（含 ${result.ordersTrashed} 个订单）`
        : "已移入回收站",
    );
    refreshQa();

    try {
      await loadList();
    } catch (e) {
      setError(describeError(e));
    } finally {
      deleteInFlight.current = false;
      setDeleteBusy(false);
    }
  }, [detail, deleteImpact, loadList, refreshQa]);

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

  const visibleClients = useMemo(
    () => filterAndSortClients(clients, { query, tagId: tagFilter, sort }),
    [clients, tagFilter, query, sort],
  );

  /**
   * 详情里的订单分组。
   * 分组用客户详情自带的 orders（后端已按客户过滤），再用完整订单补齐
   * 计划交付与归档标记——brief 里没有这两项。补不到就退化为 brief 的字段，
   * 不因为列表还没加载出来而显示成「没有订单」。
   */
  const clientOrderGroups = useMemo(() => {
    const brief = detail?.orders ?? [];
    const full = new Map(orders.map((order) => [order.id, order]));
    const mine = brief.map((item) => {
      const extra = full.get(item.id);
      return {
        id: item.id,
        code: item.code,
        title: item.title,
        status: item.status,
        currentStageTitle: item.currentStageTitle,
        plannedDeliveryDate: extra?.plannedDeliveryDate ?? null,
        archivedAt: extra?.archivedAt ?? null,
      };
    });
    return [
      { key: "active", label: "进行中", items: mine.filter((order) => order.status === "active") },
      { key: "complete", label: "已完成", items: mine.filter((order) => order.status === "complete") },
      { key: "cancelled", label: "已取消", items: mine.filter((order) => order.status === "cancelled") },
    ];
  }, [orders, detail]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [list, tags, status, orderList] = await Promise.all([
          clientApi.list(),
          clientTagApi.list(),
          api.status(),
          api.listOrders(),
        ]);
        if (!alive) return;
        setClients(list);
        setAllTags(tags);
        setOrders(orderList);
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
            <h2>客户管理</h2>
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
          <div className="search-box">
            <input
              type="search"
              value={query}
              placeholder="搜索客户名称"
              aria-label="搜索客户名称"
              onChange={(e) => setQuery(e.target.value)}
            />
            {query !== "" && (
              <button
                type="button"
                className="btn btn-sm"
                aria-label="清空客户搜索"
                onClick={() => setQuery("")}
              >
                清空
              </button>
            )}
          </div>
          <select
            className="select-inline"
            value={sort}
            onChange={(e) => setSort(e.target.value as "default" | "recent" | "orders")}
            aria-label="客户排序"
          >
            <option value="default">默认顺序</option>
            <option value="recent">最近委托</option>
            <option value="orders">订单数量</option>
          </select>
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
            <EmptyState title="还没有客户档案" />
            <p className="muted">新建订单时也可以直接创建客户。</p>
          </div>
        ) : visibleClients.length === 0 ? (
          <div className="empty">
            <p>没有匹配的客户。</p>
            <p className="muted">换个名称，或清空搜索与标签筛选。</p>
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
                  <OrderThumb
                    cover={
                      covers[client.id]
                        ? {
                            orderId: client.id,
                            attachmentId: covers[client.id]!.attachmentId,
                            role: null,
                            thumbPath: covers[client.id]!.thumbPath,
                            originalPath: covers[client.id]!.originalPath,
                            mimeType: "image/*",
                          }
                        : undefined
                    }
                  />
                  <span className="order-row-body">
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
            {/* 宽屏：资料在左，概览与标签在右；窄屏自动单列，草稿不受影响。 */}
            <div className="client-columns">
            <div className="client-col client-col-main">
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
            </div>


              <section className="panel client-orders">
                <header className="panel-head compact">
                  <h2>关联订单</h2>
                  <span className="muted">
                    {clientOrderGroups.reduce((sum, group) => sum + group.items.length, 0)} 笔 · 含已归档
                  </span>
                </header>

                {clientOrderGroups.every((group) => group.items.length === 0) ? (
                  <EmptyState inline title="这位客户还没有关联订单" />
                ) : (
                  clientOrderGroups.map((group) => (
                    <div className="client-order-group" key={group.key}>
                      <h3 className="client-order-group-head">
                        {group.label}
                        <span className="muted">{group.items.length} 笔</span>
                      </h3>
                      {group.items.length === 0 ? (
                        <p className="muted client-order-empty">暂无</p>
                      ) : (
                        <ul className="order-rows">
                          {group.items.map((order) => (
                            <li key={order.id}>
                              <button
                                type="button"
                                className="order-row"
                                onClick={() => navigate(`/orders?orderId=${encodeURIComponent(order.id)}`)}
                              >
                                <span className="order-row-title">
                                  <code className="order-code">{order.code}</code> {order.title}
                                </span>
                                <span className="order-row-meta">
                                  {orderStatusLabel(order.status)}
                                  {order.status === "active"
                                    ? ` · 当前阶段 ${order.currentStageTitle ?? "未开始"}`
                                    : ""}
                                  {order.plannedDeliveryDate ? ` · 交付 ${order.plannedDeliveryDate}` : " · 未排期"}
                                </span>
                                {order.archivedAt !== null && <span className="chip chip-archived">已归档</span>}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))
                )}

                <div className="actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => navigate(`/orders?client=${encodeURIComponent(detail.client.id)}`)}
                  >
                    在订单信息中查看全部
                  </button>
                </div>
              </section>

            <div className="client-col client-col-side">
              <ClientReferencePanel clientId={detail.client.id} />
            <section className="panel">
              <header className="panel-head compact">
                <h2>客户概览</h2>
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

            <ClientFinancePanel clientId={detail.client.id} />

            <section className="panel">
              <header className="panel-head compact">
                <h2>标签</h2>
                <span className="muted">手工维护，不自动生成等级</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-expanded={tagEditorOpen}
                  onClick={() => setTagEditorOpen((open) => !open)}
                >
                  {tagEditorOpen ? "收起" : "管理标签"}
                </button>
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

              <div className={tagEditorOpen ? "tag-editor" : "tag-editor tag-editor-collapsed"}>
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

            {/* 数据归档：与订单详情同一套折叠卡片，默认收起。 */}
            <details className="panel archive-zone">
              <summary className="archive-zone-summary">
                <span className="archive-zone-heading">
                  <span className="archive-zone-title">数据归档</span>
                  <span className="muted archive-zone-sub">收起不常用的收纳与删除</span>
                </span>
              </summary>
              <div className="archive-zone-body">
                <div className="archive-zone-row">
                  <div>
                    <p className="archive-zone-label">移入回收站</p>
                    <p className="muted archive-zone-hint">
                      客户与其名下的全部订单会一起移入回收站，制作历史与附件都会保留。
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn btn-quiet-danger btn-sm"
                    disabled={busy || deleteBusy}
                    onClick={() => void openDeleteClient()}
                  >
                    移入回收站…
                  </button>
                </div>
              </div>
            </details>
            </div>
            </div>



          </>
        )}

        <ConfirmDialog
          open={deleteOpen}
          title="移入回收站？"
          confirmLabel="移入回收站"
          busy={deleteBusy}
          error={deleteError}
          confirmDisabled={
            deleteImpact === null || deleteImpact.clientId !== detail?.client.id
          }
          onCancel={() => {
            if (deleteBusy) return;
            // 让仍在路上的影响范围请求作废。
            impactSeq.current += 1;
            setDeleteOpen(false);
            setDeleteImpact(null);
            setDeleteError(null);
          }}
          onConfirm={moveClientToTrash}
        >
          {deleteImpact ? (
            <>
              <p>
                客户「{deleteImpact.clientName}」及其 {deleteImpact.orderCount} 个关联订单将一起移入回收站，
                可随时恢复。
              </p>
              {deleteImpact.alreadyTrashed > 0 ? (
                <p className="muted">
                  其中 {deleteImpact.alreadyTrashed} 个订单此前已在回收站，本次将一并归入该客户组。
                </p>
              ) : null}
            </>
          ) : (
            <p className="muted">正在统计影响范围…</p>
          )}
        </ConfirmDialog>

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
