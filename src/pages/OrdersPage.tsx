import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBlocker, useSearchParams } from "react-router-dom";
import { save } from "@tauri-apps/plugin-dialog";

import AttachmentPanel from "../components/AttachmentPanel";
import OrderBoard from "../components/OrderBoard";
import OrderTable from "../components/OrderTable";
import ConfirmDialog from "../components/ConfirmDialog";
import { ScheduleOverview } from "../components/ScheduleOverview";
import { TruncatedTitle } from "../components/TitleTooltip";
import { localDayIndex } from "../lib/scheduleBar";
import UnsavedChangesDialog from "../components/UnsavedChangesDialog";
import {
  densityClass,
  dropIndex,
  filterOrders,
  riskBadge,
  type RiskFilter,
  type SourceFilter,
  type StatusFilter,
  type WorkFilter,
} from "../lib/ordersView";
import type { StageMovePlan } from "../lib/board";
import { usePageShortcuts } from "../lib/shortcuts";
import { useUnsavedGuard } from "../lib/unsavedRegistry";
import {
  api,
  describeError,
  isConflict,
  newRequestId,
  preferenceApi,
  queueApi,
  statsApi,
  templateApi,
  type ClientView,
  type ListDensity,
  type TemplateView,
  type CreateOrderInput,
  type OrderEvent,
  type OrderView,
  type UpdateDetailsInput,
} from "../bridge/commands";

// ---------------------------------------------------------------- 展示辅助

const STATUS_LABEL: Record<string, string> = {
  active: "活动",
  complete: "已完成",
  cancelled: "已取消",
};

const WORK_LABEL: Record<string, string> = {
  queued: "排队中",
  inProgress: "制作中",
  completed: "已完成",
  cancelled: "已取消",
};

const EVENT_LABEL: Record<string, string> = {
  created: "创建订单",
  work_started: "开始制作",
  work_start_undone: "撤销开工",
  stage_advanced: "推进阶段",
  stage_reworked: "返工",
  workflow_changed: "修改流程",
  completed: "完成",
  cancelled: "取消",
  reopened: "重新打开",
};

function formatMoney(cents: number | null): string {
  if (cents === null) return "金额未知";
  return `¥ ${(cents / 100).toFixed(2)}`;
}

function yuanToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new Error("金额只能是最多两位小数的非负数");
  }
  const [whole, fraction = ""] = trimmed.split(".");
  return Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
}

function centsToYuan(cents: number | null): string {
  if (cents === null) return "";
  return (cents / 100).toFixed(2).replace(/\.00$/, "");
}

function useTimeFormatter(timezone: string | null) {
  return useCallback(
    (iso: string | null): string => {
      if (!iso) return "—";
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return iso;
      try {
        return new Intl.DateTimeFormat("zh-CN", {
          timeZone: timezone ?? undefined,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }).format(date);
      } catch {
        return date.toLocaleString("zh-CN");
      }
    },
    [timezone],
  );
}

// ---------------------------------------------------------------- 类型

type ViewMode = "cards" | "board" | "table";

/** 与 Rust `settings::KEY_ORDERS_VIEW_MODE` 必须逐字一致。 */
const KEY_ORDERS_VIEW = "orders_view_mode";
const KEY_LIST_DENSITY = "list_density";
const VIEW_MODES: ViewMode[] = ["cards", "board", "table"];

/** 偏好读取的容错包装：读不到就返回 null，让调用方用自己的默认值。 */
async function readPreference(key: string): Promise<string | null> {
  try {
    const value = await preferenceApi.get(key);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

type Draft = {
  title: string;
  clientId: string;
  commissionType: string;
  source: string;
  amount: string;
  startDate: string;
  deliveryDate: string;
  note: string;
};

function draftFrom(order: OrderView): Draft {
  return {
    title: order.title,
    clientId: order.clientId ?? "",
    commissionType: order.commissionType ?? "",
    source: order.source ?? "",
    amount: centsToYuan(order.amountCents),
    startDate: order.plannedStartDate ?? "",
    deliveryDate: order.plannedDeliveryDate ?? "",
    note: order.note ?? "",
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.title === b.title &&
    a.clientId === b.clientId &&
    a.commissionType === b.commissionType &&
    a.source === b.source &&
    a.amount === b.amount &&
    a.startDate === b.startDate &&
    a.deliveryDate === b.deliveryDate &&
    a.note === b.note
  );
}

type PendingAction = {
  title: string;
  detail: string;
  confirmLabel: string;
  run: () => Promise<void>;
};

type PendingNav =
  | { kind: "order"; orderId: string }
  | { kind: "create" }
  | { kind: "route" };

// ---------------------------------------------------------------- 主页面

export default function OrdersPage() {
  const [orders, setOrders] = useState<OrderView[]>([]);
  const [clients, setClients] = useState<ClientView[]>([]);
  const [templates, setTemplates] = useState<TemplateView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrderView | null>(null);
  const [events, setEvents] = useState<OrderEvent[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [timezone, setTimezone] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [riskFilter, setRiskFilter] = useState<RiskFilter>("all");
  const [workFilter, setWorkFilter] = useState<WorkFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("cards");
  /** 偏好保存失败时的提示：视图仍会切换，但不能假装已经记住。 */
  const [viewPersistError, setViewPersistError] = useState<string | null>(null);
  /** 看板/表格模式下详情以右侧抽屉呈现；卡片模式永远并排显示。 */
  const [drawerOpen, setDrawerOpen] = useState(false);
  const detailVisible = viewMode === "cards" || drawerOpen;
  /** 从客户页跳进来时的稳定 ID 过滤；null = 不按客户过滤 */
  const [clientFilter, setClientFilter] = useState<string | null>(null);
  const [boardCommit, setBoardCommit] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportScope, setExportScope] = useState<"filtered" | "all">("filtered");
  const [params] = useSearchParams();
  const searchKey = params.toString();
  const [density, setDensity] = useState<ListDensity>("comfortable");
  const [queueRev, setQueueRev] = useState(0);
  const [dragging, setDragging] = useState<{ orderId: string; fromIndex: number } | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [manualNav, setManualNav] = useState<PendingNav | null>(null);
  // 键盘光标：与"当前打开的订单"分开，方向键只移动光标，Enter 才打开。
  const [cursorId, setCursorId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  // 键盘光标所在行：用于把它滚进可视区（列表容器 .order-rows 才是滚动容器）。
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const lastScrolledCursor = useRef<string | null>(null);
  const [guardBusy, setGuardBusy] = useState(false);
  const [guardError, setGuardError] = useState<string | null>(null);

  const dirty = useMemo(() => {
    if (!detail || !draft) return false;
    return !sameDraft(draft, draftFrom(detail));
  }, [detail, draft]);

  const blocker = useBlocker(dirty);

  // 关窗保护复用页面自己的 dirty 与保存逻辑，不另建一套状态。
  useUnsavedGuard({
    id: "orders-detail",
    label: "订单资料",
    dirty,
    save: () => saveDraft(),
    discard: () => {
      if (detail) setDraft(draftFrom(detail));
      setDraftError(null);
    },
  });
  const formatTime = useTimeFormatter(timezone);

  // Esc 关闭看板/表格的详情抽屉。卡片视图是并排布局，不需要这个手势。
  useEffect(() => {
    if (!drawerOpen || viewMode === "cards") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!dirty) {
        setDrawerOpen(false);
        return;
      }
      setNotice("还有未保存的修改：请先「保存」或「撤销」，再关闭详情。");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen, viewMode, dirty]);

  // 光标移动才滚动一次；数据刷新导致的重新渲染不会滚动，避免"滚到错误订单"。
  // block: "nearest" 表示"已可见就不动"，所以不会每按一下就居中。
  useEffect(() => {
    if (!cursorId) {
      lastScrolledCursor.current = null;
      return;
    }
    if (lastScrolledCursor.current === cursorId) return;
    lastScrolledCursor.current = cursorId;
    rowRefs.current.get(cursorId)?.scrollIntoView({ block: "nearest" });
  }, [cursorId]);


  function moveCursor(delta: 1 | -1) {
    if (visible.length === 0) return;
    const current = cursorId ?? selectedId;
    const index = visible.findIndex((o) => o.id === current);
    const nextIndex =
      index < 0 ? 0 : Math.min(visible.length - 1, Math.max(0, index + delta));
    const next = visible[nextIndex];
    if (next) setCursorId(next.id);
  }

  // 键盘只移动光标/打开详情，**不碰队列**：不做任何 queue 写操作。
  usePageShortcuts({
    onNew: () => {
      if (!creating) attemptCreate();
    },
    onSave: () => {
      if (!creating && dirty && !busy) void saveDraft();
    },
    onFocusSearch: () => searchRef.current?.focus(),
    onMoveSelection: moveCursor,
    onOpenSelection: () => {
      if (cursorId) attemptSelect(cursorId);
    },
  });

  const loadList = useCallback(async () => {
    const [list, clientList] = await Promise.all([api.listOrders(), api.listClients()]);
    setOrders(list);
    setClients(clientList);
    return list;
  }, []);

  const selectOrder = useCallback(
    async (orderId: string) => {
      setError(null);
      setNotice(null);
      setDraftError(null);
      try {
        const [order, history] = await Promise.all([
          api.getOrder(orderId),
          api.listOrderEvents(orderId),
        ]);
        setSelectedId(orderId);
        setDetail(order);
        setEvents(history);
        setDraft(draftFrom(order));
        setCreating(false);
      } catch (e) {
        setError(describeError(e));
      }
    },
    [],
  );

  const refresh = useCallback(
    async (orderId: string) => {
      const [order, history, list] = await Promise.all([
        api.getOrder(orderId),
        api.listOrderEvents(orderId),
        api.listOrders(),
      ]);
      setDetail(order);
      setEvents(history);
      setOrders(list);
      setDraft(draftFrom(order));
      return order;
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [list, clientList, templateList, status, queue, viewValue, densityValue] =
          await Promise.all([
          api.listOrders(),
          api.listClients(),
          templateApi.list(),
          api.status(),
          queueApi.list(),
          // 偏好读取失败**不能**拖垮整个列表：视图选择只是"上次用哪种看法"，
          // 读不到就退回默认卡片视图，并把原因留给需要它的人（见 changeView 的提示）。
          readPreference(KEY_ORDERS_VIEW),
          readPreference(KEY_LIST_DENSITY),
        ]);
        if (!alive) return;
        setOrders(list);
        setClients(clientList);
        setTemplates(templateList);
        setTimezone(status.workingTimezone);
        setQueueRev(queue.revision);
        if (densityValue === "compact" || densityValue === "comfortable") {
          setDensity(densityValue);
        }
        // 未设置或值非法都退回卡片：卡片是产品主工作流。
        setViewMode(
          VIEW_MODES.includes(viewValue as ViewMode) ? (viewValue as ViewMode) : "cards",
        );
        // 从客户页按客户 ID 跳进来：用稳定的 clientId 过滤，不靠名称猜。
        const clientParam = params.get("client");
        if (clientParam) {
          setClientFilter(clientParam);
        }
        // 从工作台/统计页带着 orderId 跳进来时，必须选中那一张，
        // 不能因为"默认选第一张"把它覆盖掉（S3 的根因就是这个覆盖）。
        const requested = params.get("orderId");
        const targetId = requested ?? list[0]?.id;
        if (targetId) {
          await selectOrder(targetId);
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
  }, [selectOrder]);

  // 详情页排期概览用的"今天"：按工作时区取日历日，
  // 避免把 UTC 的今天当成本地今天（差一天时"今天到期"会标错）。
  const scheduleToday = useMemo(() => {
    const now = localDayIndex(new Date().toISOString(), timezone);
    return now ?? 0;
  }, [timezone]);

  /**
   * 视图选择会写进偏好；写失败不影响当前这次切换，但要让用户知道"下次不会记住"，
   * 而不是静默当成功——这正是上一轮 `DENIED` 被藏住的地方。
   */
  const changeView = useCallback(async (next: ViewMode) => {
    setViewMode(next);
    try {
      await preferenceApi.set(KEY_ORDERS_VIEW, next);
      setViewPersistError(null);
    } catch (e) {
      setViewPersistError(
        `当前视图已切换，但没能记住偏好（${describeError(e)}）。下次打开会回到上次成功保存的视图。`,
      );
    }
  }, []);

  /**
   * 看板拖拽的落地：只调用已有的合法业务动作。
   * 这里**不写** current_stage_id，也不碰开工/完成/队列。
   */
  const applyStageMove = useCallback(
    async (order: OrderView, plan: StageMovePlan) => {
      if (plan.kind !== "advance" && plan.kind !== "rework") return;
      setBusy(true);
      setError(null);
      setBoardCommit(`${order.code} · ${order.currentStageTitle} → ${plan.targetStageTitle}`);
      try {
        const latest = await api.getOrder(order.id);
        if (plan.kind === "advance") {
          await api.advanceStage({
            orderId: latest.id,
            expectedRevision: latest.revision,
            requestId: newRequestId("board-advance"),
          });
        } else {
          await api.reworkStage({
            orderId: latest.id,
            expectedRevision: latest.revision,
            targetStageId: plan.targetStageId,
            requestId: newRequestId("board-rework"),
          });
        }
        await loadList();
        if (selectedId === order.id) {
          await selectOrder(order.id);
        }
        setNotice(`${order.code} 已${plan.kind === "advance" ? "推进" : "返工"}到「${plan.targetStageTitle}」`);
      } catch (e) {
        // 冲突时刷新数据并放弃本次拖动结果，不做部分写入。
        if (isConflict(e)) {
          await loadList();
          await selectOrder(order.id).catch(() => {});
          setError("订单已被修改，看板已刷新；请确认最新阶段后重新拖动。");
        } else {
          setError(describeError(e));
        }
      } finally {
        setBoardCommit(null);
        setBusy(false);
      }
    },
    [loadList, selectOrder, selectedId],
  );

  const visible = useMemo(() => {
    const filtered = filterOrders(orders, {
      query,
      status: statusFilter,
      risk: riskFilter,
      work: workFilter,
      source: sourceFilter,
    });
    return clientFilter === null
      ? filtered
      : filtered.filter((order) => order.clientId === clientFilter);
  }, [orders, query, statusFilter, riskFilter, workFilter, sourceFilter, clientFilter]);

  /** 来源是自由文本：筛选项从现有订单里取，去重后排序，不预置枚举。 */
  const sourceOptions = useMemo(() => {
    const names = new Set<string>();
    for (const order of orders) {
      if (order.source) names.add(order.source);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [orders]);

  const clientFilterName = useMemo(
    () => clients.find((client) => client.id === clientFilter)?.displayName ?? null,
    [clients, clientFilter],
  );
  const activeQueue = useMemo(
    () =>
      orders
        .filter((order) => order.status === "active")
        .sort((a, b) => a.queuePosition - b.queuePosition),
    [orders],
  );

  // 搜索/筛选把光标那一行过滤掉后，光标不能指向已经不存在的订单。
  useEffect(() => {
    if (cursorId && !visible.some((o) => o.id === cursorId)) {
      setCursorId(null);
    }
  }, [cursorId, visible]);

  async function applyQueueMove(orderId: string, toIndex: number) {
    setBusy(true);
    setError(null);
    try {
      const snap = await queueApi.move({
        orderId,
        expectedQueueRevision: queueRev,
        toIndex,
      });
      setQueueRev(snap.revision);
      setOrders(await api.listOrders());
    } catch (e) {
      setError(describeError(e));
      if (isConflict(e)) {
        const snap = await queueApi.list().catch(() => null);
        if (snap) setQueueRev(snap.revision);
        setOrders(await api.listOrders().catch(() => orders));
      }
    } finally {
      setBusy(false);
    }
  }

  function shiftQueue(orderId: string, delta: number) {
    const index = activeQueue.findIndex((order) => order.id === orderId);
    if (index < 0) return;
    const target = index + delta;
    if (target < 0 || target >= activeQueue.length) return;
    void applyQueueMove(orderId, target);
  }

  async function toggleDensity() {
    const next: ListDensity = density === "compact" ? "comfortable" : "compact";
    setDensity(next);
    try {
      await preferenceApi.set("list_density", next);
    } catch (e) {
      setError(describeError(e));
    }
  }

  // 从工作台/统计页跳过来时带着筛选条件；URL 变化就同步到本地筛选状态。
  useEffect(() => {
    const nextStatus = (params.get("status") as StatusFilter | null) ?? "all";
    const nextRisk = (params.get("risk") as RiskFilter | null) ?? "all";
    const nextWork = (params.get("work") as WorkFilter | null) ?? "all";
    setStatusFilter(nextStatus);
    setRiskFilter(nextRisk);
    setWorkFilter(nextWork);
    const target = params.get("orderId");
    if (target) void selectOrder(target);
    // params 每次渲染都是新对象，用字符串做依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchKey]);

  // 指针拖拽：在 window 上收尾，指针移出列表也能结束拖动。
  useEffect(() => {
    if (!dragging) return;
    const finish = () => {
      const target = hoverIndex;
      const from = dragging.fromIndex;
      const orderId = dragging.orderId;
      setDragging(null);
      setHoverIndex(null);
      if (target === null) return;
      const next = dropIndex(from, target, activeQueue.length);
      if (next === null) return;
      void applyQueueMove(orderId, next);
    };
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  });

  // ---------------------------------------------------------------- 动作

  async function saveDraft(): Promise<string | null> {
    if (!detail || !draft) return "当前没有可保存的订单";
    setBusy(true);
    setDraftError(null);
    try {
      const amountCents = yuanToCents(draft.amount);
      const input: UpdateDetailsInput = {
        orderId: detail.id,
        expectedRevision: detail.revision,
        title: draft.title,
        clientId: draft.clientId === "" ? null : draft.clientId,
        commissionType: draft.commissionType.trim() === "" ? null : draft.commissionType,
        source: draft.source.trim() === "" ? null : draft.source.trim(),
        amountCents,
        plannedStartDate: draft.startDate === "" ? null : draft.startDate,
        plannedDeliveryDate: draft.deliveryDate === "" ? null : draft.deliveryDate,
        note: draft.note.trim() === "" ? null : draft.note,
      };
      const updated = await api.updateOrderDetails(input);
      await refresh(updated.id);
      setNotice("资料已保存");
      return null;
    } catch (e) {
      if (isConflict(e)) {
        setDraftError(`${describeError(e)} 已重新载入最新数据，你的修改仍保留在表单中。`);
        try {
          const latest = await api.getOrder(detail.id);
          setDetail(latest);
          const latestEvents = await api.listOrderEvents(detail.id);
          setEvents(latestEvents);
        } catch {
          /* 保留原有错误提示 */
        }
      } else {
        setDraftError(describeError(e));
      }
      return `${describeError(e)} 草稿仍保留在表单中。`;
    } finally {
      setBusy(false);
    }
  }

  async function runLifecycle(
    label: string,
    call: (order: OrderView) => Promise<OrderView>,
  ): Promise<void> {
    if (!detail) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await call(detail);
      await refresh(updated.id);
      setNotice(label);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  function openCreate() {
    setCreating(true);
    setSelectedId(null);
    setDetail(null);
    setDraft(null);
    setEvents([]);
    setError(null);
    setNotice(null);
  }

  function attemptSelect(orderId: string) {
    if (orderId === selectedId && !creating) return;
    if (dirty) {
      setGuardError(null);
      setManualNav({ kind: "order", orderId });
      return;
    }
    // 用户主动点开：看板/表格里以抽屉呈现详情（卡片视图本来就并排）。
    setDrawerOpen(true);
    void selectOrder(orderId);
  }

  function attemptCreate() {
    if (dirty) {
      setGuardError(null);
      setManualNav({ kind: "create" });
      return;
    }
    openCreate();
  }

  // 路由级离页与手动切换共用同一个对话框：
  // 路由被 blocker 拦下时对话框"就是打开状态"，不额外维护一份状态，
  // 避免 reset/proceed 与本地状态更新的时序竞争导致对话框重新弹出。
  const routeBlocked = blocker.state === "blocked";
  const dialogOpen = routeBlocked || manualNav !== null;
  const pendingNav: PendingNav | null = manualNav ?? (routeBlocked ? { kind: "route" } : null);

  function leaveTo(nav: PendingNav) {
    if (nav.kind === "route") {
      blocker.proceed?.();
      return;
    }
    if (nav.kind === "create") {
      openCreate();
      return;
    }
    void selectOrder(nav.orderId);
  }

  function handleStay() {
    setGuardError(null);
    setManualNav(null);
    if (routeBlocked) blocker.reset?.();
  }

  async function handleDiscard() {
    if (guardBusy) return;
    const nav = pendingNav;
    if (!nav) return;
    setGuardBusy(true);
    try {
      setGuardError(null);
      if (nav.kind === "route") {
        blocker.proceed?.();
      } else {
        setDraft(null);
        setManualNav(null);
        leaveTo(nav);
      }
    } finally {
      setGuardBusy(false);
    }
  }

  async function handleSaveAndLeave() {
    if (guardBusy) return;
    const nav = pendingNav;
    if (!nav) return;
    setGuardBusy(true);
    setGuardError(null);
    try {
      const failure = await saveDraft();
      if (failure) {
        // 保存失败：对话框保持打开，草稿不动。
        setGuardError(failure);
        return;
      }
      if (nav.kind === "route") {
        blocker.proceed?.();
      } else {
        setManualNav(null);
        leaveTo(nav);
      }
    } finally {
      setGuardBusy(false);
    }
  }

  // ---------------------------------------------------------------- 渲染

  if (loading) {
    return <section className="panel">正在读取订单…</section>;
  }

  return (
    <div className={`orders-layout orders-page view-${viewMode}`}>
      {/* 来源是自由文本，只用已有来源做输入建议，避免同义重复 */}
      <datalist id="order-source-options">
        {sourceOptions.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      {viewMode === "cards" ? (
      <aside className="orders-list panel">
        <header className="panel-head compact">
          <div>
            <h2>订单</h2>
            <p className="muted">
              {visible.length}/{orders.length} 张 · 活动在前
            </p>
          </div>
          <div className="attach-actions">
            <ViewSwitch value={viewMode} onChange={(next) => void changeView(next)} />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setExportOpen(true)}
              disabled={orders.length === 0}
            >
              导出
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={attemptCreate}>
              新建
            </button>
          </div>
        </header>

        <div className="list-tools">
          <input
            ref={searchRef}
            className="list-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题 / 编号 / 客户"
            aria-label="搜索订单"
          />
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => void toggleDensity()}
            aria-pressed={density === "compact"}
            title={density === "compact" ? "切换到舒适模式" : "切换到紧凑模式"}
          >
            {density === "compact" ? "紧凑" : "舒适"}
          </button>
        </div>

        <div className="filter-row" role="group" aria-label="按来源筛选">
          <select
            className="select-inline"
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            aria-label="按来源筛选"
          >
            <option value="all">所有来源</option>
          <option value="">未设置</option>
            <option value="">未设置</option>
            {sourceOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        {viewPersistError && (
          <p className="notice notice-warn" role="status">
            {viewPersistError}
          </p>
        )}
        {clientFilter && (
          <p className="filter-note">
            只显示客户「{clientFilterName ?? "（未知）"}」的订单
            <button type="button" className="link-btn" onClick={() => setClientFilter(null)}>
              清除
            </button>
          </p>
        )}

        <div className="filter-row" role="group" aria-label="按状态筛选">
          {(
            [
              ["all", "全部"],
              ["active", "活动"],
              ["complete", "已完成"],
              ["cancelled", "已取消"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`filter-chip${statusFilter === value ? " filter-chip-active" : ""}`}
              aria-pressed={statusFilter === value}
              onClick={() => setStatusFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>

        {visible.length === 0 ? (
          <div className="empty">
            <p>{orders.length === 0 ? "还没有订单。" : "没有符合筛选条件的订单。"}</p>
            {orders.length === 0 && <p className="muted">点击「新建」创建第一张委托。</p>}
          </div>
        ) : (
          <ul className={`order-rows ${densityClass(density)}`}>
            {visible.map((order) => {
              const queueIndex = activeQueue.findIndex((item) => item.id === order.id);
              const canReorder = order.status === "active" && statusFilter !== "complete" && statusFilter !== "cancelled";
              return (
                <li
                  key={order.id}
                  onPointerEnter={() => {
                    if (!dragging || !canReorder) return;
                    setHoverIndex(queueIndex);
                  }}
                  className={[
                    dragging?.orderId === order.id ? "row-dragging" : "",
                    dragging && hoverIndex === queueIndex && dragging.orderId !== order.id
                      ? "row-drop-target"
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ") || undefined}
                >
                  {canReorder && (
                    <button
                      type="button"
                      className="drag-handle"
                      aria-label={`拖动 ${order.code} 调整队列位置`}
                      title="按住拖到目标位置"
                      disabled={busy}
                      onPointerDown={(event) => {
                        if (busy) return;
                        event.preventDefault();
                        setDragging({ orderId: order.id, fromIndex: queueIndex });
                        setHoverIndex(queueIndex);
                      }}
                    >
                      ⠿
                    </button>
                  )}
                  <button
                    type="button"
                    ref={(el) => {
                      if (el) rowRefs.current.set(order.id, el);
                      else rowRefs.current.delete(order.id);
                    }}
                    className={`order-row${order.id === selectedId ? " order-row-active" : ""}${
                      order.id === cursorId ? " order-row-cursor" : ""
                    }`}
                    onClick={() => attemptSelect(order.id)}
                  >
                    <span className="order-row-top">
                      <code className="order-code">{order.code}</code>
                      <span className={`chip chip-${order.status}`}>{STATUS_LABEL[order.status]}</span>
                    </span>
                    <TruncatedTitle className="order-row-title" text={order.title}>
                      {order.title}
                      {riskBadge(order) && (
                        <span className={`risk-chip risk-${order.deadlineState}`}>
                          {riskBadge(order)}
                        </span>
                      )}
                    </TruncatedTitle>
                    <span className="order-row-meta">
                      <span className={`dot dot-${order.workState}`} />
                      {WORK_LABEL[order.workState]}
                      {order.currentStageTitle ? ` · ${order.currentStageTitle}` : ""}
                      {order.clientName ? ` · ${order.clientName}` : ""}
                    </span>
                  </button>
                  {canReorder && activeQueue.length > 1 && (
                    <span className="queue-tools">
                      <button
                        type="button"
                        className="link-btn"
                        disabled={busy || queueIndex <= 0}
                        aria-label={`把 ${order.code} 上移`}
                        onClick={() => shiftQueue(order.id, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="link-btn"
                        disabled={busy || queueIndex >= activeQueue.length - 1}
                        aria-label={`把 ${order.code} 下移`}
                        onClick={() => shiftQueue(order.id, 1)}
                      >
                        ↓
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {dragging && hoverIndex !== null && (
          <p className="drag-hint">
            松开后放到第 {hoverIndex + 1} 位
            {hoverIndex === dragging.fromIndex ? "（当前位置，不会改变顺序）" : ""}
          </p>
        )}
        {statusFilter === "complete" || statusFilter === "cancelled" ? (
          <p className="muted list-hint">
            当前筛选下不显示活动队列，拖拽与 ↑ ↓ 已禁用；切到「全部」或「活动」后可调整顺序。
          </p>
        ) : activeQueue.length > 1 ? (
          <p className="muted list-hint">
            按住行首的 ⠿ 拖到目标位置，或用 ↑ ↓ 调整顺序；排序不影响订单编号。
          </p>
        ) : null}
      </aside>
      ) : (
      <section className="orders-wide panel">
        <header className="panel-head compact">
          <div>
            <h2>{viewMode === "board" ? "看板" : "表格"}</h2>
            <p className="muted">
              {visible.length}/{orders.length} 张 · 与卡片视图同一份数据与筛选
            </p>
          </div>
          <div className="attach-actions">
            <ViewSwitch value={viewMode} onChange={(next) => void changeView(next)} />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setExportOpen(true)}
              disabled={orders.length === 0}
            >
              导出
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={attemptCreate}>
              新建
            </button>
          </div>
        </header>

        <div className="list-tools">
          <input
            className="list-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题 / 编号 / 客户 / 来源"
            aria-label="搜索订单"
          />
          <select
            className="select-inline"
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            aria-label="按来源筛选"
          >
            <option value="all">所有来源</option>
          <option value="">未设置</option>
            <option value="">未设置</option>
            {sourceOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <select
            className="select-inline"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            aria-label="按状态筛选"
          >
            <option value="all">全部状态</option>
            <option value="active">活动</option>
            <option value="complete">已完成</option>
            <option value="cancelled">已取消</option>
          </select>
        </div>

        {viewPersistError && (
          <p className="notice notice-warn" role="status">
            {viewPersistError}
          </p>
        )}
        {clientFilter && (
          <p className="filter-note">
            只显示客户「{clientFilterName ?? "（未知）"}」的订单
            <button type="button" className="link-btn" onClick={() => setClientFilter(null)}>
              清除
            </button>
          </p>
        )}
        {boardCommit && <p className="muted list-hint">正在应用：{boardCommit}</p>}
        {viewPersistError && (
          <p className="notice notice-warn" role="status">
            {viewPersistError}
          </p>
        )}

        {viewMode === "board" ? (
          <OrderBoard
            orders={visible}
            busy={busy}
            onOpen={(orderId) => void attemptSelect(orderId)}
            onApply={applyStageMove}
            formatMoney={formatMoney}
            formatDate={(value) => (value ? value : "未排期")}
            onError={setError}
          />
        ) : (
          <OrderTable
            orders={visible}
            selectedId={selectedId}
            onOpen={(orderId) => void attemptSelect(orderId)}
            formatMoney={formatMoney}
            formatDate={(value) => (value ? value : "未排期")}
          />
        )}
      </section>
      )}

      <section
        className={`orders-detail${viewMode === "cards" ? "" : " orders-detail-drawer"}${
          detailVisible ? "" : " is-hidden"
        }`}
        aria-label={viewMode === "cards" ? undefined : "订单详情面板"}
        aria-hidden={!detailVisible}
      >
        {viewMode !== "cards" && (
          <button
            type="button"
            className="drawer-close"
            onClick={() => {
              // 有未保存修改时不静默关闭：草稿会留在内存里，用户以为已经"关掉"了。
              if (dirty) {
                setNotice("还有未保存的修改：请先「保存」或「撤销」，再关闭详情。");
                return;
              }
              setDrawerOpen(false);
            }}
          >
            关闭详情
          </button>
        )}
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
          <CreateOrderPanel
            clients={clients}
            templates={templates}
            busy={busy}
            onCancel={() => setCreating(false)}
            onCreated={async (order) => {
              setCreating(false);
              await loadList();
              await selectOrder(order.id);
              setNotice(`已创建 ${order.code}`);
            }}
            onError={setError}
            setBusy={setBusy}
          />
        ) : !detail ? (
          <section className="panel empty">
            <p>从左侧选择一张订单，或新建一张委托。</p>
          </section>
        ) : (
          <>
            <section className="panel">
              <header className="panel-head">
                <div>
                  <div className="detail-code">
                    <code>{detail.code}</code>
                    <span className={`chip chip-${detail.status}`}>
                      {STATUS_LABEL[detail.status]}
                    </span>
                    <span className={`chip chip-state-${detail.workState}`}>
                      {WORK_LABEL[detail.workState]}
                    </span>
                  </div>
                  <h1 className="detail-title">{detail.title}</h1>
                  <p className="muted">
                    当前阶段 {detail.currentStageTitle ?? "—"} · 第{" "}
                    {(detail.currentStageIndex ?? 0) + 1}/{detail.stageCount} 步 · 队列位置{" "}
                    {detail.queuePosition + 1}
                    {detail.clientName ? ` · 客户 ${detail.clientName}` : ""}
                  </p>
                </div>
              </header>

              <div className="facts">
                <span>{formatMoney(detail.amountCents)}</span>
                <span>版本 {detail.revision}</span>
              </div>

              <ActionBar
                order={detail}
                busy={busy}
                onRequest={setPendingAction}
                onRun={runLifecycle}
                onDirtyGuard={() => dirty}
              />

              {pendingAction && (
                <div className="confirm-bar">
                  <div>
                    <strong>{pendingAction.title}</strong>
                    <p className="muted">{pendingAction.detail}</p>
                  </div>
                  <div className="confirm-actions">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setPendingAction(null)}
                      disabled={busy}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={busy}
                      onClick={async () => {
                        const action = pendingAction;
                        setPendingAction(null);
                        await action.run();
                      }}
                    >
                      {pendingAction.confirmLabel}
                    </button>
                  </div>
                </div>
              )}
            </section>

            <ScheduleOverview order={detail} today={scheduleToday} timeZone={timezone} />

            <section className="panel">
              <header className="panel-head compact">
                <h2>资料</h2>
                <span className="muted">{dirty ? "有未保存的修改" : "已保存"}</span>
              </header>
              <DetailsForm
                draft={draft}
                clients={clients}
                onChange={(next) => {
                  setDraft(next);
                  setDraftError(null);
                }}
                disabled={busy}
              />
              {draftError && <p className="notice notice-error">{draftError}</p>}
              <div className="actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void saveDraft()}
                  disabled={busy || !dirty}
                >
                  {busy ? "保存中…" : "保存资料"}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => detail && setDraft(draftFrom(detail))}
                  disabled={busy || !dirty}
                >
                  还原修改
                </button>
              </div>
            </section>

            <AttachmentPanel
              orderId={detail.id}
              onError={setError}
              onNotice={setNotice}
            />

            <StagePanel
              order={detail}
              busy={busy}
              onRun={runLifecycle}
              onError={setError}
            />

            <EventTimeline events={events} formatTime={formatTime} />
          </>
        )}

      </section>

      <ConfirmDialog
        open={exportOpen}
        title="导出订单明细 CSV"
        confirmLabel="选择保存位置"
        busy={busy}
        error={null}
        onCancel={() => setExportOpen(false)}
        onConfirm={async () => {
          const scope = exportScope;
          const ids = visible.map((order) => order.id);
          setExportOpen(false);
          try {
            const path = await save({
              title: "导出订单明细 CSV",
              defaultPath: "artflow-订单明细.csv",
              filters: [{ name: "CSV", extensions: ["csv"] }],
            });
            // 用户取消：不建文件、不报成功
            if (!path) return;
            setBusy(true);
            const result = await statsApi.exportOrders({
              path,
              scope,
              orderIds: scope === "filtered" ? ids : [],
            });
            setNotice(`已导出 ${result.rows} 条订单到 ${result.path}`);
          } catch (e) {
            setError(describeError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>只导出业务字段，不包含客户联系方式、私人备注或任何文件路径。</p>
        <label className="radio-row">
          <input
            type="radio"
            name="export-scope"
            checked={exportScope === "filtered"}
            onChange={() => setExportScope("filtered")}
          />
          <span>当前筛选结果（{visible.length} 条）</span>
        </label>
        <label className="radio-row">
          <input
            type="radio"
            name="export-scope"
            checked={exportScope === "all"}
            onChange={() => setExportScope("all")}
          />
          <span>全部订单（{orders.length} 条）</span>
        </label>
      </ConfirmDialog>

      <UnsavedChangesDialog
        open={dialogOpen}
        detail={
          pendingNav?.kind === "create"
            ? "新建订单会离开当前订单，尚未保存的资料修改将丢失。"
            : pendingNav?.kind === "route"
              ? "离开订单页面会丢失尚未保存的资料修改。"
              : "切换订单会丢失当前尚未保存的资料修改。"
        }
        error={guardError}
        busy={guardBusy || busy}
        onSaveAndLeave={handleSaveAndLeave}
        onDiscard={handleDiscard}
        onStay={handleStay}
      />
    </div>
  );
}

// ---------------------------------------------------------------- 子组件

function ViewSwitch({
  value,
  onChange,
}: {
  value: ViewMode;
  onChange: (next: ViewMode) => void;
}) {
  const items: [ViewMode, string][] = [
    ["cards", "卡片"],
    ["board", "看板"],
    ["table", "表格"],
  ];
  return (
    <div className="view-switch" role="group" aria-label="切换订单视图">
      {items.map(([key, label]) => (
        <button
          key={key}
          type="button"
          className={`filter-chip${value === key ? " filter-chip-active" : ""}`}
          aria-pressed={value === key}
          onClick={() => onChange(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function ActionBar({
  order,
  busy,
  onRequest,
  onRun,
  onDirtyGuard,
}: {
  order: OrderView;
  busy: boolean;
  onRequest: (action: PendingAction) => void;
  onRun: (label: string, call: (order: OrderView) => Promise<OrderView>) => Promise<void>;
  onDirtyGuard: () => boolean;
}) {
  const caps = order.capabilities;

  const lifecycleCall = (
    fn: (input: {
      orderId: string;
      expectedRevision: number;
      requestId?: string | null;
    }) => Promise<OrderView>,
    order: OrderView,
    prefix: string,
  ) =>
    fn({
      orderId: order.id,
      expectedRevision: order.revision,
      requestId: newRequestId(prefix),
    });

  return (
    <div className="action-bar">
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy || !caps.canStartWork}
        title={caps.canStartWork ? "" : "只有活动且未开工的订单可以开始制作"}
        onClick={() => void onRun("已开始制作", (o) => lifecycleCall(api.startWork, o, "start"))}
      >
        开始制作
      </button>

      <button
        type="button"
        className="btn"
        disabled={busy || !caps.canUndoStartWork}
        title={caps.undoBlockedReason ?? ""}
        onClick={() =>
          void onRun("已撤销开工", (o) => lifecycleCall(api.undoStartWork, o, "undo-start"))
        }
      >
        撤销开工
      </button>

      <button
        type="button"
        className="btn"
        disabled={busy || !caps.canAdvance}
        title={caps.canAdvance ? "" : "尚未开工或已在最后一个阶段"}
        onClick={() => void onRun("已推进到下一阶段", (o) => lifecycleCall(api.advanceStage, o, "advance"))}
      >
        推进阶段
      </button>

      <button
        type="button"
        className="btn"
        disabled={busy || !caps.canRework}
        title={caps.canRework ? "" : "尚未开工或已在第一阶段"}
        onClick={() =>
          onRequest({
            title: "返工",
            detail: `把「${order.currentStageTitle ?? ""}」退回上一阶段？历史会记录这次返工。`,
            confirmLabel: "确认返工",
            run: () =>
              onRun("已返工到上一阶段", (o) =>
                api.reworkStage({
                  orderId: o.id,
                  expectedRevision: o.revision,
                  targetStageId: null,
                  requestId: newRequestId("rework"),
                }),
              ),
          })
        }
      >
        返工一步
      </button>

      <button
        type="button"
        className="btn"
        disabled={busy || !caps.canComplete}
        title={caps.canComplete ? "" : "必须已开工且位于最后一个阶段"}
        onClick={() =>
          onRequest({
            title: "完成订单",
            detail: "完成后会锁定制作流程与开工状态，只能在确认后重新打开。",
            confirmLabel: "确认完成",
            run: () => onRun("订单已完成", (o) => lifecycleCall(api.completeOrder, o, "complete")),
          })
        }
      >
        完成
      </button>

      <button
        type="button"
        className="btn"
        disabled={busy || !caps.canCancel}
        onClick={() =>
          onRequest({
            title: "取消订单",
            detail: "取消后订单退出活动队列，制作流程被锁定；普通资料仍可编辑。",
            confirmLabel: "确认取消",
            run: () => onRun("订单已取消", (o) => lifecycleCall(api.cancelOrder, o, "cancel")),
          })
        }
      >
        取消
      </button>

      <button
        type="button"
        className="btn"
        disabled={busy || !caps.canReopen}
        title={caps.canReopen ? "" : "只有已完成或已取消的订单可以重新打开"}
        onClick={() =>
          onRequest({
            title: "重新打开订单",
            detail: "订单将回到活动状态并加入队列末尾，保留当前阶段与开工记录。",
            confirmLabel: "确认重新打开",
            run: () => onRun("订单已重新打开", (o) => lifecycleCall(api.reopenOrder, o, "reopen")),
          })
        }
      >
        重新打开
      </button>

      {onDirtyGuard() && (
        <span className="muted action-hint">资料有未保存修改，生命周期操作不受影响</span>
      )}
    </div>
  );
}

function DetailsForm({
  draft,
  clients,
  onChange,
  disabled,
}: {
  draft: Draft | null;
  clients: ClientView[];
  onChange: (next: Draft) => void;
  disabled: boolean;
}) {
  if (!draft) return null;
  const patch = (part: Partial<Draft>) => onChange({ ...draft, ...part });

  return (
    <div className="form-grid">
      <label className="field field-wide">
        <span>委托标题</span>
        <input
          value={draft.title}
          onChange={(e) => patch({ title: e.target.value })}
          disabled={disabled}
          maxLength={120}
        />
      </label>

      <label className="field">
        <span>客户</span>
        <select
          value={draft.clientId}
          onChange={(e) => patch({ clientId: e.target.value })}
          disabled={disabled}
        >
          <option value="">不关联客户</option>
          {clients.map((client) => (
            <option key={client.id} value={client.id}>
              {client.displayName}（{client.orderCount} 单）
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>委托类型</span>
        <input
          value={draft.commissionType}
          onChange={(e) => patch({ commissionType: e.target.value })}
          disabled={disabled}
          maxLength={80}
          placeholder="例如 半身立绘"
        />
      </label>

      <label className="field">
        <span>来源</span>
        <input
          value={draft.source}
          onChange={(e) => patch({ source: e.target.value })}
          disabled={disabled}
          maxLength={40}
          list="order-source-options"
          placeholder="例如 米画师 / 画加 / 私信"
        />
      </label>

      <label className="field">
        <span>委托金额（元，留空表示未知）</span>
        <input
          value={draft.amount}
          onChange={(e) => patch({ amount: e.target.value })}
          disabled={disabled}
          placeholder="例如 1200.00"
          inputMode="decimal"
        />
      </label>

      <label className="field">
        <span>预计开始日期</span>
        <input
          type="date"
          value={draft.startDate}
          onChange={(e) => patch({ startDate: e.target.value })}
          disabled={disabled}
        />
      </label>

      <label className="field">
        <span>预计交付日期</span>
        <input
          type="date"
          value={draft.deliveryDate}
          onChange={(e) => patch({ deliveryDate: e.target.value })}
          disabled={disabled}
        />
      </label>

      <label className="field field-wide">
        <span>委托说明</span>
        <textarea
          value={draft.note}
          onChange={(e) => patch({ note: e.target.value })}
          disabled={disabled}
          rows={3}
          maxLength={4000}
        />
      </label>
    </div>
  );
}

function StagePanel({
  order,
  busy,
  onRun,
  onError,
}: {
  order: OrderView;
  busy: boolean;
  onRun: (label: string, call: (order: OrderView) => Promise<OrderView>) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [newTitle, setNewTitle] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [stageToDelete, setStageToDelete] = useState<{
    id: string;
    title: string;
    replacementId: string;
    isCurrent: boolean;
  } | null>(null);

  const locked = !order.capabilities.canEditWorkflow;

  async function guarded(label: string, run: () => Promise<OrderView>) {
    try {
      const updated = await run();
      await onRun(label, async () => updated);
    } catch (e) {
      onError(describeError(e));
    }
  }

  return (
    <section className="panel">
      <header className="panel-head compact">
        <h2>制作流程</h2>
        <span className="muted">
          {order.stageCount} 个阶段{locked ? " · 终态订单已锁定" : ""}
        </span>
      </header>

      <ol className="stage-list">
        {order.stages.map((stage, index) => (
          <li key={stage.id} className={stage.isCurrent ? "stage stage-current" : "stage"}>
            <span className="stage-index">{index + 1}</span>
            {renaming === stage.id ? (
              <span className="stage-edit">
                <input
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  disabled={busy}
                  maxLength={80}
                />
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy || renameValue.trim() === ""}
                  onClick={() =>
                    void guarded("阶段已重命名", () =>
                      api.workflowRenameStage({
                        orderId: order.id,
                        expectedRevision: order.revision,
                        stageId: stage.id,
                        title: renameValue.trim(),
                        requestId: newRequestId("rename"),
                      }),
                    ).then(() => setRenaming(null))
                  }
                >
                  保存
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setRenaming(null)}>
                  取消
                </button>
              </span>
            ) : (
              <>
                <span className="stage-title">{stage.title}</span>
                {stage.isCurrent && <span className="chip chip-current">当前</span>}
                {!locked && (
                  <span className="stage-tools">
                    <button
                      type="button"
                      className="link-btn"
                      disabled={busy}
                      onClick={() => {
                        setRenaming(stage.id);
                        setRenameValue(stage.title);
                      }}
                    >
                      改名
                    </button>
                    <button
                      type="button"
                      className="link-btn"
                      disabled={busy || index === 0}
                      onClick={() =>
                        void guarded("阶段顺序已调整", () => {
                          const ids = order.stages.map((s) => s.id);
                          const [moved] = ids.splice(index, 1);
                          if (!moved) return Promise.reject(new Error("阶段不存在"));
                          ids.splice(index - 1, 0, moved);
                          return api.workflowReorderStages({
                            orderId: order.id,
                            expectedRevision: order.revision,
                            orderedStageIds: ids,
                            requestId: newRequestId("reorder"),
                          });
                        })
                      }
                    >
                      上移
                    </button>
                    <button
                      type="button"
                      className="link-btn"
                      disabled={busy || index === order.stages.length - 1}
                      onClick={() =>
                        void guarded("阶段顺序已调整", () => {
                          const ids = order.stages.map((s) => s.id);
                          const [moved] = ids.splice(index, 1);
                          if (!moved) return Promise.reject(new Error("阶段不存在"));
                          ids.splice(index + 1, 0, moved);
                          return api.workflowReorderStages({
                            orderId: order.id,
                            expectedRevision: order.revision,
                            orderedStageIds: ids,
                            requestId: newRequestId("reorder"),
                          });
                        })
                      }
                    >
                      下移
                    </button>
                    {order.stages.length > 1 && (
                      <button
                        type="button"
                        className="link-btn link-danger"
                        disabled={busy}
                        onClick={() => {
                          const fallback = order.stages.find((s) => s.id !== stage.id);
                          if (!fallback) return;
                          setStageToDelete({
                            id: stage.id,
                            title: stage.title,
                            replacementId: fallback.id,
                            isCurrent: stage.isCurrent,
                          });
                        }}
                      >
                        删除
                      </button>
                    )}
                  </span>
                )}
              </>
            )}
          </li>
        ))}
      </ol>

      <ConfirmDialog
        open={stageToDelete !== null}
        title="确认删除这个阶段？"
        danger
        confirmLabel="确认删除"
        busy={busy}
        onCancel={() => setStageToDelete(null)}
        onConfirm={async () => {
          const target = stageToDelete;
          if (!target) return;
          setStageToDelete(null);
          await guarded("已删除阶段", () =>
            api.workflowRemoveStage({
              orderId: order.id,
              expectedRevision: order.revision,
              stageId: target.id,
              replacementStageId: target.isCurrent ? target.replacementId : null,
              requestId: newRequestId("remove-stage"),
            }),
          );
        }}
      >
        {stageToDelete && (
          <>
            <p>
              即将删除阶段 <strong>「{stageToDelete.title}」</strong>。
            </p>
            <p>
              {stageToDelete.isCurrent
                ? "这是当前阶段，删除后当前阶段会改为同一流程里的下一个阶段。"
                : "已发生的历史事件保留当时的阶段名称，不会因为删除而失真。"}
            </p>
          </>
        )}
      </ConfirmDialog>

      {!locked && (
        <div className="stage-add">
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="新增阶段名称"
            maxLength={80}
            disabled={busy}
          />
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy || newTitle.trim() === ""}
            onClick={() =>
              void guarded("已新增阶段", () =>
                api.workflowAddStage({
                  orderId: order.id,
                  expectedRevision: order.revision,
                  title: newTitle.trim(),
                  requestId: newRequestId("add-stage"),
                }),
              ).then(() => setNewTitle(""))
            }
          >
            添加阶段
          </button>
        </div>
      )}
    </section>
  );
}

function EventTimeline({
  events,
  formatTime,
}: {
  events: OrderEvent[];
  formatTime: (iso: string | null) => string;
}) {
  return (
    <section className="panel">
      <header className="panel-head compact">
        <h2>制作历史</h2>
        <span className="muted">{events.length} 条事件</span>
      </header>
      {events.length === 0 ? (
        <p className="muted">还没有历史事件。</p>
      ) : (
        <ul className="timeline">
          {[...events].reverse().map((event) => (
            <li key={event.id}>
              <span className="timeline-kind">{EVENT_LABEL[event.kind] ?? event.kind}</span>
              <span className="timeline-detail">
                {event.fromStageTitle && event.toStageTitle
                  ? `${event.fromStageTitle} → ${event.toStageTitle}`
                  : event.toStageTitle ?? ""}
                {event.note ? ` · ${event.note}` : ""}
              </span>
              <time className="timeline-time">{formatTime(event.occurredAt)}</time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CreateOrderPanel({
  clients,
  templates,
  busy,
  onCancel,
  onCreated,
  onError,
  setBusy,
}: {
  clients: ClientView[];
  templates: TemplateView[];
  busy: boolean;
  onCancel: () => void;
  onCreated: (order: OrderView) => Promise<void>;
  onError: (message: string) => void;
  setBusy: (value: boolean) => void;
}) {
  const [title, setTitle] = useState("");
  const [clientMode, setClientMode] = useState<"none" | "existing" | "new">("none");
  const [clientId, setClientId] = useState("");
  // 默认选中当前默认模板；用户可主动切换（D-00-07）
  const defaultTemplateId = templates.find((t) => t.isDefault)?.id ?? templates[0]?.id ?? "";
  const [templateId, setTemplateId] = useState(defaultTemplateId);
  // 模板列表可能晚于面板挂载才到达，到了再补上默认值，避免下拉显示与实际提交不一致。
  useEffect(() => {
    if (templateId === "" && defaultTemplateId !== "") setTemplateId(defaultTemplateId);
  }, [defaultTemplateId, templateId]);
  const [newClientName, setNewClientName] = useState("");
  const [commissionType, setCommissionType] = useState("");
  const [source, setSource] = useState("");
  const [amount, setAmount] = useState("");
  const [startDate, setStartDate] = useState("");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [note, setNote] = useState("");
  const requestId = useMemo(() => newRequestId("create"), []);

  async function submit(): Promise<string | null> {
    setBusy(true);
    onError("");
    try {
      const client: CreateOrderInput["client"] =
        clientMode === "existing"
          ? { mode: "existing", clientId }
          : clientMode === "new"
            ? { mode: "new", displayName: newClientName.trim() }
            : { mode: "none" };

      const order = await api.createOrder({
        title,
        client,
        commissionType: commissionType.trim() === "" ? null : commissionType,
        source: source.trim() === "" ? null : source.trim(),
        amountCents: yuanToCents(amount),
        plannedStartDate: startDate === "" ? null : startDate,
        plannedDeliveryDate: deliveryDate === "" ? null : deliveryDate,
        note: note.trim() === "" ? null : note,
        templateId: templateId === "" ? null : templateId,
        requestId,
      });
      await onCreated(order);
      return null;
    } catch (e) {
      const message = describeError(e);
      onError(message);
      return message;
    } finally {
      setBusy(false);
    }
  }

  const creatingDirty =
    title.trim() !== "" ||
    commissionType.trim() !== "" ||
    amount.trim() !== "" ||
    note.trim() !== "" ||
    newClientName.trim() !== "" ||
    clientMode !== "none";
  // 新建面板自己也能被关窗保护：内层 guard 优先于外层的详情 guard。
  useUnsavedGuard({
    id: "orders-create",
    label: "新建订单",
    dirty: creatingDirty,
    save: () => submit(),
    discard: () => onCancel(),
  });

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>新建订单</h2>
          <p className="muted">只有委托标题是必填项。创建后会自动分配编号并加入队列末尾。</p>
        </div>
      </header>

      <div className="form-grid">
        <label className="field field-wide">
          <span>委托标题 *</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            autoFocus
            disabled={busy}
          />
        </label>

        <label className="field">
          <span>客户</span>
          <select
            value={clientMode}
            onChange={(e) => setClientMode(e.target.value as "none" | "existing" | "new")}
            disabled={busy}
          >
            <option value="none">不关联客户</option>
            <option value="existing">选择已有客户</option>
            <option value="new">新建客户</option>
          </select>
        </label>

        {clientMode === "existing" && (
          <label className="field">
            <span>已有客户</span>
            <select value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={busy}>
              <option value="">请选择</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </select>
          </label>
        )}

        {clientMode === "new" && (
          <label className="field">
            <span>新客户名称</span>
            <input
              value={newClientName}
              onChange={(e) => setNewClientName(e.target.value)}
              maxLength={120}
              disabled={busy}
            />
          </label>
        )}

        {/* 说明文字放在 label 之外：否则它会被算进 select 的可访问名称里 */}
        <div className="field">
          <label htmlFor="create-order-template">
            <span>制作流程</span>
          </label>
          <select
            id="create-order-template"
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            disabled={busy || templates.length === 0}
          >
            {templates.length === 0 && <option value="">（使用默认流程）</option>}
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}（{template.stepCount} 个阶段）
                {template.isDefault ? " · 默认" : ""}
              </option>
            ))}
          </select>
          <p className="hint">创建时会把该流程的阶段复制成这张订单的独立流程。</p>
        </div>

        <label className="field">
          <span>委托类型</span>
          <input
            value={commissionType}
            onChange={(e) => setCommissionType(e.target.value)}
            maxLength={80}
            disabled={busy}
          />
        </label>

        <label className="field">
          <span>来源</span>
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            maxLength={40}
            disabled={busy}
            list="order-source-options"
            placeholder="例如 米画师 / 画加 / 私信"
          />
        </label>

        <label className="field">
          <span>委托金额（元，留空表示未知）</span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="例如 800"
            disabled={busy}
          />
        </label>

        <label className="field">
          <span>预计开始日期</span>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            disabled={busy}
          />
        </label>

        <label className="field">
          <span>预计交付日期</span>
          <input
            type="date"
            value={deliveryDate}
            onChange={(e) => setDeliveryDate(e.target.value)}
            disabled={busy}
          />
        </label>

        <label className="field field-wide">
          <span>委托说明</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={4000}
            disabled={busy}
          />
        </label>
      </div>

      <div className="actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void submit()}
          disabled={busy || title.trim() === "" || (clientMode === "existing" && clientId === "") ||
            (clientMode === "new" && newClientName.trim() === "")}
        >
          {busy ? "创建中…" : "创建订单"}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          取消
        </button>
      </div>
    </section>
  );
}
