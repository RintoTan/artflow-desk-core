import { useMemo, useState } from "react";

import type { OrderCover, OrderView, TemplateView } from "../bridge/commands";
import { isPinned, riskBadge } from "../lib/ordersView";
import { sortOrders, type SortMode } from "../lib/orderSort";
import OrderThumb from "./OrderThumb";
import PinBadge from "./PinBadge";
import { TruncatedTitle } from "./TitleTooltip";

type Props = {
  /** 已经过全局搜索/状态/来源筛选的订单 */
  orders: OrderView[];
  templates: TemplateView[];
  onOpen: (orderId: string) => void;
  /** 右键卡片：菜单由页面处理，看板只管把目标订单交出去。 */
  onContextMenu?: (event: React.MouseEvent, orderId: string) => void;
  formatMoney: (cents: number | null) => string;
  formatDate: (value: string | null) => string;
  /** orderId -> 代表图；缺项就显示占位块。 */
  covers?: Record<string, OrderCover>;
  sortMode: SortMode;
};

/**
 * 看板：平铺卡片网格 + 流程/阶段筛选。
 *
 * 回到「一个模板 + 阶段筛选 + 平铺」的形态：列会把阶段与排序两套维度搅在一起，
 * 实际用起来反而更慢。排序仍然统一走 sortOrders（置顶组在前，组内按当前模式）。
 */
export default function OrderBoard({
  orders,
  templates,
  onOpen,
  onContextMenu,
  formatMoney,
  formatDate,
  covers,
  sortMode,
}: Props) {
  // 默认「全部流程」：默认模板未必有订单，开局就空一屏会让人以为数据没了。
  const [templateId, setTemplateId] = useState<string>("all");
  const activeTemplateId = templateId;
  const activeTemplate = templates.find((t) => t.id === activeTemplateId) ?? null;
  const [stageId, setStageId] = useState<string>("");

  const shown = useMemo(() => {
    const byTemplate =
      activeTemplateId === "all"
        ? orders
        : orders.filter((order) => order.stageTemplateId === activeTemplateId);
    const byStage =
      stageId === ""
        ? byTemplate
        : stageId === "__none"
          ? byTemplate.filter((order) => !order.currentStageId)
          : byTemplate.filter((order) => order.currentStageId === stageId);
    return sortOrders(byStage, sortMode);
  }, [orders, activeTemplateId, stageId, sortMode]);

  return (
    <div className="board-cards-wrap">
      <div className="board-filter-bar">
        <select
          className="board-filter-select"
          value={activeTemplateId}
          onChange={(e) => {
            setTemplateId(e.target.value);
            setStageId("");
          }}
          aria-label="按流程模板筛选"
        >
          <option value="all">全部流程</option>
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </select>

        {activeTemplate && (
          <>
            <button
              type="button"
              className={`filter-chip${stageId === "" ? " filter-chip-active" : ""}`}
              aria-pressed={stageId === ""}
              onClick={() => setStageId("")}
            >
              全部阶段
            </button>
            {activeTemplate.steps.map((step) => (
              <button
                key={step.stepId}
                type="button"
                className={`filter-chip${stageId === step.stepId ? " filter-chip-active" : ""}`}
                aria-pressed={stageId === step.stepId}
                onClick={() => setStageId(step.stepId)}
              >
                {step.title}
              </button>
            ))}
          </>
        )}

        <span className="muted board-count">
          {shown.length} / {orders.length} 张
        </span>
      </div>

      {shown.length === 0 ? (
        <p className="muted board-empty-state">这个条件下没有订单。</p>
      ) : (
        <div className="board-cards">
          {shown.map((order) => (
            <article
              key={order.id}
              className="flat-card"
              role="listitem"
              onContextMenu={(event) => onContextMenu?.(event, order.id)}
            >
              <button
                type="button"
                className="flat-card-open"
                onClick={() => onOpen(order.id)}
                aria-label={`打开 ${order.code} ${order.title}`}
              >
                <OrderThumb cover={covers?.[order.id]} />
                <span className="flat-card-body">
                  <TruncatedTitle className="flat-card-title" text={order.title}>
                    {order.title}
                  </TruncatedTitle>
                  <span className="flat-card-line">
                    <span className="flat-card-client">{order.clientName ?? "未分配客户"}</span>
                    <span className="flat-card-amount">{formatMoney(order.amountCents)}</span>
                  </span>
                  <span className="flat-card-line">
                    <span className="flat-card-tags">
                      {order.currentStageTitle && <span className="chip">{order.currentStageTitle}</span>}
                      {order.status !== "active" && (
                        <span className="chip">{order.status === "complete" ? "已完成" : "已取消"}</span>
                      )}
                      {riskBadge(order) && (
                        <span className={`risk-chip risk-${order.deadlineState}`}>{riskBadge(order)}</span>
                      )}
                    </span>
                  </span>
                  <span className="flat-card-line flat-card-foot">
                    <span className="flat-card-date">{formatDate(order.plannedDeliveryDate)}</span>
                    <span className="muted flat-card-code">
                      {order.code}
                      {isPinned(order) && <PinBadge />}
                    </span>
                  </span>
                </span>
              </button>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
