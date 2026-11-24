import { useEffect, useState } from "react";

import { describeError, financeStatsApi, type ClientFinance } from "../bridge/commands";
import { formatYuan } from "../lib/money";

/**
 * 客户财务概览。
 *
 * 三个主指标（委托金额 / 实际到账 / 待收）必须分开看：
 * 合同金额不是收入，没记录收款也不等于客户没付钱。
 * 数据来自与统计页同一份聚合，两边不会出现两个数。
 */
export default function ClientFinancePanel({ clientId }: { clientId: string }) {
  const [data, setData] = useState<ClientFinance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    void financeStatsApi
      .clientSummary(clientId)
      .then((next) => {
        if (live) setData(next);
      })
      .catch((cause) => {
        // 财务读失败不影响客户资料、标签与订单分组。
        if (live) setError(describeError(cause));
      });
    return () => {
      live = false;
    };
  }, [clientId, tick]);

  return (
    <section className="panel">
      <header className="panel-head compact">
        <h2>财务概览</h2>
        {data && <span className="muted">累计</span>}
      </header>
      {error ? (
        <>
          <p className="notice notice-error" role="alert">
            {error}
          </p>
          <button type="button" className="btn btn-sm" onClick={() => setTick((v) => v + 1)}>
            重试
          </button>
        </>
      ) : !data ? (
        <p className="muted">正在读取财务信息…</p>
      ) : (
        <>
          <dl className="stat-row">
            <div>
              <dt>累计委托金额</dt>
              <dd>{formatYuan(data.orderAmountCents)}</dd>
              <p className="muted">合同金额，不等于已收到的钱</p>
            </div>
            <div>
              <dt>实际到账</dt>
              <dd>{formatYuan(data.grossReceivedCents)}</dd>
              <p className="muted">扣手续费前</p>
            </div>
            <div>
              <dt>待收款</dt>
              <dd>{formatYuan(data.remainingCents)}</dd>
              <p className="muted">逐单计算后汇总</p>
            </div>
          </dl>
          <dl className="stat-row is-secondary">
            <div>
              <dt>平台手续费</dt>
              <dd>{formatYuan(data.feeTotalCents)}</dd>
            </div>
            <div>
              <dt>净到账</dt>
              <dd>{formatYuan(data.netReceivedCents)}</dd>
            </div>
            <div>
              <dt>实际退款</dt>
              <dd>{formatYuan(data.refundTotalCents)}</dd>
            </div>
            <div>
              <dt>净留存</dt>
              <dd className={data.netRetainedCents < 0 ? "is-negative" : undefined}>
                {formatYuan(data.netRetainedCents)}
              </dd>
            </div>
            {data.overReceivedCents > 0 && (
              <div>
                <dt>超额收款</dt>
                <dd>{formatYuan(data.overReceivedCents)}</dd>
              </div>
            )}
          </dl>
          {(data.unrecordedOrders > 0 || data.unknownAmountOrders > 0) && (
            <p className="muted stat-note">
              {data.unrecordedOrders > 0 && `${data.unrecordedOrders} 单未记录收款信息（不代表客户没付款）`}
              {data.unrecordedOrders > 0 && data.unknownAmountOrders > 0 && " · "}
              {data.unknownAmountOrders > 0 && `${data.unknownAmountOrders} 单金额未知`}
            </p>
          )}
        </>
      )}
    </section>
  );
}
