import { useEffect, useRef, useState } from "react";

import {
  describeError,
  financeStatsApi,
  type FinanceStatsReport,
  type MonthCashFlow,
} from "../bridge/commands";
import { formatYuan } from "../lib/money";

/**
 * FIN-05 财务统计。
 *
 * 这里只做三件事：请求、排序展示、画图。所有金额都来自后端一次聚合的结果，
 * 页面不做任何相加——否则统计页和订单详情迟早会对不上。
 *
 * 图表用 div 宽度画，不引图表库：数据量小、要跟着主题走、还要在窄窗口里活下来。
 */

const RANGES = [
  { key: "thisMonth", label: "本月" },
  { key: "last6", label: "近 6 个月" },
  { key: "last12", label: "近 12 个月" },
  { key: "all", label: "全部" },
] as const;

type Props = {
  range: string;
  onRangeChange: (key: "thisMonth" | "last6" | "last12" | "all") => void;
};

export default function FinanceStatsPanel({ range, onRangeChange }: Props) {
  const [report, setReport] = useState<FinanceStatsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 快速切范围时，旧请求回来不许覆盖新结果。
  const token = useRef(0);

  useEffect(() => {
    const mine = ++token.current;
    setLoading(true);
    void financeStatsApi
      .report(range)
      .then((next) => {
        if (mine !== token.current) return;
        setReport(next);
        setError(null);
      })
      .catch((cause) => {
        if (mine !== token.current) return;
        // 保留上一次可用数据，只提示失败。
        setError(describeError(cause));
      })
      .finally(() => {
        if (mine === token.current) setLoading(false);
      });
  }, [range]);

  const chips = (
    <div className="segmented" role="group" aria-label="财务统计范围">
      {RANGES.map((item) => (
        <button
          key={item.key}
          type="button"
          className={`filter-chip${range === item.key ? " filter-chip-active" : ""}`}
          aria-pressed={range === item.key}
          onClick={() => onRangeChange(item.key)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );

  if (!report && loading) {
    return <div className="finance-stats">{chips}<p className="muted">正在统计财务数据…</p></div>;
  }

  if (!report) {
    return (
      <div className="finance-stats">
        {chips}
        <p className="notice notice-error" role="alert">
          {error ?? "财务统计加载失败"}
        </p>
        <button type="button" className="btn btn-sm" onClick={() => onRangeChange(range as "thisMonth")}>
          重试
        </button>
      </div>
    );
  }

  const { lifetime, current, period, monthly, annual, expected } = report;
  const annualMax = Math.max(1, ...annual.map((y) => y.netReceivedCents));
  const expectedMax = Math.max(1, ...expected.months.map((m) => m.amountCents));
  const noMoney = lifetime.grossReceivedCents === 0 && lifetime.refundTotalCents === 0;

  return (
    <div className="finance-stats">
      <div className="finance-stats-toolbar">
        {chips}
        <span className="muted mono">
          {report.fromMonth} ~ {report.toMonth}
          {loading ? " · 更新中…" : ""}
        </span>
      </div>

      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}

      {/* 累计：全历史，不受范围影响 */}
      <section className="finance-stats-block">
        <h3>累计（全部历史）</h3>
        <dl className="finance-figures">
          <div>
            <dt>实际到账</dt>
            <dd>{formatYuan(lifetime.grossReceivedCents)}</dd>
          </div>
          <div>
            <dt>平台手续费</dt>
            <dd>{formatYuan(lifetime.feeTotalCents)}</dd>
          </div>
          <div>
            <dt>净到账</dt>
            <dd>{formatYuan(lifetime.netReceivedCents)}</dd>
          </div>
          <div>
            <dt>实际退款</dt>
            <dd>{formatYuan(lifetime.refundTotalCents)}</dd>
          </div>
          <div className={lifetime.netRetainedCents < 0 ? "is-negative" : undefined}>
            <dt>净留存</dt>
            <dd>{formatYuan(lifetime.netRetainedCents)}</dd>
          </div>
        </dl>
        <p className="hint">
          净到账是扣掉平台手续费后的到账，不是利润——系统没有成本与税费数据。净留存再扣除实际退款。
        </p>
      </section>

      {/* 当前状态：同样是快照，不跟日期范围走 */}
      <section className="finance-stats-block">
        <h3>当前状态</h3>
        <dl className="finance-figures is-secondary">
          <div>
            <dt>待收款</dt>
            <dd>{formatYuan(current.remainingCents)}</dd>
          </div>
          {current.overReceivedCents > 0 && (
            <div>
              <dt>超额收款</dt>
              <dd>{formatYuan(current.overReceivedCents)}</dd>
            </div>
          )}
          <div>
            <dt>未记录收款信息</dt>
            <dd>{current.unrecordedOrders} 单</dd>
          </div>
          <div>
            <dt>金额未知</dt>
            <dd>{current.unknownAmountOrders} 单</dd>
          </div>
          <div>
            <dt>计划与总额不符</dt>
            <dd>{current.planMismatchOrders} 单</dd>
          </div>
        </dl>
        {current.unrecordedOrders > 0 && (
          <p className="hint">
            未记录收款信息不代表客户没有付款，只代表系统里还没有这些订单的收款记录。
          </p>
        )}
        {current.planMismatchOrders > 0 && (
          <p className="hint">付款计划合计与订单金额不一致的订单，需要到订单详情里重新调整计划。</p>
        )}
      </section>

      <section className="finance-stats-block">
        <h3>所选区间合计</h3>
        <dl className="finance-figures is-secondary">
          <div>
            <dt>到账</dt>
            <dd>{formatYuan(period.grossReceivedCents)}</dd>
          </div>
          <div>
            <dt>手续费</dt>
            <dd>{formatYuan(period.feeTotalCents)}</dd>
          </div>
          <div>
            <dt>净到账</dt>
            <dd>{formatYuan(period.netReceivedCents)}</dd>
          </div>
          <div>
            <dt>退款</dt>
            <dd>{formatYuan(period.refundTotalCents)}</dd>
          </div>
          <div className={period.netRetainedCents < 0 ? "is-negative" : undefined}>
            <dt>净留存</dt>
            <dd>{formatYuan(period.netRetainedCents)}</dd>
          </div>
        </dl>
      </section>

      {/* 月度现金流 */}
      <section className="finance-stats-block">
        <h3>月度现金流</h3>
        {monthly.length === 0 ? (
          <p className="muted">{noMoney ? "当前没有已记录的收款流水。" : "所选区间内没有收款或退款记录。"}</p>
        ) : (
          <>
            <div className="finance-legend">
              <span className="legend-dot legend-gross" /> 实际到账
              <span className="legend-dot legend-fee" /> 手续费
              <span className="legend-dot legend-refund" /> 退款
            </div>
            <MonthBars months={monthly} />
          </>
        )}
      </section>

      {/* 年度净到账 */}
      <section className="finance-stats-block">
        <h3>年度净到账</h3>
        {annual.length === 0 ? (
          <p className="muted">还没有可用于统计的年度收款。</p>
        ) : (
          <ul className="finance-year-list">
            {annual.map((year) => (
              <li key={year.year}>
                <span className="finance-year-label mono">{year.year}</span>
                <span className="finance-year-bar">
                  <span
                    style={{ width: `${pct(year.netReceivedCents, annualMax)}%` }}
                    title={`${year.year} 净到账 ${formatYuan(year.netReceivedCents)}（到账 ${formatYuan(
                      year.grossReceivedCents,
                    )} − 手续费 ${formatYuan(year.feeTotalCents)}）`}
                  />
                </span>
                <span className="finance-year-value mono">{formatYuan(year.netReceivedCents)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="hint">按实际收款日期归年；退款不计入这张图，见上方的月度现金流。</p>
      </section>

      {/* 预计收款 */}
      <section className="finance-stats-block">
        <h3>预计收款</h3>
        <p className="hint">
          只统计你已经建立的付款计划，不按截稿日期推算。当前月 + 后续 5 个月。
        </p>
        <dl className="finance-figures is-secondary">
          <div className={expected.overdueCents > 0 ? "is-negative" : undefined}>
            <dt>已逾期</dt>
            <dd>{formatYuan(expected.overdueCents)}</dd>
          </div>
          <div>
            <dt>未安排日期</dt>
            <dd>{formatYuan(expected.unscheduledCents)}</dd>
          </div>
          <div>
            <dt>更远期计划</dt>
            <dd>{formatYuan(expected.beyondCents)}</dd>
          </div>
          <div>
            <dt>没有付款计划的订单</dt>
            <dd>{expected.noPlanOrders} 单</dd>
          </div>
        </dl>
        {expected.months.length === 0 ? (
          <p className="muted">
            {expected.unscheduledCents > 0
              ? "没有设置预计收款日期的付款计划，只有未安排金额。"
              : "这六个月里没有已安排日期的应收款。"}
          </p>
        ) : (
          <ul className="finance-year-list">
            {expected.months.map((month) => (
              <li key={month.month}>
                <span className="finance-year-label mono">{month.month}</span>
                <span className="finance-year-bar">
                  <span
                    style={{ width: `${pct(month.amountCents, expectedMax)}%` }}
                    title={`${month.month} 预计 ${formatYuan(month.amountCents)}（${month.count} 笔）`}
                  />
                </span>
                <span className="finance-year-value mono">{formatYuan(month.amountCents)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 平台 */}
      <section className="finance-stats-block">
        <h3>按接单平台</h3>
        {report.byPlatform.length === 0 ? (
          <p className="muted">所选区间内没有收款流水。</p>
        ) : (
          <GroupList
            rows={report.byPlatform.map((row) => ({
              key: row.platformName ?? "__none__",
              label: row.platformName ?? "未记录平台",
              count: row.count,
              gross: row.grossReceivedCents,
              fee: row.feeTotalCents,
              net: row.netReceivedCents,
            }))}
          />
        )}
        <p className="hint">按收款当时记录的平台名称归类；平台改名或删除后，历史仍归原来的名字。</p>
      </section>

      {/* 付款方式 */}
      <section className="finance-stats-block">
        <h3>按付款方式</h3>
        {report.byMethod.length === 0 ? (
          <p className="muted">所选区间内没有收款流水。</p>
        ) : (
          <GroupList
            rows={report.byMethod.map((row) => ({
              key: row.method ?? "__none__",
              label: METHOD_LABEL[row.method ?? ""] ?? "未记录方式",
              count: row.count,
              gross: row.grossReceivedCents,
              fee: row.feeTotalCents,
              net: row.netReceivedCents,
            }))}
          />
        )}
      </section>

      {/* 委托类型 */}
      <section className="finance-stats-block">
        <h3>按委托类型</h3>
        {report.byOrderType.length === 0 ? (
          <p className="muted">没有可用于统计的有效订单金额。</p>
        ) : (
          <div className="finance-table-wrap">
            <table className="finance-table">
              <thead>
                <tr>
                  <th scope="col">类型</th>
                  <th scope="col">订单</th>
                  <th scope="col">订单金额</th>
                  <th scope="col">实际到账</th>
                  <th scope="col">手续费</th>
                  <th scope="col">退款</th>
                  <th scope="col">净留存</th>
                </tr>
              </thead>
              <tbody>
                {report.byOrderType.map((row) => (
                  <tr key={row.orderType ?? "__none__"}>
                    <th scope="row">{row.orderType ?? "未分类"}</th>
                    <td className="mono">
                      {row.orders}
                      {row.unknownAmountOrders > 0 && (
                        <span className="muted">（{row.unknownAmountOrders} 单金额未知）</span>
                      )}
                    </td>
                    <td className="mono">{formatYuan(row.orderAmountCents)}</td>
                    <td className="mono">{formatYuan(row.grossReceivedCents)}</td>
                    <td className="mono">{formatYuan(row.feeTotalCents)}</td>
                    <td className="mono">{formatYuan(row.refundTotalCents)}</td>
                    <td className={`mono${row.netRetainedCents < 0 ? " is-negative" : ""}`}>
                      {formatYuan(row.netRetainedCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint">
          订单金额是合同金额，实际到账是真金；两列不相等是正常的，不代表哪一边错了。
        </p>
      </section>

      <details className="finance-basis">
        <summary>统计口径</summary>
        <ul>
          {report.basis.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

const METHOD_LABEL: Record<string, string> = {
  wechat: "微信",
  alipay: "支付宝",
  bank: "银行卡",
  cash: "现金",
  other: "其他",
};

function MonthBars({ months }: { months: MonthCashFlow[] }) {
  const max = Math.max(
    1,
    ...months.map((m) => Math.max(m.grossReceivedCents, m.feeTotalCents, m.refundTotalCents)),
  );
  return (
    <ul className="finance-month-list">
      {months.map((month) => (
        <li key={month.month}>
          <span className="finance-month-label mono">{month.month}</span>
          <span className="finance-month-bars">
            <span className="finance-bar gross" style={{ width: `${pct(month.grossReceivedCents, max)}%` }} />
            <span className="finance-bar fee" style={{ width: `${pct(month.feeTotalCents, max)}%` }} />
            <span className="finance-bar refund" style={{ width: `${pct(month.refundTotalCents, max)}%` }} />
          </span>
          <span
            className={`finance-month-value mono${month.netRetainedCents < 0 ? " is-negative" : ""}`}
            title={`${month.month} 到账 ${formatYuan(month.grossReceivedCents)} · 手续费 ${formatYuan(
              month.feeTotalCents,
            )} · 退款 ${formatYuan(month.refundTotalCents)} · 净留存 ${formatYuan(month.netRetainedCents)}`}
          >
            净留存 {formatYuan(month.netRetainedCents)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function GroupList({
  rows,
}: {
  rows: Array<{ key: string; label: string; count: number; gross: number; fee: number; net: number }>;
}) {
  const max = Math.max(1, ...rows.map((row) => row.gross));
  return (
    <ul className="finance-group-list">
      {rows.map((row) => (
        <li key={row.key}>
          <span className="finance-group-label">{row.label}</span>
          <span className="finance-group-bar">
            <span
              style={{ width: `${pct(row.gross, max)}%` }}
              title={`${row.label}：${row.count} 笔 · 到账 ${formatYuan(row.gross)} · 手续费 ${formatYuan(
                row.fee,
              )} · 净到账 ${formatYuan(row.net)}`}
            />
          </span>
          <span className="finance-group-value mono">
            {formatYuan(row.gross)}
            <span className="muted"> · {row.count} 笔</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function pct(value: number, max: number): number {
  return Math.max(value > 0 ? 2 : 0, Math.round((value / max) * 100));
}
