import { useEffect, useMemo, useRef, useState } from "react";

import type { OrderView } from "../bridge/commands";
import { advanceBlockedReason, buildBoard, planStageMove, type StageMovePlan } from "../lib/board";
import { riskBadge } from "../lib/ordersView";
import { useElementWidth } from "../lib/useElementWidth";
import ConfirmDialog from "./ConfirmDialog";
import { TruncatedTitle } from "./TitleTooltip";

export type BoardMode = "overview" | "focus";

type Props = {
  orders: OrderView[];
  busy: boolean;
  /** 总览 = 全部阶段全部订单；聚焦 = 当前阶段 + 相邻阶段 */
  mode: BoardMode;
  onModeChange: (mode: BoardMode) => void;
  onOpen: (orderId: string) => void;
  onApply: (order: OrderView, plan: StageMovePlan) => Promise<void>;
  formatMoney: (cents: number | null) => string;
  formatDate: (value: string | null) => string;
  onError: (message: string) => void;
};

const FOCUS_COL_PITCH = 212;

/**
 * 看板。两种模式共用同一份分组结果与同一套阶段操作：
 * - 总览：全部阶段、全部（筛选后）订单，纵向滚动即可看完，不做切片。
 *   窄容器 = 每阶段一整行、卡片在行内按可用宽度排列；宽容器 = 阶段网格（保最小列宽）。
 * - 聚焦：只渲染当前阶段 + 相邻阶段，靠阶段导航切换。
 *
 * 阶段变更只有一条路径：卡片 → 阶段操作 → 合法目标 → 二次确认 → 领域命令。
 * 不做 HTML5 拖拽：WKWebView 实机不可靠，留着只会误导。
 */
export default function OrderBoard({
  orders,
  busy: _busy,
  mode,
  onModeChange,
  onOpen,
  onApply,
  formatMoney,
  formatDate,
  onError,
}: Props) {
  const model = useMemo(() => buildBoard(orders), [orders]);
  const columns = model.columns;

  /** 阶段选择对话框：替代原先绝对定位的浮层菜单（会被滚动容器裁切）。 */
  const [picker, setPicker] = useState<{ order: OrderView; target: string | null } | null>(null);
  const [pending, setPending] = useState<{
    order: OrderView;
    plan: Extract<StageMovePlan, { kind: "advance" | "rework" }>;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const boardRef = useRef<HTMLDivElement | null>(null);
  const [wrapRef, wrapWidth] = useElementWidth<HTMLDivElement>();
  const [currentKey, setCurrentKey] = useState<string | null>(null);

  const measured = wrapWidth > 0 ? wrapWidth : 0;
  const focusPerView =
    measured === 0
      ? 1
      : Math.max(1, Math.min(3, Math.floor((measured + 12) / FOCUS_COL_PITCH)));
  const currentIndex = columns.findIndex((column) => column.key === currentKey);
  const focusStart =
    columns.length <= focusPerView
      ? 0
      : Math.min(Math.max(0, currentIndex), columns.length - focusPerView);
  const visibleColumns = columns.slice(focusStart, focusStart + focusPerView);

  /**
   * 跳转阶段。
   * QA-02 P1-02 根因：旧实现先 querySelector 找目标列、找不到就 return，才 setCurrentKey。
   * 聚焦到靠后阶段时前面的阶段不在切片里、没有 DOM，于是"往前点"永远无效。
   * 现在只改状态，滚动交给 effect，等切片重算后再执行。
   */
  function goToColumn(key: string) {
    setCurrentKey(key);
  }

  useEffect(() => {
    const board = boardRef.current;
    if (!board || !currentKey || mode !== "focus") return;
    const target = board.querySelector<HTMLElement>(`[data-col="${currentKey}"]`);
    if (target && typeof board.scrollTo === "function") {
      board.scrollTo({
        left: Math.max(0, target.offsetLeft - board.offsetLeft - 8),
        behavior: "smooth",
      });
    }
  }, [currentKey, focusStart, mode]);

  function nextStageOf(order: OrderView): string | null {
    const index = order.stages.findIndex((stage) => stage.id === order.currentStageId);
    return index >= 0 ? (order.stages[index + 1]?.title ?? null) : null;
  }

  function requestNext(order: OrderView) {
    const title = nextStageOf(order);
    if (!title) return;
    const plan = planStageMove(order, title);
    if (plan.kind === "advance" || plan.kind === "rework") {
      setPending({ order, plan });
    } else if (plan.kind === "blocked") {
      onError(plan.reason);
    }
  }

  function card(order: OrderView) {
    const next = nextStageOf(order);
    const blocked = advanceBlockedReason(order);
    return (
      <article key={order.id} className="board-card">
        <button
          type="button"
          className="board-card-open"
          onClick={() => onOpen(order.id)}
          aria-label={`打开 ${order.code} ${order.title}`}
        >
          <TruncatedTitle className="board-card-title" text={order.title}>
            {order.title}
          </TruncatedTitle>
          <span className="board-card-meta">
            <span className="board-card-client">{order.clientName ?? "未分配客户"}</span>
            <span className="board-card-amount">{formatMoney(order.amountCents)}</span>
          </span>
          <span className="board-card-foot">
            <span className="board-card-date">{formatDate(order.plannedDeliveryDate)}</span>
            <span className="board-card-tags">
              {order.workState === "queued" && <span className="chip chip-active">未开工</span>}
              {riskBadge(order) && (
                <span className={`risk-chip risk-${order.deadlineState}`}>{riskBadge(order)}</span>
              )}
            </span>
          </span>
        </button>
        {order.status === "active" && (
          <div className="board-card-actions">
            <button
              type="button"
              className="board-card-move"
              disabled={!next || Boolean(blocked)}
              title={blocked ?? (next ? `推进到「${next}」` : "已经是最后一个阶段")}
              onClick={() => requestNext(order)}
            >
              {next ? `→ ${next}` : "最后阶段"}
            </button>
            <button
              type="button"
              className="board-card-more"
              aria-haspopup="dialog"
              aria-label={`${order.code} 的阶段操作`}
              title="阶段操作"
              onClick={() => setPicker({ order, target: null })}
            >
              ⋯
            </button>
          </div>
        )}
      </article>
    );
  }

  function stageHead(column: (typeof columns)[number]) {
    return (
      <header className="board-col-head">
        <span className="board-col-title" title={column.title}>
          {column.title}
        </span>
        <span className="board-col-stat">
          {column.orders.length} · {formatMoney(column.knownAmountCents)}
          {column.unknownAmountCount > 0 && (
            <em className="board-unknown" title="这些订单金额未知，未计入合计">
              {" "}
              +{column.unknownAmountCount} 未知
            </em>
          )}
        </span>
      </header>
    );
  }

  return (
    <div className="board-wrap" ref={wrapRef}>
      <div className="board-modes" role="group" aria-label="看板显示方式">
        <button
          type="button"
          className={`board-mode${mode === "overview" ? " is-on" : ""}`}
          aria-pressed={mode === "overview"}
          onClick={() => onModeChange("overview")}
        >
          总览<span className="board-mode-hint">全部阶段</span>
        </button>
        <button
          type="button"
          className={`board-mode${mode === "focus" ? " is-on" : ""}`}
          aria-pressed={mode === "focus"}
          onClick={() => onModeChange("focus")}
        >
          聚焦<span className="board-mode-hint">当前阶段</span>
        </button>
      </div>

      {mode === "focus" && columns.length > 1 && (
        <div className="board-nav" aria-label="阶段导航">
          <button
            type="button"
            className="board-nav-step"
            aria-label="上一个阶段"
            onClick={() => {
              const index = currentIndex < 0 ? 0 : currentIndex;
              goToColumn(columns[Math.max(0, index - 1)]!.key);
            }}
          >
            ‹
          </button>
          <div className="board-nav-track" role="group" aria-label="跳到阶段">
            {columns.map((column) => (
              <button
                key={column.key}
                type="button"
                className={`board-nav-chip${currentKey === column.key ? " is-current" : ""}`}
                aria-current={currentKey === column.key ? "true" : undefined}
                onClick={() => goToColumn(column.key)}
                title={`跳到「${column.title}」`}
              >
                {column.title}
                <span className="board-nav-count">{column.orders.length}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="board-nav-step"
            aria-label="下一个阶段"
            onClick={() => {
              const index = currentIndex < 0 ? 0 : currentIndex;
              goToColumn(columns[Math.min(columns.length - 1, index + 1)]!.key);
            }}
          >
            ›
          </button>
        </div>
      )}

      <div
        className={`board${mode === "overview" ? " board-overview" : ""}${
          mode === "overview" && measured >= 1000 ? " board-overview-wide" : ""
        }`}
        ref={boardRef}
        role="list"
        aria-label={mode === "overview" ? "全部阶段的订单" : "当前与相邻阶段的订单"}
      >
        {(mode === "overview" ? columns : visibleColumns).map((column) => (
          <section key={column.key} role="listitem" data-col={column.key} className="board-col">
            {stageHead(column)}
            <div className="board-cards">
              {column.orders.length === 0 ? (
                <p className="board-empty muted">暂无订单</p>
              ) : (
                column.orders.map((order) => card(order))
              )}
            </div>
          </section>
        ))}

        {model.finished.length > 0 && (
          <section className="board-col board-col-finished" role="listitem" data-finished="1">
            <header className="board-col-head">
              <span className="board-col-title">已结束（{model.finished.length}）</span>
              <span className="board-col-stat">不参与阶段推进</span>
            </header>
            <div className="board-cards">{model.finished.map((order) => card(order))}</div>
          </section>
        )}
      </div>

      {columns.length === 0 && model.finished.length === 0 && (
        <p className="muted">当前筛选下没有订单。</p>
      )}

      <ConfirmDialog
        open={picker !== null}
        title="调整制作阶段"
        confirmLabel="确认调整"
        confirmDisabled={!picker?.target}
        onCancel={() => setPicker(null)}
        onConfirm={() => {
          if (!picker?.target) return;
          const plan = planStageMove(picker.order, picker.target);
          setPicker(null);
          if (plan.kind === "advance" || plan.kind === "rework") {
            setPending({ order: picker.order, plan });
          } else if (plan.kind === "blocked") {
            onError(plan.reason);
          }
        }}
      >
        {picker && (
          <div className="stage-picker">
            <p className="muted">
              {picker.order.code} · {picker.order.title}
            </p>
            <fieldset>
              <legend>只能在该订单自己的流程模板内调整</legend>
              {picker.order.stages.map((stage) => {
                const plan = planStageMove(picker.order, stage.title);
                const usable = plan.kind === "advance" || plan.kind === "rework";
                const current = stage.id === picker.order.currentStageId;
                const reason =
                  plan.kind === "blocked"
                    ? plan.reason
                    : usable
                      ? null
                      : "无法通过单个合法动作到达该阶段";
                return (
                  <label key={stage.id} className={`stage-picker-row${usable ? "" : " is-off"}`}>
                    <input
                      type="radio"
                      name="stage-target"
                      value={stage.title}
                      disabled={!usable}
                      checked={picker.target === stage.title}
                      onChange={() => setPicker({ order: picker.order, target: stage.title })}
                    />
                    <span className="stage-picker-name">{stage.title}</span>
                    <span className="stage-picker-note">
                      {current ? "当前阶段" : (reason ?? (plan.kind === "rework" ? "返工" : "推进"))}
                    </span>
                  </label>
                );
              })}
            </fieldset>
            <p className="muted">确认后还会再弹一次变更确认；取消不会写入任何数据。</p>
          </div>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={pending !== null}
        title="确认阶段变更"
        confirmLabel="确认变更"
        busy={submitting}
        onCancel={() => {
          if (!submitting) setPending(null);
        }}
        onConfirm={() => {
          if (!pending || submitting) return;
          setSubmitting(true);
          void onApply(pending.order, pending.plan).finally(() => {
            setSubmitting(false);
            setPending(null);
          });
        }}
      >
        {pending && (
            <div className="board-confirm">
              <p>
                <strong>{pending.order.code}</strong> {pending.order.title}
              </p>
              <dl>
                <div>
                  <dt>将执行</dt>
                  <dd>{pending.plan.kind === "advance" ? "推进阶段" : "返工"}</dd>
                </div>
                <div>
                  <dt>目标阶段</dt>
                  <dd>{pending.plan.targetStageTitle}</dd>
                </div>
              </dl>
              <ul>
                <li>只影响制作阶段，不改订单状态、队列位置与金额。</li>
                <li>若数据已被别处修改，会因版本冲突中止，不会部分写入。</li>
              </ul>
            </div>
        )}
      </ConfirmDialog>
    </div>
  );
}
