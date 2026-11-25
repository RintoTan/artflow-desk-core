import { useCallback, useEffect, useMemo, useState } from "react";

import {
  describeError,
  financeApi,
  paymentsApi,
  refundsApi,
  type OrderFinanceView,
  type PaymentRecordView,
  type PlanItemView,
  type PlatformView,
  type RefundView,
} from "../bridge/commands";
import { formatYuan } from "../lib/money";
import { KIND_LABEL, METHOD_LABEL, PlanEditor, RecordForm, RefundForm, VoidDialog } from "./FinanceForms";
import EmptyState from "./EmptyState";

/**
 * 订单详情里的财务区。
 *
 * 三条原则写在代码里：
 * 1. **数字全部来自后端**。这里不做任何金额相加——净到账、待收、差额都是 snapshot 给的。
 * 2. **四种空态各说各的**，不合并成「未付款」，也不写成互斥分支。
 * 3. **取消后只锁收款与计划**，退款照常可管——钱退没退跟订单还在不在做是两件事。
 */

type Props = {
  orderId: string;
  cancelled: boolean;
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
};

type Editing =
  | { kind: "plan" }
  | { kind: "record"; record: PaymentRecordView | null }
  | { kind: "refund"; refund: RefundView | null }
  | { kind: "void-record"; record: PaymentRecordView }
  | { kind: "void-refund"; refund: RefundView }
  | null;

export default function OrderFinancePanel({ orderId, cancelled, onError, onNotice }: Props) {
  const [snapshot, setSnapshot] = useState<OrderFinanceView | null>(null);
  const [platforms, setPlatforms] = useState<PlatformView[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [showVoided, setShowVoided] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const rows = await paymentsApi.snapshot(orderId);
      setSnapshot(rows);
      setLoadError(null);
      setPlatforms(await financeApi.platforms().catch(() => []));
    } catch (cause) {
      setLoadError(describeError(cause));
    }
  }, [orderId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const after = useCallback(
    async (notice: string) => {
      onNotice(notice);
      onError(null);
      await refresh();
    },
    [onNotice, onError, refresh],
  );

  const planTotal = useMemo(
    () => (snapshot ? snapshot.planItems.reduce((acc, item) => acc + item.amountCents, 0) : 0),
    [snapshot],
  );

  if (loadError) {
    return (
      <section className="panel finance-panel">
        <header className="panel-head compact">
          <h2>财务</h2>
        </header>
        <p className="notice notice-error" role="alert">
          {loadError}
        </p>
        <button type="button" className="btn btn-sm" onClick={() => void refresh()}>
          重试
        </button>
      </section>
    );
  }

  if (!snapshot) {
    return (
      <section className="panel finance-panel">
        <header className="panel-head compact">
          <h2>财务</h2>
        </header>
        <p className="muted">正在读取财务信息…</p>
      </section>
    );
  }

  const amountKnown = snapshot.orderAmountCents !== null;
  const canEditPlan = !cancelled && amountKnown && (snapshot.orderAmountCents ?? 0) > 0;
  const canEditRecords = !cancelled;

  return (
    <section className="panel finance-panel">
      <header className="panel-head compact">
        <h2>财务</h2>
        <span className="muted">
          {cancelled ? "订单已取消 · 收款与计划只读，退款仍可管理" : "计划记应收，流水记到账"}
        </span>
      </header>

      {/* ---- 汇总：全部直接用后端返回的数字 */}
      <dl className="finance-figures">
        <div>
          <dt>订单总额</dt>
          <dd>{amountKnown ? formatYuan(snapshot.orderAmountCents) : "—"}</dd>
        </div>
        <div>
          <dt>实际到账</dt>
          <dd>{formatYuan(snapshot.grossReceivedCents)}</dd>
        </div>
        <div>
          <dt>手续费</dt>
          <dd>{formatYuan(snapshot.feeTotalCents)}</dd>
        </div>
        <div>
          <dt>净到账</dt>
          <dd>{formatYuan(snapshot.netReceivedCents)}</dd>
        </div>
        <div>
          <dt>实际退款</dt>
          <dd>{formatYuan(snapshot.refundTotalCents)}</dd>
        </div>
        <div className={snapshot.netRetainedCents < 0 ? "is-negative" : undefined}>
          <dt>净留存</dt>
          <dd>{formatYuan(snapshot.netRetainedCents)}</dd>
        </div>
        <div>
          <dt>{cancelled ? "取消前未收差额" : "待收金额"}</dt>
          <dd>{snapshot.remainingCents === null ? "—" : formatYuan(snapshot.remainingCents)}</dd>
        </div>
        {snapshot.overReceivedCents > 0 && (
          <div>
            <dt>超额收款</dt>
            <dd>{formatYuan(snapshot.overReceivedCents)}</dd>
          </div>
        )}
      </dl>

      {snapshot.netRetainedCents < 0 && (
        <p className="notice notice-warn">
          净留存为负：退款金额超过当前已记录的净到账，请检查是否遗漏了历史收款记录。
        </p>
      )}

      {/* ---- 四种空态：各自独立，不合并、不互斥 */}
      {snapshot.unrecorded && (
        <div className="finance-state">
          <p className="finance-state-title">尚未记录收款信息</p>
          <p className="muted">
            这不代表客户实际上没有付款，只表示目前没有完整的财务记录。
          </p>
          <div className="actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={!canEditPlan}
              title={canEditPlan ? undefined : cancelled ? "订单已取消，计划只读" : "先填写订单金额"}
              onClick={() => setEditing({ kind: "plan" })}
            >
              设置付款计划
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!canEditRecords}
              title={canEditRecords ? undefined : "订单已取消，不能新增收款"}
              onClick={() => setEditing({ kind: "record", record: null })}
            >
              记录收款
            </button>
          </div>
        </div>
      )}

      {snapshot.hasRecordsWithoutPlan && (
        <div className="finance-state">
          <p className="finance-state-title">存在独立收款记录</p>
          <p className="muted">
            这些流水没有关联付款计划，正常计入实际到账，不会被算进定金或尾款。
          </p>
        </div>
      )}

      {!snapshot.planMatchesOrder && planTotal > 0 && amountKnown && (
        <div className="finance-state">
          <p className="finance-state-title">付款计划需要调整</p>
          <p className="muted">
            订单总额 {formatYuan(snapshot.orderAmountCents)}，计划合计 {formatYuan(planTotal)}，差额{" "}
            {formatYuan(Math.abs((snapshot.orderAmountCents ?? 0) - planTotal))}。
            计划不会自动改动，需要你确认后重新保存。
          </p>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!canEditPlan}
            onClick={() => setEditing({ kind: "plan" })}
          >
            调整付款计划
          </button>
        </div>
      )}

      {!amountKnown && (
        <div className="finance-state">
          <p className="finance-state-title">订单金额尚未设置</p>
          <p className="muted">
            待收金额显示为「—」。可以记录实际收款与退款，但还不能建立付款计划。
          </p>
        </div>
      )}

      {/* ---- 付款计划 */}
      <div className="finance-block">
        <div className="finance-block-head">
          <h3>付款计划</h3>
          {cancelled ? (
            <span className="finance-readonly-tag">只读</span>
          ) : (
            <button
              type="button"
              className="btn btn-sm"
              disabled={!canEditPlan}
              title={canEditPlan ? undefined : "订单金额为空或为 0，无法建立计划"}
              onClick={() => setEditing({ kind: "plan" })}
            >
              {snapshot.planItems.length === 0 ? "设置计划" : "编辑计划"}
            </button>
          )}
        </div>

        {snapshot.planItems.length === 0 ? (
          <EmptyState inline title="还没有付款计划" description="没有计划也可以直接记录收款。" />
        ) : (
          <ul className="finance-plan-list">
            {snapshot.planItems.map((item) => (
              <PlanRow key={item.id} item={item} />
            ))}
          </ul>
        )}
      </div>

      {/* ---- 收款 */}
      <div className="finance-block">
        <div className="finance-block-head">
          <h3>收款记录</h3>
          {canEditRecords ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setEditing({ kind: "record", record: null })}
            >
              记录收款
            </button>
          ) : (
            <span className="finance-readonly-tag">只读</span>
          )}
        </div>

        {snapshot.records.length === 0 ? (
          <EmptyState inline title="还没有收款记录" />
        ) : (
          <ul className="finance-record-list">
            {snapshot.records.map((record) => (
              <li key={record.id} className="finance-record">
                <span className="finance-record-main">
                  <span className="finance-record-amount">{formatYuan(record.amountCents)}</span>
                  <span className="finance-record-meta">
                    {record.receivedOn} · {KIND_LABEL[record.kind]}
                    {record.platformName ? ` · ${record.platformName}` : " · 未关联平台"}
                    {record.method ? ` · ${METHOD_LABEL[record.method] ?? record.method}` : ""}
                  </span>
                  <span className="finance-record-sub">
                    手续费 {formatYuan(record.feeCents)} · 净到账 {formatYuan(record.netCents)}
                    {record.scheduleId === null ? " · 独立收款" : ""}
                  </span>
                  {record.note && <span className="finance-record-note">{record.note}</span>}
                </span>
                {canEditRecords && (
                  <span className="finance-record-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setEditing({ kind: "record", record })}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm platform-danger"
                      onClick={() => setEditing({ kind: "void-record", record })}
                    >
                      作废
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {snapshot.voidedRecords.length > 0 && (
          <details className="finance-history">
            <summary>已作废的收款（{snapshot.voidedRecords.length}）</summary>
            <ul className="finance-record-list is-voided">
              {snapshot.voidedRecords.map((record) => (
                <li key={record.id} className="finance-record">
                  <span className="finance-record-main">
                    <span className="finance-record-amount">{formatYuan(record.amountCents)}</span>
                    <span className="finance-record-meta">
                      {record.receivedOn} · 已作废 · {record.voidReason ?? "未填原因"}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {/* ---- 退款 */}
      <div className="finance-block">
        <div className="finance-block-head">
          <h3>退款记录</h3>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setEditing({ kind: "refund", refund: null })}
          >
            记录退款
          </button>
        </div>

        {snapshot.refunds.length === 0 ? (
          <EmptyState inline title="还没有退款记录" />
        ) : (
          <ul className="finance-record-list">
            {snapshot.refunds.map((refund) => (
              <li key={refund.id} className="finance-record">
                <span className="finance-record-main">
                  <span className="finance-record-amount">{formatYuan(refund.amountCents)}</span>
                  <span className="finance-record-meta">
                    {refund.refundedOn}
                    {refund.method ? ` · ${METHOD_LABEL[refund.method] ?? refund.method}` : ""}
                  </span>
                  <span className="finance-record-sub">
                    {refund.unmatched ? "未关联原收款 · 核验不了可退款余额" : "已关联原收款"}
                  </span>
                  {refund.note && <span className="finance-record-note">{refund.note}</span>}
                </span>
                <span className="finance-record-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setEditing({ kind: "refund", refund })}
                  >
                    {refund.unmatched ? "关联原收款" : "编辑"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm platform-danger"
                    onClick={() => setEditing({ kind: "void-refund", refund })}
                  >
                    作废
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}

        {snapshot.voidedRefunds.length > 0 && (
          <button type="button" className="btn btn-link" onClick={() => setShowVoided((v) => !v)}>
            {showVoided ? "收起" : `查看已作废的退款（${snapshot.voidedRefunds.length}）`}
          </button>
        )}
        {showVoided && (
          <ul className="finance-record-list is-voided">
            {snapshot.voidedRefunds.map((refund) => (
              <li key={refund.id} className="finance-record">
                <span className="finance-record-main">
                  <span className="finance-record-amount">{formatYuan(refund.amountCents)}</span>
                  <span className="finance-record-meta">
                    {refund.refundedOn} · 已作废 · {refund.voidReason ?? "未填原因"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ---- 弹层 */}
      {editing?.kind === "plan" && (
        <PlanEditor
          snapshot={snapshot}
          busy={busy}
          onClose={() => setEditing(null)}
          onSaved={(notice) => void after(notice)}
        />
      )}

      {editing?.kind === "record" && (
        <RecordForm
          snapshot={snapshot}
          platforms={platforms}
          editing={editing.record}
          busy={busy}
          onClose={() => setEditing(null)}
          onSaved={(notice) => void after(notice)}
        />
      )}

      {editing?.kind === "refund" && (
        <RefundForm
          snapshot={snapshot}
          editing={
            editing.refund
              ? {
                  id: editing.refund.id,
                  amountCents: editing.refund.amountCents,
                  refundedOn: editing.refund.refundedOn,
                  paymentRecordId: editing.refund.paymentRecordId,
                  method: editing.refund.method,
                  note: editing.refund.note,
                }
              : null
          }
          busy={busy}
          onClose={() => setEditing(null)}
          onSaved={(notice) => void after(notice)}
        />
      )}

      {editing?.kind === "void-record" && (
        <VoidDialog
          title="作废这笔收款？"
          target={`${editing.record.receivedOn} · ${formatYuan(editing.record.amountCents)}`}
          warning="作废后这笔钱不再计入到账、手续费与净到账，计划状态会重新计算。如果它已经关联了有效退款，系统会拒绝作废。"
          busy={busy}
          onClose={() => setEditing(null)}
          onConfirm={async (reason) => {
            setBusy(true);
            try {
              await paymentsApi.voidRecord({ id: editing.record.id, reason });
              await after("收款已作废");
            } finally {
              setBusy(false);
            }
          }}
        />
      )}

      {editing?.kind === "void-refund" && (
        <VoidDialog
          title="作废这笔退款？"
          target={`${editing.refund.refundedOn} · ${formatYuan(editing.refund.amountCents)}`}
          warning="作废后这笔退款不再计入退款合计，净留存会相应回升。作废不可撤销，记录仍会留在历史里。"
          busy={busy}
          onClose={() => setEditing(null)}
          onConfirm={async (reason) => {
            setBusy(true);
            try {
              await refundsApi.void({ id: editing.refund.id, reason });
              await after("退款已作废");
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
    </section>
  );
}

function PlanRow({ item }: { item: PlanItemView }) {
  const status = {
    unpaid: "未收",
    partial: "部分收款",
    settled: "已收齐",
    overdue: "逾期未收",
  }[item.status];
  return (
    <li className={`finance-plan-item${item.status === "overdue" ? " is-overdue" : ""}`}>
      <span className="finance-plan-kind">{KIND_LABEL[item.kind]}</span>
      <span className="finance-plan-amount">{formatYuan(item.amountCents)}</span>
      <span className="finance-plan-progress">
        已收 {formatYuan(item.receivedCents)} · 未收 {formatYuan(item.outstandingCents)}
      </span>
      <span className="finance-plan-date">
        {item.expectedDate === null ? "未设日期" : `预计 ${item.expectedDate}`}
      </span>
      <span className={`finance-status finance-status-${item.status}`}>{status}</span>
    </li>
  );
}
