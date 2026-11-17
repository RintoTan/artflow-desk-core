import { useMemo, useState } from "react";

import type { OrderView, TemplateView } from "../bridge/commands";
import { riskBadge } from "../lib/ordersView";
import { TruncatedTitle } from "./TitleTooltip";

type Props = {
  /** 已经过全局搜索/状态/来源筛选的订单 */
  orders: OrderView[];
  templates: TemplateView[];
  onOpen: (orderId: string) => void;
  formatMoney: (cents: number | null) => string;
  formatDate: (value: string | null) => string;
};

type StageFilter = { templateId: string; stageId: string } | null;

/**
 * 看板 = 扁平订单总览。
 *
 * 不再按制作阶段分列，也不再区分「总览/聚焦」子模式：
 * 所有（筛选后）订单进同一个卡片网格，阶段只是卡片上的标签，
 * 通过「流程模板 + 阶段」两层筛选收窄。
 *
 * 阶段匹配用 (templateId, stageId)，**不用中文名**——不同模板可能有同名阶段。
 * 卡片只负责概览与打开详情，制作阶段操作在订单详情里。
 */
export default function OrderBoard({ orders, templates, onOpen, formatMoney, formatDate }: Props) {
  const [templateId, setTemplateId] = useState<"all" | string>("all");
  const [stage, setStage] = useState<StageFilter>(null);

  const templateOf = useMemo(() => {
    const map = new Map<string, TemplateView>();
    for (const template of templates) map.set(template.id, template);
    return map;
  }, [templates]);

  const scoped = useMemo(
    () => (templateId === "all" ? orders : orders.filter((o) => o.stageTemplateId === templateId)),
    [orders, templateId],
  );

  const shown = useMemo(() => {
    const list = stage
      ? scoped.filter((o) => o.stageTemplateId === stage.templateId && o.currentStageId === stage.stageId)
      : scoped;
    // 活动在前、已结束在后；同组内保持原有排序，不改真实队列。
    return [...list].sort((a, b) => {
      const rank = (order: OrderView) => (order.status === "active" ? 0 : 1);
      return rank(a) - rank(b);
    });
  }, [scoped, stage]);

  const activeTemplate = templateId === "all" ? null : templateOf.get(templateId);

  function pickTemplate(next: string) {
    setTemplateId(next);
    // 换模板后，原阶段条件可能不属于新模板 —— 直接清掉，避免留下不可见条件。
    setStage(null);
  }

  return (
    <div className="board-flat">
      <div className="board-filter-bar">
        <label className="board-filter">
          <span className="muted">流程</span>
          <select
            value={templateId}
            onChange={(e) => pickTemplate(e.target.value)}
            aria-label="按流程模板筛选"
          >
            <option value="all">全部流程</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </label>

        {activeTemplate ? (
          <div className="board-stages" role="group" aria-label="按阶段筛选">
            <button
              type="button"
              className={`stage-chip${stage === null ? " is-on" : ""}`}
              aria-pressed={stage === null}
              onClick={() => setStage(null)}
            >
              全部阶段
            </button>
            {activeTemplate.steps.map((item) => {
              const on = stage?.stageId === item.stepId && stage.templateId === activeTemplate.id;
              return (
                <button
                  key={item.stepId}
                  type="button"
                  className={`stage-chip${on ? " is-on" : ""}`}
                  aria-pressed={on}
                  onClick={() =>
                    setStage(on ? null : { templateId: activeTemplate.id, stageId: item.stepId })
                  }
                >
                  {item.title}
                  <span className="stage-chip-count">
                    {orders.filter(
                      (o) => o.stageTemplateId === activeTemplate.id && o.currentStageId === item.stepId,
                    ).length}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <label className="board-filter">
            <span className="muted">阶段</span>
            <select
              value={stage ? `${stage.templateId}:${stage.stageId}` : "all"}
              onChange={(e) => {
                if (e.target.value === "all") {
                  setStage(null);
                  return;
                }
                const [tpl, stageId] = e.target.value.split(":");
                if (tpl && stageId) setStage({ templateId: tpl, stageId });
              }}
              aria-label="按阶段筛选（按流程分组）"
            >
              <option value="all">全部阶段</option>
              {templates.map((template) => (
                <optgroup key={template.id} label={template.name}>
                  {template.steps.map((item) => (
                    <option key={item.stepId} value={`${template.id}:${item.stepId}`}>
                      {template.name} · {item.title}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        )}

        <span className="muted board-count">
          {shown.length} / {orders.length} 张
        </span>
        {(stage || templateId !== "all") && (
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setStage(null);
              setTemplateId("all");
            }}
          >
            清除看板筛选
          </button>
        )}
      </div>

      {shown.length === 0 ? (
        <p className="muted board-empty-state">
          这个条件下没有订单。
          {(stage || templateId !== "all") && (
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setStage(null);
                setTemplateId("all");
              }}
            >
              清除看板筛选
            </button>
          )}
        </p>
      ) : (
        <div className="board-grid" role="list" aria-label="订单概览">
          {shown.map((order) => (
            <article key={order.id} className="flat-card" role="listitem">
              <button
                type="button"
                className="flat-card-open"
                onClick={() => onOpen(order.id)}
                aria-label={`打开 ${order.code} ${order.title}`}
              >
                <TruncatedTitle className="flat-card-title" text={order.title}>
                  {order.title}
                </TruncatedTitle>
                <span className="flat-card-line">
                  <span className="flat-card-client">{order.clientName ?? "未分配客户"}</span>
                  <span className="flat-card-amount">{formatMoney(order.amountCents)}</span>
                </span>
                <span className="flat-card-line">
                  <span className="flat-card-stage" title={`流程：${templateOf.get(order.stageTemplateId)?.name ?? "未知"}`}>
                    {order.currentStageTitle ?? "未开工"}
                  </span>
                  <span className="flat-card-tags">
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
                  <span className="muted flat-card-code">{order.code}</span>
                </span>
              </button>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
