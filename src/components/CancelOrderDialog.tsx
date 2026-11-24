import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { describeError, paymentsApi, type PaymentRecordView } from "../bridge/commands";

/**
 * 取消订单时必须先回答一个问题：这笔委托到底退没退钱。
 *
 * 退款是真实资金流出，不能靠猜，也不能事后从「已取消」倒推。所以这里不给默认
 * 选项——用户必须明确选一个。选了「有退款」就必须至少填一笔有效金额，否则不许取消。
 *
 * 退款记录与取消在同一个后端事务里写入：要么都成，要么都不成。
 */

export type CancelRefundDraft = {
  paymentRecordId: string | null;
  amountCents: number;
  refundedOn: string;
  method: string | null;
  note: string | null;
};

export type CancelOrderPayload = {
  orderId: string;
  expectedRevision: number;
  requestId: string;
  refundDecision: "none" | "record";
  refunds: CancelRefundDraft[];
};

type Props = {
  open: boolean;
  orderId: string | null;
  orderCode: string;
  orderTitle: string;
  currentStageTitle: string | null;
  expectedRevision: number;
  busy: boolean;
  newRequestId: () => string;
  onCancel: () => void;
  onConfirm: (payload: CancelOrderPayload) => Promise<void>;
};

type Row = {
  key: string;
  amount: string;
  date: string;
  paymentRecordId: string;
  method: string;
  note: string;
};

let rowSeq = 0;
function newRow(today: string): Row {
  rowSeq += 1;
  return { key: `r${rowSeq}`, amount: "", date: today, paymentRecordId: "", method: "", note: "" };
}

function today(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 元文本 → 整数分。只接受两位小数以内的正数，其余按无效处理。 */
export function parseYuan(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return cents > 0 ? cents : null;
}

export default function CancelOrderDialog({
  open,
  orderId,
  orderCode,
  orderTitle,
  currentStageTitle,
  expectedRevision,
  busy,
  newRequestId,
  onCancel,
  onConfirm,
}: Props) {
  const [decision, setDecision] = useState<"none" | "record" | "">("");
  const [rows, setRows] = useState<Row[]>([]);
  const [payments, setPayments] = useState<PaymentRecordView[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDecision("");
    setRows([newRow(today())]);
    setError(null);
    setPayments([]);
    if (!orderId) return;
    let live = true;
    void paymentsApi
      .snapshot(orderId)
      .then((snapshot) => {
        if (live) setPayments(snapshot.records);
      })
      .catch(() => {
        // 读不到收款不影响取消：退款仍可不关联原收款记录。
      });
    return () => {
      live = false;
    };
  }, [open, orderId]);

  const parsed = useMemo(
    () =>
      rows.map((row) => ({
        row,
        cents: parseYuan(row.amount),
        dateOk: /^\d{4}-\d{2}-\d{2}$/.test(row.date),
      })),
    [rows],
  );

  const canConfirm = useMemo(() => {
    if (decision === "") return false;
    if (decision === "none") return true;
    return parsed.every((p) => p.cents !== null && p.dateOk);
  }, [decision, parsed]);

  function submit() {
    if (!canConfirm || !orderId) return;
    setError(null);
    const refunds: CancelRefundDraft[] =
      decision === "record"
        ? parsed.map((p) => ({
            paymentRecordId: p.row.paymentRecordId === "" ? null : p.row.paymentRecordId,
            amountCents: p.cents ?? 0,
            refundedOn: p.row.date,
            method: p.row.method === "" ? null : p.row.method,
            note: p.row.note.trim() === "" ? null : p.row.note.trim(),
          }))
        : [];
    void onConfirm({
      orderId,
      expectedRevision,
      requestId: newRequestId(),
      refundDecision: decision === "record" ? "record" : "none",
      refunds,
    }).catch((cause: unknown) => setError(describeError(cause)));
  }

  if (!open) return null;

  return createPortal(
    <div className="modal-overlay" data-testid="cancel-overlay">
      <div
        className="modal cancel-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label="取消订单"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onCancel();
          }
        }}
      >
        <h2 className="modal-title">取消这张订单？</h2>
        <div className="modal-body">
        <p>
          <strong>{orderCode}</strong>「{orderTitle}」会退出活动队列，制作流程被锁定；
          当前阶段「{currentStageTitle ?? "—"}」、开工记录与历史事件都会保留。这一步不会删除任何数据。
        </p>

        <fieldset className="cancel-decision">
          <legend>本次取消操作是否同时发生退款？</legend>
          <label className="check-line">
            <input
              type="radio"
              name="refund-decision"
              value="none"
              checked={decision === "none"}
              onChange={() => setDecision("none")}
            />
            <span>没有退款</span>
          </label>
          <p className="hint">
            本次取消不涉及退钱。订单此前已经发生过的退款不会被改动，也不需要在这里重复记录。
          </p>
          <label className="check-line">
            <input
              type="radio"
              name="refund-decision"
              value="record"
              checked={decision === "record"}
              onChange={() => setDecision("record")}
            />
            <span>已经退款给客户</span>
          </label>
          <p className="hint">
            退款会作为独立的资金流出记录保留，原收款与手续费不会被改写，也不会被作废。
          </p>
        </fieldset>

        {decision === "record" && (
          <div className="refund-rows">
            {parsed.map(({ row, cents }, index) => (
              <div className="refund-row" key={row.key}>
                <div className="field">
                  <label htmlFor={`refund-amount-${row.key}`}>退款金额（元）</label>
                  <input
                    id={`refund-amount-${row.key}`}
                    value={row.amount}
                    inputMode="decimal"
                    placeholder="例如 200 或 200.50"
                    onChange={(event) =>
                      setRows((current) =>
                        current.map((r) => (r.key === row.key ? { ...r, amount: event.target.value } : r)),
                      )
                    }
                  />
                  {row.amount.trim() !== "" && cents === null && (
                    <p className="hint hint-error">请填大于 0 的金额，最多两位小数</p>
                  )}
                </div>
                <div className="field">
                  <label htmlFor={`refund-date-${row.key}`}>退款日期</label>
                  <input
                    id={`refund-date-${row.key}`}
                    type="date"
                    value={row.date}
                    onChange={(event) =>
                      setRows((current) =>
                        current.map((r) => (r.key === row.key ? { ...r, date: event.target.value } : r)),
                      )
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor={`refund-payment-${row.key}`}>关联原收款</label>
                  <select
                    id={`refund-payment-${row.key}`}
                    value={row.paymentRecordId}
                    onChange={(event) =>
                      setRows((current) =>
                        current.map((r) =>
                          r.key === row.key ? { ...r, paymentRecordId: event.target.value } : r,
                        ),
                      )
                    }
                  >
                    <option value="">不关联（历史订单可能没录过收款）</option>
                    {payments.map((payment) => (
                      <option key={payment.id} value={payment.id}>
                        {payment.receivedOn} · {formatCents(payment.amountCents)} 元
                        {payment.platformName ? ` · ${payment.platformName}` : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={rows.length === 1}
                  onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                >
                  移除
                </button>
                <span className="visually-hidden">{`第 ${index + 1} 笔退款`}</span>
              </div>
            ))}
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setRows((current) => [...current, newRow(today())])}
            >
              再加一笔退款
            </button>
            <p className="hint">
              不关联原收款时，系统核验不了可退款余额，请自行确认金额没有超过实收。
            </p>
          </div>
        )}

        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
        {!error && decision === "record" && !canConfirm && (
          <p className="notice notice-error" role="alert">
            请先填一笔有效的退款金额与日期，再确认取消。
          </p>
        )}

        </div>
        <div className="modal-actions">
          <button
            type="button"
            className="btn btn-danger"
            onClick={submit}
            disabled={busy || !canConfirm}
          >
            {busy ? "处理中…" : "确认取消订单"}
          </button>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            保留订单
          </button>
        </div>
        <p className="modal-hint">按 Esc 等同于「保留订单」，不会执行任何更改。</p>
      </div>
    </div>,
    document.body,
  );
}

function formatCents(cents: number): string {
  return `${Math.trunc(cents / 100)}.${String(Math.abs(cents % 100)).padStart(2, "0")}`;
}
