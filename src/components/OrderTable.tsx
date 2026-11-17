import { useMemo, useState } from "react";

import type { OrderView } from "../bridge/commands";
import { riskBadge } from "../lib/ordersView";

export type SortKey = "code" | "client" | "title" | "source" | "stage" | "status" | "delivery" | "amount";

type Props = {
  orders: OrderView[];
  selectedId: string | null;
  onOpen: (orderId: string) => void;
  formatMoney: (cents: number | null) => string;
  formatDate: (value: string | null) => string;
};

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

function compare(a: OrderView, b: OrderView, key: SortKey): number {
  switch (key) {
    case "code":
      return a.code.localeCompare(b.code);
    case "client":
      return (a.clientName ?? "").localeCompare(b.clientName ?? "");
    case "title":
      return a.title.localeCompare(b.title);
    case "source":
      return (a.source ?? "").localeCompare(b.source ?? "");
    case "stage":
      return (a.currentStageIndex ?? 99) - (b.currentStageIndex ?? 99);
    case "status":
      return a.status.localeCompare(b.status);
    case "delivery":
      // 未排期沉底，避免把空值当成"最早"
      if (!a.plannedDeliveryDate && !b.plannedDeliveryDate) return 0;
      if (!a.plannedDeliveryDate) return 1;
      if (!b.plannedDeliveryDate) return -1;
      return a.plannedDeliveryDate.localeCompare(b.plannedDeliveryDate);
    case "amount":
      if (a.amountCents === null && b.amountCents === null) return 0;
      if (a.amountCents === null) return 1;
      if (b.amountCents === null) return -1;
      return a.amountCents - b.amountCents;
  }
}

/**
 * 表格视图：只增加一种"高密度看法"，不替换已验收的卡片列表。
 *
 * 排序只作用于当前展示：不写回数据库，也不改变活动队列顺序。
 * 明确不显示"实收 / 未收款"——本项目没有收款事实，不能凭空造一列。
 */
export default function OrderTable({
  orders,
  selectedId,
  onOpen,
  formatMoney,
  formatDate,
}: Props) {
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean } | null>(null);

  const rows = useMemo(() => {
    if (!sort) return orders;
    const sorted = [...orders].sort((a, b) => compare(a, b, sort.key));
    return sort.asc ? sorted : sorted.reverse();
  }, [orders, sort]);

  function toggle(key: SortKey) {
    setSort((current) =>
      current && current.key === key ? { key, asc: !current.asc } : { key, asc: true },
    );
  }

  function header(key: SortKey, label: string, className?: string) {
    const active = sort?.key === key;
    return (
      <th
        scope="col"
        className={className}
        aria-sort={active ? (sort.asc ? "ascending" : "descending") : "none"}
      >
        <button type="button" className={`th-btn${active ? " th-btn-active" : ""}`} onClick={() => toggle(key)}>
          {label}
          <span aria-hidden="true">{active ? (sort.asc ? " ↑" : " ↓") : ""}</span>
        </button>
      </th>
    );
  }

  return (
    <div className="table-wrap">
      <table className="order-table">
        <caption className="muted">
          共 {rows.length} 张。列排序只影响当前展示，不改变队列顺序。
        </caption>
        <thead>
          <tr>
            {header("code", "编号")}
            {header("client", "客户")}
            {header("title", "委托标题")}
            {header("source", "来源")}
            <th scope="col" className="col-secondary">
              类型
            </th>
            {header("stage", "阶段")}
            {header("status", "状态")}
            {header("delivery", "计划交付")}
            {header("amount", "已知金额", "num")}
            <th scope="col" className="col-secondary">
              排期
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((order) => (
            <tr
              key={order.id}
              className={order.id === selectedId ? "row-active" : undefined}
              onClick={() => onOpen(order.id)}
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onOpen(order.id);
                }
              }}
            >
              <td className="mono">{order.code}</td>
              <td>{order.clientName ?? "—"}</td>
              <td className="title-cell">
                <TruncatedTitleText text={order.title}>{order.title}</TruncatedTitleText>
                {riskBadge(order) && (
                  <span className={`risk-chip risk-${order.deadlineState}`}>{riskBadge(order)}</span>
                )}
              </td>
              <td>{order.source ?? "—"}</td>
              <td className="col-secondary">{order.commissionType ?? "—"}</td>
              <td>{order.currentStageTitle ?? "—"}</td>
              <td>
                <span className={`chip chip-${order.status}`}>{STATUS_LABEL[order.status]}</span>
                {order.status === "active" && (
                  <span className="muted table-sub">{WORK_LABEL[order.workState]}</span>
                )}
              </td>
              <td>{formatDate(order.plannedDeliveryDate)}</td>
              <td className="num">{formatMoney(order.amountCents)}</td>
              <td className="muted schedule-cell col-secondary">
                {order.plannedStartDate || order.plannedDeliveryDate
                  ? `${order.plannedStartDate ?? "…"} → ${order.plannedDeliveryDate ?? "…"}`
                  : "未排期"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="table-hint muted">
        列排序只影响当前展示。窄窗口下「类型 / 排期」会收起，点开订单可在详情里查看。
      </p>
      {rows.length === 0 && (
        <div className="empty">
          <p>没有符合筛选条件的订单。</p>
        </div>
      )}
    </div>
  );
}

/** 表格里也用现成的截断+气泡，避免长标题把列撑开。 */
function TruncatedTitleText({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <span className="table-title" title={text}>
      {children}
    </span>
  );
}
