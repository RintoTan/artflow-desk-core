import { useEffect, useMemo, useState } from "react";

import type { OrderView } from "../bridge/commands";
import { formatDayKey, parseDayKey } from "../lib/scheduleBar";
import ConfirmDialog from "./ConfirmDialog";

export type ReschedulePlan = { start: string | null; delivery: string | null };

type Props = {
  open: boolean;
  /** 正在改期的订单；关闭时可传 null。 */
  order: OrderView | null;
  /** 拖放算出的目标日期；键盘路径为当前日期。 */
  initial: ReschedulePlan | null;
  /** 拖放来源的落点（用于"拖到过去日期"的提示）。 */
  droppedDay?: string | null;
  today: string;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (plan: ReschedulePlan, reason: string) => void | Promise<void>;
};

function pretty(value: string | null): string {
  const day = value === null ? null : parseDayKey(value);
  return day === null ? "未设置" : formatDayKey(day);
}

function describe(order: OrderView): string {
  return [order.clientName, order.commissionType].filter(Boolean).join(" · ");
}

/**
 * 统一改期确认。日历拖放、日历键盘改期、未排期池拖入都走这里。
 *
 * 对话框本身**不写库**：只有 `onConfirm` 被点下之后，页面才会发一次命令。
 */
export default function RescheduleDialog({
  open,
  order,
  initial,
  droppedDay = null,
  today,
  busy = false,
  error = null,
  onCancel,
  onConfirm,
}: Props) {
  const [start, setStart] = useState("");
  const [delivery, setDelivery] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!open) return;
    setStart(initial?.start ?? "");
    setDelivery(initial?.delivery ?? "");
    setReason("");
  }, [open, initial?.start, initial?.delivery]);

  const nextStart = start;
  const nextDelivery = delivery;
  /** 两个端点都空时没有可写入的排期，直接禁用确认。 */
  const bothEmpty = nextStart === "" && nextDelivery === "";

  const invalid = useMemo(() => {
    const s = nextStart === "" ? null : parseDayKey(nextStart);
    const d = nextDelivery === "" ? null : parseDayKey(nextDelivery);
    if (nextStart !== "" && s === null) return "计划开始日期不是有效日期";
    if (nextDelivery !== "" && d === null) return "计划交付日期不是有效日期";
    if (s !== null && d !== null && d < s) return "计划交付日期不能早于计划开始日期";
    return null;
  }, [nextStart, nextDelivery]);

  const unchanged =
    order !== null &&
    (nextStart === "" ? null : nextStart) === order.plannedStartDate &&
    (nextDelivery === "" ? null : nextDelivery) === order.plannedDeliveryDate;

  const startChanged = order !== null && (nextStart === "" ? null : nextStart) !== order.plannedStartDate;
  const deliveryChanged =
    order !== null && (nextDelivery === "" ? null : nextDelivery) !== order.plannedDeliveryDate;

  const droppedInPast = droppedDay !== null && parseDayKey(droppedDay) !== null &&
    (parseDayKey(droppedDay) as number) < (parseDayKey(today) as number);

  return (
    <ConfirmDialog
      open={open}
      title="改期确认"
      confirmLabel="确认改期"
      cancelLabel="取消"
      busy={busy}
      error={error}
      confirmDisabled={invalid !== null || bothEmpty || unchanged || order === null}
      onCancel={onCancel}
      onConfirm={() =>
        onConfirm(
          { start: nextStart === "" ? null : nextStart, delivery: nextDelivery === "" ? null : nextDelivery },
          reason,
        )
      }
    >
      {order !== null && (
        <div className="cal-dialog">
          <p className="cal-dialog-order">
            <span className="mono">{order.code}</span>
            <strong>{order.title}</strong>
            <span className="cal-dialog-sub">{describe(order)}</span>
          </p>

          {(order.plannedStartDate === null && order.plannedDeliveryDate === null) && (
            <p className="cal-dialog-hint">
              这条订单还没有计划日期：可以只填一端，也可以两端都填；留空的一端不会被自动补上。
            </p>
          )}

          <div className="cal-dialog-dates">
            <label>
              <span>计划开始</span>
              <input type="date" value={start} onChange={(event) => setStart(event.target.value)} />
              <em>
                {startChanged
                  ? `原 ${pretty(order.plannedStartDate)} → ${pretty(nextStart === "" ? null : nextStart)}`
                  : "保持不变"}
              </em>
            </label>
            <label>
              <span>计划交付</span>
              <input
                type="date"
                value={delivery}
                onChange={(event) => setDelivery(event.target.value)}
              />
              <em>
                {deliveryChanged
                  ? `原 ${pretty(order.plannedDeliveryDate)} → ${pretty(nextDelivery === "" ? null : nextDelivery)}`
                  : "保持不变"}
              </em>
            </label>
          </div>

          {invalid !== null && <p className="cal-dialog-invalid">{invalid}</p>}

          {droppedInPast && (
            <p className="cal-dialog-hint">
              你选择的是过去的日期。这是计划日期调整，不代表延期说明，也不改变实际完成时间。
            </p>
          )}

          <label className="cal-dialog-reason">
            <span className="cal-dialog-label">
              改期原因
              <em className="cal-opt">选填</em>
            </span>
            <input
              type="text"
              value={reason}
              maxLength={200}
              placeholder="例如：客户调整交稿时间"
              onChange={(event) => setReason(event.target.value)}
            />
          </label>

          <p className="cal-dialog-footnote">
            本次只修改计划日期，不影响订单状态、制作进度、开工记录、完成记录与制作队列。
          </p>
        </div>
      )}
    </ConfirmDialog>
  );
}
