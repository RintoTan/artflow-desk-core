import { useMemo, useState } from "react";

import type { OrderView } from "../bridge/commands";
import { buildBoard, planStageMove, type StageMovePlan } from "../lib/board";
import { riskBadge } from "../lib/ordersView";
import { TruncatedTitle } from "./TitleTooltip";

type Props = {
  orders: OrderView[];
  busy: boolean;
  onOpen: (orderId: string) => void;
  /** 用户确认后执行；父组件负责调后端与刷新 */
  onApply: (order: OrderView, plan: StageMovePlan) => Promise<void>;
  formatMoney: (cents: number | null) => string;
  formatDate: (value: string | null) => string;
  onError: (message: string) => void;
};

const STATUS_LABEL: Record<string, string> = {
  active: "活动",
  complete: "已完成",
  cancelled: "已取消",
};

/**
 * 看板：按当前制作阶段分列，拖动只产生**候选操作**，
 * 松手后必须在确认框里看到具体动作才会写库。
 */
export default function OrderBoard({
  orders,
  busy,
  onOpen,
  onApply,
  formatMoney,
  formatDate,
  onError,
}: Props) {
  const model = useMemo(() => buildBoard(orders), [orders]);
  const [dragging, setDragging] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    order: OrderView;
    plan: Extract<StageMovePlan, { kind: "advance" | "rework" }>;
  } | null>(null);

  const columns = model.columns;
  const columnCount = columns.length;

  function handleDrop(event: React.DragEvent, title: string) {
    event.preventDefault();
    setOverColumn(null);
    const orderId = event.dataTransfer.getData("text/minidesk-order") || dragging;
    setDragging(null);
    if (!orderId) return;
    const order = orders.find((item) => item.id === orderId);
    if (!order) return;

    const plan = planStageMove(order, title);
    if (plan.kind === "noop") return;
    if (plan.kind === "blocked") {
      onError(plan.reason);
      return;
    }
    setPending({ order, plan });
  }

  return (
    <div className="board-wrap">
      <div className="board" role="list" aria-label="按制作阶段分列的看板">
        {columns.map((column) => (
          <section
            key={column.key}
            role="listitem"
            className={`board-col${overColumn === column.key ? " board-col-over" : ""}`}
            onDragOver={(event) => {
              if (busy) return;
              event.preventDefault();
              setOverColumn(column.key);
            }}
            onDragLeave={() => setOverColumn((current) => (current === column.key ? null : current))}
            onDrop={(event) => handleDrop(event, column.title)}
          >
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

            <div className="board-cards">
              {column.orders.map((order) => (
                <article
                  key={order.id}
                  className={`board-card${dragging === order.id ? " board-card-dragging" : ""}`}
                  draggable={!busy}
                  onDragStart={(event) => {
                    event.dataTransfer.setData("text/minidesk-order", order.id);
                    event.dataTransfer.effectAllowed = "move";
                    setDragging(order.id);
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setOverColumn(null);
                  }}
                >
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
                      <span>{order.clientName ?? "未分配客户"}</span>
                      <span className="board-card-amount">{formatMoney(order.amountCents)}</span>
                    </span>
                    <span className="board-card-foot">
                      <span className="muted">{formatDate(order.plannedDeliveryDate)}</span>
                      <span className="board-card-tags">
                        {order.workState === "queued" && (
                          <span className="chip chip-active">未开工</span>
                        )}
                        {riskBadge(order) && (
                          <span className={`risk-chip risk-${order.deadlineState}`}>
                            {riskBadge(order)}
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                </article>
              ))}
              {column.orders.length === 0 && <p className="board-empty muted">拖到这里</p>}
            </div>
          </section>
        ))}
      </div>

      {model.unassigned.length > 0 && (
        <div className="board-strip">
          <h3>没有当前阶段</h3>
          <ul className="board-strip-list">
            {model.unassigned.map((order) => (
              <li key={order.id}>
                <button type="button" className="link-btn" onClick={() => onOpen(order.id)}>
                  {order.code} {order.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {model.finished.length > 0 && (
        <div className="board-strip board-strip-finished">
          <h3>已结束（{model.finished.length}）</h3>
          <p className="muted">
            已完成与已取消的订单不进入阶段列，也不参与拖拽；需要改阶段请先用「重新打开」。
          </p>
          <ul className="board-strip-list">
            {model.finished.map((order) => (
              <li key={order.id}>
                <button type="button" className="link-btn" onClick={() => onOpen(order.id)}>
                  {order.code} {order.title}
                </button>
                <span className={`chip chip-${order.status}`}>{STATUS_LABEL[order.status]}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {pending && (
        <div className="board-confirm" role="dialog" aria-modal="true" aria-label="确认阶段变更">
          <div className="board-confirm-body">
            <h3>
              {pending.plan.kind === "advance" ? "推进阶段" : "返工到更早阶段"}
            </h3>
            <p>
              <strong>{pending.order.code}</strong> {pending.order.title}
            </p>
            <p>
              将执行：
              {pending.plan.kind === "advance" ? "「推进阶段」" : "「返工」"}
              ，从「{pending.order.currentStageTitle}」到「
              <strong>{pending.plan.targetStageTitle}</strong>」
              {pending.plan.kind === "rework" && pending.plan.steps > 1
                ? `（一次退回 ${pending.plan.steps} 个阶段）`
                : ""}
              。
            </p>
            <p className="muted">
              这会按现有业务流程记录一条阶段变更记录；不改开工、完成、取消，也不改排队顺序。
            </p>
            <div className="board-confirm-actions">
              <button
                type="button"
                className="btn"
                onClick={() => setPending(null)}
                disabled={busy}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={async () => {
                  const current = pending;
                  setPending(null);
                  await onApply(current.order, current.plan);
                }}
              >
                确认变更
              </button>
            </div>
          </div>
        </div>
      )}

      {columns.length === 0 && model.finished.length === 0 && (
        <div className="empty">
          <p>没有符合筛选条件的订单。</p>
        </div>
      )}
      <p className="board-hint muted">
        拖动卡片到目标阶段列 → 确认后才会写入。同一阶段名在不同模板里是不同阶段，不能互相搬运。
        {columnCount > 0 && ` 共 ${columnCount} 列，按阶段顺序排列。`}
      </p>
    </div>
  );
}
