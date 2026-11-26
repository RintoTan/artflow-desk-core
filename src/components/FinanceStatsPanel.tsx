import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

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

type Props = {
  /** 区间由页面头部统一控制，面板只负责按这个区间取数和展示。 */
  range: string;
  /** 取到数据后把实际月份窗口交给页面头部显示，避免页头自己再算一遍。 */
  onPeriodChange?: (period: { from: string; to: string }) => void;
};

export default function FinanceStatsPanel({ range, onPeriodChange }: Props) {
  const [report, setReport] = useState<FinanceStatsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 快速切范围时，旧请求回来不许覆盖新结果。
  const token = useRef(0);
  // 加载失败后重试用：区间没变也要重新取一次。
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    const mine = ++token.current;
    setLoading(true);
    void financeStatsApi
      .report(range)
      .then((next) => {
        if (mine !== token.current) return;
        setReport(next);
        setError(null);
        onPeriodChange?.({ from: next.fromMonth, to: next.toMonth });
      })
      .catch((cause) => {
        if (mine !== token.current) return;
        // 保留上一次可用数据，只提示失败。
        setError(describeError(cause));
      })
      .finally(() => {
        if (mine === token.current) setLoading(false);
      });
  }, [range, retryTick, onPeriodChange]);

  if (!report && loading) {
    return (
      <div className="finance-stats">
        <p className="muted">正在统计财务数据…</p>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="finance-stats">
        <p className="notice notice-error" role="alert">
          {error ?? "财务统计加载失败"}
        </p>
        <button type="button" className="btn btn-sm" onClick={() => setRetryTick((n) => n + 1)}>
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
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}

      {/* 一、财务概览：三个口径各成一块，谁也不许并进谁 */}
      <section className="finance-section" aria-labelledby="finance-overview-title">
        <header className="finance-section-head">
          <h2 id="finance-overview-title">财务概览</h2>
          <p>
            三个口径互相独立：累计是历史总量，区间是当前所选范围，当前状态是此刻的欠款快照。
            既不合并，也不互相换算。
          </p>
        </header>

        <div className="finance-card">
          <header className="finance-card-head">
            <h3>累计（全部历史）</h3>
            <span className="finance-card-tag">不随上方区间变化</span>
          </header>
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
          <p className="finance-note">
            净到账是扣掉平台手续费后的到账，不是利润——系统没有成本与税费数据。净留存再扣除实际退款。
          </p>
        </div>

        <div className="finance-card">
          <header className="finance-card-head">
            <h3>所选区间合计</h3>
            <span className="finance-card-tag">
              {report.fromMonth} ~ {report.toMonth}
            </span>
          </header>
          <dl className="finance-figures">
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
          <p className="finance-note">
            只统计落在所选区间内的流水。它与上方的「累计（全部历史）」范围不同，两者不能相减，也不能互相替代。
          </p>
        </div>

        <div className="finance-card">
          <header className="finance-card-head">
            <h3>当前状态</h3>
            <span className="finance-card-tag">此刻快照，不随区间变化</span>
          </header>
          <dl className="finance-figures">
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
            <p className="finance-note">
              未记录收款信息不代表客户没有付款，只代表系统里还没有这些订单的收款记录。
            </p>
          )}
          {current.planMismatchOrders > 0 && (
            <p className="finance-note">
              付款计划合计与订单金额不一致的订单，需要到订单详情里重新调整计划。
            </p>
          )}
        </div>
      </section>

      {/* 二、趋势与预测 */}
      <section className="finance-section" aria-labelledby="finance-trend-title">
        <header className="finance-section-head">
          <h2 id="finance-trend-title">趋势与预测</h2>
          <p>已发生 vs 预计发生。没有流水的区间只占一行高度，不预留给空图。</p>
        </header>

        <div className="finance-pair">
          <div className="finance-card">
            <header className="finance-card-head">
              <h3>月度现金流</h3>
              <span className="finance-card-tag">按月归集</span>
            </header>
            {monthly.length === 0 ? (
              <p className="finance-empty">
                {noMoney ? "当前没有已记录的收款流水。" : "所选区间内没有收款或退款记录。"}
              </p>
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
            <p className="finance-note">
              到账与手续费按收款日归月，退款按退款日归月；同一笔收款的手续费跟随它所在的月份。
            </p>
          </div>

          <div className="finance-card">
            <header className="finance-card-head">
              <h3>年度净到账</h3>
              <span className="finance-card-tag">按年</span>
            </header>
            {annual.length === 0 ? (
              <p className="finance-empty">还没有可用于统计的年度收款</p>
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
            <p className="finance-note">
              按实际收款日期归年；退款不计入这张图，见上方的月度现金流。
            </p>
          </div>
        </div>

        <div className="finance-card">
          <header className="finance-card-head">
            <h3>预计收款</h3>
            <span className="finance-card-tag">当前月 + 后续 5 个月</span>
          </header>
          <p className="finance-card-hint">只统计你已经建立的付款计划，不按截稿日期推算。</p>
          <dl className="finance-figures">
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
            <p className="finance-empty">
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
        </div>
      </section>

      {/* 三、分类统计 */}
      <section className="finance-section" aria-labelledby="finance-group-title">
        <header className="finance-section-head">
          <h2 id="finance-group-title">分类统计</h2>
          <p>同一区间，按不同维度拆分。文字列吃掉剩余宽度，金额列才不会摊成一片空档。</p>
        </header>

        <div className="finance-pair">
          <div className="finance-card">
            <header className="finance-card-head">
              <h3>按接单平台</h3>
              <span className="finance-card-tag">按收款时快照</span>
            </header>
            {report.byPlatform.length === 0 ? (
              <p className="finance-empty">所选区间内没有收款流水。</p>
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
            <p className="finance-note">
              按收款当时记录的平台名称归类；平台改名或删除后，历史仍归原来的名字。
            </p>
          </div>

          <div className="finance-card">
            <header className="finance-card-head">
              <h3>按付款方式</h3>
              <span className="finance-card-tag">按收款时记录</span>
            </header>
            {report.byMethod.length === 0 ? (
              <p className="finance-empty">所选区间内没有收款流水。</p>
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
            <p className="finance-note">付款方式是收款流水上的字段，不以平台反推。</p>
          </div>
        </div>

        <div className="finance-card">
          <header className="finance-card-head">
            <h3>按委托类型</h3>
            <span className="finance-card-tag">所选区间</span>
          </header>
          {report.byOrderType.length === 0 ? (
            <p className="finance-empty">没有可用于统计的有效订单金额。</p>
          ) : (
            <div className="finance-table-wrap">
              <table className="finance-table is-wide">
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
                      <td className="mono has-note">
                        {row.orders}
                        {row.unknownAmountOrders > 0 && (
                          <span className="muted cell-note">（{row.unknownAmountOrders} 单金额未知）</span>
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
          <p className="finance-note">
            订单金额是合同金额，实际到账是真金；两列不相等是正常的，不代表哪一边错了。
          </p>
        </div>

        <div className="finance-card">
          <header className="finance-card-head">
            <h3>按客户（累计）</h3>
            <span className="finance-card-tag">累计口径，不随区间变化</span>
          </header>
          <p className="finance-card-hint">
            客户按稳定身份归类，同名客户不会合并；这里是累计口径，不随上面的日期范围变化。
          </p>
          {report.byClient.length === 0 ? (
            <p className="finance-empty">还没有可统计的客户</p>
          ) : (
            <div className="finance-table-wrap">
              <table className="finance-table">
                <thead>
                  <tr>
                    <th scope="col">客户</th>
                    <th scope="col">订单</th>
                    <th scope="col">累计委托金额</th>
                    <th scope="col">实际到账</th>
                    <th scope="col">待收款</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byClient.map((row) => (
                    <tr key={row.clientId}>
                      <th scope="row">
                        <Link to={`/clients?client=${row.clientId}`}>{row.displayName}</Link>
                      </th>
                      <td className="mono has-note">
                        {row.orders}
                        {row.unrecordedOrders > 0 && (
                          <span className="muted cell-note">（{row.unrecordedOrders} 单未记录收款信息）</span>
                        )}
                      </td>
                      <td className="mono">{formatYuan(row.orderAmountCents)}</td>
                      <td className="mono">{formatYuan(row.grossReceivedCents)}</td>
                      <td className="mono">{formatYuan(row.remainingCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="finance-note">
            订单列括号里的数字是「既没有付款计划、也没有收款流水」的订单数，它不能直接计入待收款。
          </p>
        </div>
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
