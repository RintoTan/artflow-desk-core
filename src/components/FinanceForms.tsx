import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  describeError,
  paymentsApi,
  refundsApi,
  type OrderFinanceView,
  type PaymentRecordView,
  type PlatformView,
  type PlanItemView,
} from "../bridge/commands";
import { centsToInput, formatYuan, yuanToCents } from "../lib/money";

/**
 * 财务录入用的三种表单 + 一个作废确认。
 *
 * 共同约定：
 * - 金额只做「元 ↔ 分」的解析，别的一律交给后端；
 * - 提交失败留在表单里，不清空输入，错误显示在表单内；
 * - 手续费永远不由前端算（未知费率时尤其不能偷偷填 0）。
 */

export type FinanceKind = "full" | "deposit" | "installment" | "final";

export const KIND_LABEL: Record<FinanceKind, string> = {
  full: "全款",
  deposit: "定金",
  installment: "分期款",
  final: "尾款",
};

export const METHOD_LABEL: Record<string, string> = {
  wechat: "微信",
  alipay: "支付宝",
  bank: "银行卡",
  cash: "现金",
  other: "其他",
};

export function Modal({
  title,
  children,
  actions,
  hint,
  onClose,
  label,
}: {
  title: string;
  children: React.ReactNode;
  actions: React.ReactNode;
  hint?: string;
  onClose: () => void;
  label: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return createPortal(
    <div className="modal-overlay">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        ref={ref}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <h2 className="modal-title">{title}</h2>
        <div className="modal-body">{children}</div>
        <div className="modal-actions">{actions}</div>
        {hint && <p className="modal-hint">{hint}</p>}
      </div>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------- 付款计划

type PlanMode = "none" | "full" | "deposit_final" | "installment";

function modeOf(items: PlanItemView[], planMode: OrderFinanceView["planMode"]): PlanMode {
  if (items.length === 0) return "none";
  if (planMode === "full") return "full";
  if (planMode === "deposit_final") return "deposit_final";
  if (planMode === "installment") return "installment";
  return "none";
}

type PlanRow = { key: string; amount: string; date: string; id?: string };

let seq = 0;
function row(amount = "", date = "", id?: string): PlanRow {
  seq += 1;
  return { key: `p${seq}`, amount, date, id };
}

export function PlanEditor({
  snapshot,
  busy,
  onClose,
  onSaved,
}: {
  snapshot: OrderFinanceView;
  busy: boolean;
  onClose: () => void;
  onSaved: (notice: string) => void;
}) {
  const total = snapshot.orderAmountCents;
  const [mode, setMode] = useState<PlanMode>(modeOf(snapshot.planItems, snapshot.planMode));
  const [deposit, setDeposit] = useState(() => {
    const item = snapshot.planItems.find((i) => i.kind === "deposit");
    return item ? centsToInput(item.amountCents) : "";
  });
  const [rows, setRows] = useState<PlanRow[]>(() =>
    snapshot.planItems.filter((i) => i.kind === "installment").length > 0
      ? snapshot.planItems
          .filter((i) => i.kind === "installment")
          .map((i) => row(centsToInput(i.amountCents), i.expectedDate ?? "", i.id))
      : [row(), row()],
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    items: Array<{ id?: string; kind: FinanceKind; amountCents: number; expectedDate: string | null }>;
    detached: PaymentRecordView[];
  } | null>(null);
  const [saving, setSaving] = useState(false);

  const build = (): {
    items: Array<{ id?: string; kind: FinanceKind; amountCents: number; expectedDate: string | null }>;
    problem: string | null;
  } => {
    if (mode === "none") return { items: [], problem: null };
    if (total === null || total <= 0) {
      return { items: [], problem: "订单金额未填写，无法建立付款计划" };
    }
    if (mode === "full") {
      const existing = snapshot.planItems.find((i) => i.kind === "full");
      return {
        items: [{ id: existing?.id, kind: "full", amountCents: total, expectedDate: existing?.expectedDate ?? null }],
        problem: null,
      };
    }
    if (mode === "deposit_final") {
      const cents = yuanToCents(deposit);
      if (cents === null || cents <= 0) return { items: [], problem: "请填写大于 0 的定金金额" };
      if (cents >= total) return { items: [], problem: "定金必须小于订单总额" };
      const depositItem = snapshot.planItems.find((i) => i.kind === "deposit");
      const finalItem = snapshot.planItems.find((i) => i.kind === "final");
      return {
        items: [
          { id: depositItem?.id, kind: "deposit", amountCents: cents, expectedDate: depositItem?.expectedDate ?? null },
          {
            id: finalItem?.id,
            kind: "final",
            amountCents: total - cents,
            expectedDate: finalItem?.expectedDate ?? null,
          },
        ],
        problem: null,
      };
    }
    if (rows.length < 2) return { items: [], problem: "分期至少需要两期" };
    const parsed = rows.map((r) => ({
      cents: yuanToCents(r.amount),
      date: r.date.trim() === "" ? null : r.date,
      id: r.id,
    }));
    if (parsed.some((p) => p.cents === null || p.cents <= 0)) {
      return { items: [], problem: "每期金额都必须大于 0" };
    }
    const sum = parsed.reduce((acc, p) => acc + (p.cents ?? 0), 0);
    if (sum !== total) {
      return {
        items: [],
        problem: `分期合计 ${formatYuan(sum)} 与订单总额 ${formatYuan(total)} 不一致`,
      };
    }
    return {
      items: parsed.map((p) => ({
        id: p.id,
        kind: "installment" as FinanceKind,
        amountCents: p.cents ?? 0,
        expectedDate: p.date,
      })),
      problem: null,
    };
  };

  const draft = useMemo(build, [mode, deposit, rows, total, snapshot.planItems]);
  const sum = draft.items.reduce((acc, i) => acc + i.amountCents, 0);

  async function submit(confirmDetach: boolean) {
    if (draft.problem) {
      setError(draft.problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await paymentsApi.savePlan({
        orderId: snapshot.orderId,
        items: draft.items.map((i) => ({
          id: i.id ?? null,
          kind: i.kind,
          amountCents: i.amountCents,
          expectedDate: i.expectedDate,
        })),
        confirmDetach,
      });
      onSaved("付款计划已保存");
      onClose();
    } catch (cause) {
      const message = describeError(cause);
      // 后端要求确认解除关联：把受影响的流水摆出来，让人看清楚再决定。
      if (message.includes("确认解除关联")) {
        const keep = new Set(draft.items.map((i) => i.id).filter(Boolean));
        const detached = snapshot.records.filter(
          (r) => r.scheduleId !== null && !keep.has(r.scheduleId),
        );
        setPending({ items: draft.items, detached });
      } else {
        setError(message);
      }
    } finally {
      setSaving(false);
    }
  }

  const disabled = busy || saving;

  return (
    <>
      <Modal
        title="付款计划"
        label="付款计划"
        onClose={onClose}
        hint="计划只是「应收」，不代表已经收到钱。合计必须等于订单总额。"
        actions={
          <>
            <button
              type="button"
              className="btn btn-primary"
              disabled={disabled || draft.problem !== null}
              onClick={() => void submit(false)}
            >
              {saving ? "保存中…" : "保存计划"}
            </button>
            <button type="button" className="btn" onClick={onClose} disabled={disabled}>
              取消
            </button>
          </>
        }
      >
        <div className="finance-mode-tabs" role="tablist" aria-label="计划模式">
          {(
            [
              ["none", "不设计划"],
              ["full", "全款"],
              ["deposit_final", "定金 + 尾款"],
              ["installment", "分期"],
            ] as Array<[PlanMode, string]>
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              className={`btn btn-sm${mode === value ? " is-active" : ""}`}
              onClick={() => setMode(value)}
            >
              {label}
            </button>
          ))}
        </div>

        {total === null && (
          <p className="notice notice-error" role="alert">
            订单金额未填写，无法建立付款计划。请先在「资料」里填写金额。
          </p>
        )}

        {mode === "full" && total !== null && (
          <p className="muted">全款计划金额自动等于订单总额 {formatYuan(total)}。</p>
        )}

        {mode === "deposit_final" && total !== null && (
          <div className="finance-grid-2">
            <div className="field">
              <label htmlFor="plan-deposit">定金（元）</label>
              <input
                id="plan-deposit"
                value={deposit}
                inputMode="decimal"
                placeholder="例如 300"
                onChange={(event) => setDeposit(event.target.value)}
              />
            </div>
            <div className="field">
              <label>尾款（自动计算）</label>
              <p className="finance-readonly-value">
                {yuanToCents(deposit) === null
                  ? "—"
                  : formatYuan(Math.max(total - (yuanToCents(deposit) ?? 0), 0))}
              </p>
            </div>
          </div>
        )}

        {mode === "installment" && (
          <div className="finance-plan-rows">
            {rows.map((r, index) => (
              <div className="finance-plan-row" key={r.key}>
                <div className="field">
                  <label htmlFor={`inst-amount-${r.key}`}>第 {index + 1} 期（元）</label>
                  <input
                    id={`inst-amount-${r.key}`}
                    value={r.amount}
                    inputMode="decimal"
                    onChange={(event) =>
                      setRows((current) =>
                        current.map((x) => (x.key === r.key ? { ...x, amount: event.target.value } : x)),
                      )
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor={`inst-date-${r.key}`}>预计收款（可选）</label>
                  <input
                    id={`inst-date-${r.key}`}
                    type="date"
                    value={r.date}
                    onChange={(event) =>
                      setRows((current) =>
                        current.map((x) => (x.key === r.key ? { ...x, date: event.target.value } : x)),
                      )
                    }
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={rows.length <= 2}
                  onClick={() => setRows((current) => current.filter((x) => x.key !== r.key))}
                >
                  移除
                </button>
              </div>
            ))}
            <button type="button" className="btn btn-sm" onClick={() => setRows((c) => [...c, row()])}>
              增加一期
            </button>
          </div>
        )}

        {mode !== "none" && total !== null && (
          <p className={`finance-sum${sum === total ? "" : " is-mismatch"}`}>
            计划合计 {formatYuan(sum)} / 订单总额 {formatYuan(total)}
            {sum !== total && ` · 差额 ${formatYuan(Math.abs(total - sum))}`}
          </p>
        )}

        {draft.problem && (
          <p className="notice notice-error" role="alert">
            {draft.problem}
          </p>
        )}
        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
      </Modal>

      {pending && (
        <Modal
          title="解除计划关联？"
          label="解除计划关联"
          onClose={() => setPending(null)}
          actions={
            <>
              <button
                type="button"
                className="btn btn-primary"
                disabled={saving}
                onClick={() => void submit(true)}
              >
                {saving ? "保存中…" : "确认解除并保存"}
              </button>
              <button type="button" className="btn" onClick={() => setPending(null)} disabled={saving}>
                取消
              </button>
            </>
          }
        >
          <p>
            新的计划里不再包含 {pending.detached.length} 笔收款流水所挂的计划项。这些流水
            <strong>不会被删除</strong>，只会解除与旧计划的关联，之后作为独立收款保留。
          </p>
          <ul className="finance-detach-list">
            {pending.detached.map((r) => (
              <li key={r.id}>
                {r.receivedOn} · {formatYuan(r.amountCents)}
                {r.platformName ? ` · ${r.platformName}` : ""}
              </li>
            ))}
          </ul>
          <p className="muted">金额、到账日期、平台与手续费快照都不会改变。</p>
        </Modal>
      )}
    </>
  );
}

// ------------------------------------------------------------- 收款流水

export function RecordForm({
  snapshot,
  platforms,
  editing,
  busy,
  onClose,
  onSaved,
}: {
  snapshot: OrderFinanceView;
  platforms: PlatformView[];
  editing: PaymentRecordView | null;
  busy: boolean;
  onClose: () => void;
  onSaved: (notice: string) => void;
}) {
  const [kind, setKind] = useState<FinanceKind>(editing?.kind ?? "full");
  const [scheduleId, setScheduleId] = useState(editing?.scheduleId ?? "");
  const [amount, setAmount] = useState(editing ? centsToInput(editing.amountCents) : "");
  const [receivedOn, setReceivedOn] = useState(editing?.receivedOn ?? todayText());
  const [platformId, setPlatformId] = useState(editing?.platformId ?? "");
  const [fee, setFee] = useState(editing ? centsToInput(editing.feeCents) : "");
  const [method, setMethod] = useState(editing?.method ?? "");
  const [note, setNote] = useState(editing?.note ?? "");
  const [suggested, setSuggested] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const platform = platforms.find((p) => p.id === platformId) ?? null;
  const options = snapshot.planItems.filter((item) => item.kind === kind);

  // 选了平台就向后端要个建议值；费率未知时后端返回 null，这里绝不补 0。
  useEffect(() => {
    const cents = yuanToCents(amount);
    if (!platform || cents === null || cents <= 0) {
      setSuggested(undefined);
      return;
    }
    let live = true;
    void paymentsApi
      .quoteFee(cents, platform.feeRateBp)
      .then((quote) => {
        if (!live) return;
        setSuggested(quote.suggestedFeeCents);
        if (quote.suggestedFeeCents !== null && fee.trim() === "") {
          setFee(centsToInput(quote.suggestedFeeCents));
        }
      })
      .catch(() => {
        if (live) setSuggested(undefined);
      });
    return () => {
      live = false;
    };
    // fee 只用于「第一次自动填」，不参与依赖，避免用户手改后被覆盖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platformId, amount]);

  const disabled = busy || saving;

  async function submit() {
    const cents = yuanToCents(amount);
    const feeCents = yuanToCents(fee);
    if (cents === null || cents <= 0) {
      setError("收款金额必须大于 0");
      return;
    }
    if (feeCents === null) {
      setError("请明确填写实际手续费（没有手续费就填 0）");
      return;
    }
    if (feeCents > cents) {
      setError("手续费不能超过本笔收款金额");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        await paymentsApi.updateRecord({
          id: editing.id,
          scheduleId: scheduleId === "" ? null : scheduleId,
          kind,
          amountCents: cents,
          receivedOn,
          platformId: platformId === "" ? null : platformId,
          feeCents,
          method: method === "" ? null : method,
          note: note.trim() === "" ? null : note.trim(),
        });
        onSaved("收款记录已更新");
      } else {
        await paymentsApi.createRecord({
          orderId: snapshot.orderId,
          scheduleId: scheduleId === "" ? null : scheduleId,
          kind,
          amountCents: cents,
          receivedOn,
          platformId: platformId === "" ? null : platformId,
          feeCents,
          method: method === "" ? null : method,
          note: note.trim() === "" ? null : note.trim(),
          requestId: `pay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        });
        onSaved("已记录收款");
      }
      onClose();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={editing ? "编辑收款" : "记录收款"}
      label={editing ? "编辑收款" : "记录收款"}
      onClose={onClose}
      hint="到账日期是钱真正到账的那天，可以补录历史；不能填未来日期。"
      actions={
        <>
          <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => void submit()}>
            {saving ? "保存中…" : "保存"}
          </button>
          <button type="button" className="btn" onClick={onClose} disabled={disabled}>
            取消
          </button>
        </>
      }
    >
      <div className="finance-grid-2">
        <div className="field">
          <label htmlFor="rec-kind">收款类型</label>
          <select
            id="rec-kind"
            value={kind}
            onChange={(event) => {
              const next = event.target.value as FinanceKind;
              setKind(next);
              setScheduleId("");
            }}
          >
            {(Object.keys(KIND_LABEL) as FinanceKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rec-schedule">关联付款计划</label>
          <select
            id="rec-schedule"
            value={scheduleId}
            onChange={(event) => setScheduleId(event.target.value)}
          >
            <option value="">不关联（独立收款）</option>
            {options.map((item) => (
              <option key={item.id} value={item.id}>
                {KIND_LABEL[item.kind]} · {formatYuan(item.amountCents)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rec-amount">到账金额（元）</label>
          <input
            id="rec-amount"
            value={amount}
            inputMode="decimal"
            placeholder="例如 300"
            onChange={(event) => setAmount(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="rec-date">到账日期</label>
          <input
            id="rec-date"
            type="date"
            value={receivedOn}
            onChange={(event) => setReceivedOn(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="rec-platform">收款平台</label>
          <select
            id="rec-platform"
            value={platformId}
            onChange={(event) => setPlatformId(event.target.value)}
          >
            <option value="">不关联平台</option>
            {platforms
              .filter((p) => !p.archived)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.feeRateBp === null ? " · 费率未设置" : ` · ${(p.feeRateBp / 100).toFixed(2)}%`}
                </option>
              ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rec-fee">实际手续费（元）</label>
          <input
            id="rec-fee"
            value={fee}
            inputMode="decimal"
            placeholder="没有手续费填 0"
            onChange={(event) => {
              setFee(event.target.value);
              setSuggested(undefined);
            }}
          />
          {platform && platform.feeRateBp === null && (
            <p className="hint hint-error">
              该平台未设置费率，系统不会替你按 0% 计算，请手动填写实际扣费。
            </p>
          )}
          {suggested !== undefined && suggested !== null && (
            <p className="hint">按平台费率估算 {formatYuan(suggested)}，可以改成实际扣费。</p>
          )}
        </div>
        <div className="field">
          <label htmlFor="rec-method">收款方式</label>
          <select id="rec-method" value={method} onChange={(event) => setMethod(event.target.value)}>
            <option value="">未指定</option>
            {Object.entries(METHOD_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rec-note">备注</label>
          <input
            id="rec-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="可选"
          />
        </div>
      </div>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}

// --------------------------------------------------------------- 退款

export function RefundForm({
  snapshot,
  editing,
  busy,
  onClose,
  onSaved,
}: {
  snapshot: OrderFinanceView;
  editing: { id: string; amountCents: number; refundedOn: string; paymentRecordId: string | null; method: string | null; note: string | null } | null;
  busy: boolean;
  onClose: () => void;
  onSaved: (notice: string) => void;
}) {
  const linked = editing?.paymentRecordId ?? null;
  const [amount, setAmount] = useState(editing ? centsToInput(editing.amountCents) : "");
  const [refundedOn, setRefundedOn] = useState(editing?.refundedOn ?? todayText());
  const [paymentId, setPaymentId] = useState(linked ?? "");
  const [method, setMethod] = useState(editing?.method ?? "");
  const [note, setNote] = useState(editing?.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const disabled = busy || saving;

  async function submit() {
    const cents = yuanToCents(amount);
    if (cents === null || cents <= 0) {
      setError("退款金额必须大于 0");
      return;
    }
    // 已经关联过原收款的退款不允许解除关联：否则可以绕过「累计退款不超过原收款」的保护。
    if (linked !== null && paymentId === "") {
      setError("已关联原收款的退款不能解除关联，只能更换为同一订单的其他有效收款");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        await refundsApi.update({
          id: editing.id,
          paymentRecordId: paymentId === "" ? null : paymentId,
          amountCents: cents,
          refundedOn,
          method: method === "" ? null : method,
          note: note.trim() === "" ? null : note.trim(),
        });
        onSaved(linked === null && paymentId !== "" ? "已关联原收款并保存" : "退款记录已更新");
      } else {
        await refundsApi.create({
          orderId: snapshot.orderId,
          paymentRecordId: paymentId === "" ? null : paymentId,
          amountCents: cents,
          refundedOn,
          method: method === "" ? null : method,
          note: note.trim() === "" ? null : note.trim(),
          requestId: `refund-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        });
        onSaved("已记录退款");
      }
      onClose();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={editing ? (linked === null ? "关联原收款 / 编辑退款" : "编辑退款") : "记录退款"}
      label={editing ? "编辑退款" : "记录退款"}
      onClose={onClose}
      hint="退款是真实资金流出：不会改动原收款、手续费或付款计划的已收金额。"
      actions={
        <>
          <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => void submit()}>
            {saving ? "保存中…" : "保存"}
          </button>
          <button type="button" className="btn" onClick={onClose} disabled={disabled}>
            取消
          </button>
        </>
      }
    >
      <div className="finance-grid-2">
        <div className="field">
          <label htmlFor="refund-amount">退款金额（元）</label>
          <input
            id="refund-amount"
            value={amount}
            inputMode="decimal"
            placeholder="例如 200"
            onChange={(event) => setAmount(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="refund-date">退款日期</label>
          <input
            id="refund-date"
            type="date"
            value={refundedOn}
            onChange={(event) => setRefundedOn(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="refund-payment">原收款</label>
          <select
            id="refund-payment"
            value={paymentId}
            onChange={(event) => setPaymentId(event.target.value)}
          >
            {linked === null && <option value="">未关联</option>}
            {snapshot.records.map((r) => (
              <option key={r.id} value={r.id}>
                {r.receivedOn} · {formatYuan(r.amountCents)}
                {r.platformName ? ` · ${r.platformName}` : ""}
              </option>
            ))}
          </select>
          {linked !== null && (
            <p className="hint">已关联的记录只能更换原收款，不能改回未关联。</p>
          )}
          {paymentId === "" && (
            <p className="hint">不关联时系统核验不了可退款余额，请自行确认没有超过实收。</p>
          )}
        </div>
        <div className="field">
          <label htmlFor="refund-method">退款方式</label>
          <select id="refund-method" value={method} onChange={(event) => setMethod(event.target.value)}>
            <option value="">未指定</option>
            {Object.entries(METHOD_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="refund-note">备注</label>
          <input id="refund-note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="可选" />
        </div>
      </div>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------- 作废确认

export function VoidDialog({
  title,
  target,
  warning,
  busy,
  onClose,
  onConfirm,
}: {
  title: string;
  target: string;
  warning: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (reason.trim() === "") {
      setError("请填写作废原因");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={title}
      label={title}
      onClose={onClose}
      hint="作废不可撤销，记录本身不会被删除，仍会留在历史里。"
      actions={
        <>
          <button type="button" className="btn btn-danger" disabled={busy || saving} onClick={() => void submit()}>
            {saving ? "处理中…" : "确认作废"}
          </button>
          <button type="button" className="btn" onClick={onClose} disabled={busy || saving}>
            取消
          </button>
        </>
      }
    >
      <p>{target}</p>
      <p className="muted">{warning}</p>
      <div className="field">
        <label htmlFor="void-reason">作废原因</label>
        <input
          id="void-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="例如：金额录错了"
        />
      </div>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}

function todayText(): string {
  const now = new Date();
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

