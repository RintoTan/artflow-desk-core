import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useSearchParams } from "react-router-dom";
import { save } from "@tauri-apps/plugin-dialog";

import { placeTooltip, type TooltipPlacement } from "../components/TitleTooltip";
import { axisMaxOf, axisTicks, barPercent, compactCount, labelsEveryBar } from "../lib/chart";
import { useElementWidth } from "../lib/useElementWidth";
import {
  describeError,
  statsApi,
  type CompletedEventRow,
  type MonthBucket,
  type StatsRangeKey,
  type StatsReport,
} from "../bridge/commands";

/** 单排容纳 12 个月所需的最小内容宽度：12×42 + 11×10 + 8 ≈ 622，留点余量取 640。 */
const SINGLE_ROW_MIN_WIDTH = 640;
/** 两排时每排的月份数。 */
const MONTHS_PER_ROW = 6;
/** 列宽小于这个值时，只标每列最大值，免得数字比柱子还宽。 */
const EVERY_BAR_MIN_COLUMN = 56;

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

function ChartAxis({ ticks, axisMax }: { ticks: number[]; axisMax: number }) {
  return (
    <div className="chart-axis" aria-hidden="true">
      {ticks.map((tick) => (
        <span
          key={tick}
          className="chart-tick"
          style={{ bottom: `${barPercent(tick, axisMax)}%` }}
        >
          {compactCount(tick)}
        </span>
      ))}
    </div>
  );
}

const SERIES: { key: "created" | "completed" | "cancelled"; label: string; of: (m: MonthBucket) => number }[] = [
  { key: "created", label: "新建", of: (m) => m.created },
  { key: "completed", label: "完成", of: (m) => m.completed },
  { key: "cancelled", label: "取消", of: (m) => m.cancelled },
];

const RANGES: { key: StatsRangeKey; label: string }[] = [
  { key: "thisMonth", label: "本月" },
  { key: "last6", label: "近 6 个月" },
  { key: "last12", label: "近 12 个月" },
  { key: "all", label: "全部" },
];

function yuan(cents: number): string {
  return `¥ ${(cents / 100).toFixed(2)}`;
}

export default function StatsPage() {
  const [params, setParams] = useSearchParams();
  const range = (params.get("range") as StatsRangeKey | null) ?? "thisMonth";
  const focus = params.get("focus");

  const [report, setReport] = useState<StatsReport | null>(null);
  const [events, setEvents] = useState<CompletedEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 图表数值气泡：portal + fixed，不会被横向滚动容器裁切
  const [tip, setTip] = useState<{ bucket: MonthBucket } | null>(null);
  const [tipPos, setTipPos] = useState<{ top: number; left: number; placement: TooltipPlacement } | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const tipAnchor = useRef<HTMLElement | null>(null);
  // 按图表自己的内容宽度决定单排还是两排，不看窗口宽度
  const [attachFrame, frameWidth] = useElementWidth<HTMLDivElement>();

  const showTip = useCallback((bucket: MonthBucket, el: HTMLElement) => {
    tipAnchor.current = el;
    setTip({ bucket });
  }, []);

  const hideTip = useCallback(() => {
    setTip(null);
    setTipPos(null);
  }, []);

  useEffect(() => {
    if (!tip) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") hideTip();
    };
    const onScroll = () => hideTip();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [tip, hideTip]);

  useLayoutEffect(() => {
    if (!tip) return;
    const anchor = tipAnchor.current;
    const node = tipRef.current;
    if (!anchor || !node) return;
    const a = anchor.getBoundingClientRect();
    const t = node.getBoundingClientRect();
    const next = placeTooltip(
      { x: a.x, y: a.y, w: a.width, h: a.height },
      { w: t.width, h: t.height },
      { width: window.innerWidth, height: window.innerHeight },
      "top",
    );
    setTipPos((current) =>
      current && current.top === next.top && current.left === next.left ? current : next,
    );
  }, [tip]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const value = await statsApi.report(range);
        if (alive) setReport(value);
        if (focus === "completed") {
          const rows = await statsApi.completedEvents(value.toMonth);
          if (alive) setEvents(rows);
        }
      } catch (e) {
        if (alive) setError(describeError(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [range, focus]);

  function switchRange(key: StatsRangeKey) {
    setNotice(null);
    setError(null);
    const next = new URLSearchParams(params);
    next.set("range", key);
    if (key !== "thisMonth") next.delete("focus");
    setParams(next, { replace: true });
  }

  async function exportSummary() {
    setError(null);
    setNotice(null);
    try {
      const path = await save({
        title: "导出统计汇总 CSV",
        defaultPath: `artflow-统计汇总-${range}.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      // 用户取消：不创建文件、不提示成功
      if (!path) return;

      setBusy(true);
      const result = await statsApi.exportSummary({ path, range });
      setNotice(`已导出 ${result.rows} 行到 ${result.path}`);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <section className="panel">正在统计…</section>;
  if (error && !report) {
    return (
      <section className="panel panel-error">
        <h2>统计失败</h2>
        <p className="mono">{error}</p>
      </section>
    );
  }
  if (!report) return null;

  const peak = Math.max(0, ...report.months.map((m) => Math.max(m.created, m.completed, m.cancelled)));
  const ticks = axisTicks(peak);
  const axisMax = axisMaxOf(ticks);
  // 宽度未知（首帧 / 非浏览器环境）时按单排处理：桌面端是常态
  const mode: "single" | "split" =
    frameWidth > 0 && frameWidth < SINGLE_ROW_MIN_WIDTH ? "split" : "single";
  const perRow = mode === "single" ? report.months.length : Math.min(MONTHS_PER_ROW, report.months.length);
  const columnWidth = frameWidth > 0 ? (frameWidth - 46) / Math.max(1, perRow) : Number.POSITIVE_INFINITY;
  // 两排时每排只有 6 个月，但仍要列够宽才逐柱标数字
  const everyBar = labelsEveryBar(perRow) && columnWidth >= EVERY_BAR_MIN_COLUMN;

  return (
    <>
      <section className="panel stats-overview">
        <header className="stats-toolbar">
          <div className="stats-heading">
            <h1 className="page-title">数据统计</h1>
            <p className="muted">
              {report.fromMonth} ~ {report.toMonth} · {report.timezone} · 按自然月 ·
              完成与取消按事件时间计入
            </p>
          </div>
          <div className="stats-tools">
            <div className="segmented" role="group" aria-label="统计范围">
              {RANGES.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`filter-chip${range === item.key ? " filter-chip-active" : ""}`}
                  aria-pressed={range === item.key}
                  onClick={() => switchRange(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void exportSummary()}
              disabled={busy}
            >
              导出汇总 CSV
            </button>
          </div>
        </header>

        {error && <p className="notice notice-error">{error}</p>}
        {notice && <p className="notice notice-ok">{notice}</p>}

        <div className="kpi-grid">
          <div className="metric-card tone-plain">
            <span className="metric-value">{report.totals.created}</span>
            <span className="metric-label">新建次数</span>
          </div>
          <div className="metric-card tone-plain">
            <span className="metric-value">{report.totals.completed}</span>
            <span className="metric-label">完成次数</span>
          </div>
          <div className="metric-card tone-plain">
            <span className="metric-value">{report.totals.cancelled}</span>
            <span className="metric-label">取消次数</span>
          </div>
          <div className="metric-card tone-plain">
            <span className="metric-value">{yuan(report.totals.amountCents)}</span>
            <span className="metric-label">已知金额合计</span>
          </div>
          <div className="metric-card tone-plain">
            <span className="metric-value">{report.totals.knownOrders}</span>
            <span className="metric-label">已知金额订单</span>
          </div>
          <div className={`metric-card ${report.totals.unknownOrders > 0 ? "tone-warn" : "tone-plain"}`}>
            <span className="metric-value">{report.totals.unknownOrders}</span>
            <span className="metric-label">未知金额订单</span>
          </div>
        </div>
        {report.totals.unknownOrders > 0 && (
          <p className="muted">
            有 {report.totals.unknownOrders} 张订单没有填写金额，它们<strong>不计入</strong>金额合计，
            也没有被当成 0 元。
          </p>
        )}
      </section>

      <section className="panel">
        <header className="panel-head compact">
          <h2>月度趋势</h2>
          <span className="muted">柱高表示次数，单位：次</span>
        </header>

        {report.months.every((m) => m.created + m.completed + m.cancelled === 0) ? (
          <p className="muted">这个区间内还没有任何事件。</p>
        ) : (
          <>
            <div
              className="chart-frame"
              ref={attachFrame}
              data-mode={mode}
              data-single={report.months.length === 1 ? "true" : "false"}
            >
              {(mode === "single" ? [report.months] : chunk(report.months, MONTHS_PER_ROW)).map(
                (rowMonths, rowIndex) => (
                  <div className="chart-row" key={rowIndex}>
                    <ChartAxis ticks={ticks} axisMax={axisMax} />
                    <div className="chart-scroll">
                    <div className="chart" role="group" aria-label={`每月新建、完成、取消次数，第 ${rowIndex + 1} 段`}>
                      <div className="chart-grid" aria-hidden="true">
                        {ticks.map((tick) => (
                          <span
                            key={tick}
                            className="chart-grid-line"
                            style={{ bottom: `${barPercent(tick, axisMax)}%` }}
                          />
                        ))}
                      </div>
                      {rowMonths.map((bucket) => {
                        const columnPeak = Math.max(bucket.created, bucket.completed, bucket.cancelled);
                        const active = tip?.bucket.month === bucket.month;
                        return (
                          <div
                            key={bucket.month}
                            className={`chart-col${active ? " chart-col-active" : ""}`}
                            tabIndex={0}
                            aria-label={`${bucket.month}：新建 ${bucket.created}、完成 ${bucket.completed}、取消 ${bucket.cancelled}`}
                            onPointerEnter={(event) => showTip(bucket, event.currentTarget)}
                            onPointerLeave={hideTip}
                            onFocus={(event) => showTip(bucket, event.currentTarget)}
                            onBlur={hideTip}
                          >
                            <div className="chart-bars">
                              {SERIES.map((series) => {
                                const value = series.of(bucket);
                                const showLabel = value > 0 && (everyBar || value === columnPeak);
                                return (
                                  <span className="bar-slot" key={series.key}>
                                    {showLabel && (
                                      <span
                                        className="bar-value"
                                        style={{ bottom: `calc(${barPercent(value, axisMax)}% + 3px)` }}
                                      >
                                        {compactCount(value)}
                                      </span>
                                    )}
                                    <span
                                      className={value === 0 ? "bar bar-zero" : `bar bar-${series.key}`}
                                      style={value === 0 ? undefined : { height: `${barPercent(value, axisMax)}%` }}
                                    />
                                  </span>
                                );
                              })}
                            </div>
                            <span className="chart-label">{bucket.month.slice(2)}</span>
                          </div>
                        );
                      })}
                    </div>
                    </div>
                  </div>
                ),
              )}
            </div>
            <div className="chart-legend">
              <span><i className="swatch bar-created" /> 新建</span>
              <span><i className="swatch bar-completed" /> 完成</span>
              <span><i className="swatch bar-cancelled" /> 取消</span>
            </div>
            {tip &&
              createPortal(
                <div
                  ref={tipRef}
                  className="chart-tooltip"
                  role="tooltip"
                  data-placement={tipPos?.placement ?? "top"}
                  style={tipPos ? { top: `${tipPos.top}px`, left: `${tipPos.left}px` } : { top: 0, left: 0, visibility: "hidden" }}
                >
                  <span className="chart-tooltip-title">{tip.bucket.month}</span>
                  {SERIES.map((series) => (
                    <span className="chart-tooltip-row" key={series.key}>
                      <i className={`swatch bar-${series.key}`} />
                      {series.label}
                      <b>{series.of(tip.bucket)}</b>
                    </span>
                  ))}
                </div>,
                document.body,
              )}
          </>
        )}
      </section>

      <section className="panel">
        <header className="panel-head compact">
          <h2>月度明细</h2>
          <span className="muted">{report.months.length} 个月</span>
        </header>
        <table className="table">
          <thead>
            <tr>
              <th>月份</th>
              <th>新建</th>
              <th>完成</th>
              <th>取消</th>
              <th>已知金额</th>
              <th>已知订单</th>
              <th>未知订单</th>
            </tr>
          </thead>
          <tbody>
            {report.months.map((bucket: MonthBucket) => (
              <tr key={bucket.month}>
                <td className="mono">{bucket.month}</td>
                <td className="num">{bucket.created}</td>
                <td className="num">{bucket.completed}</td>
                <td className="num">{bucket.cancelled}</td>
                <td className="num">{yuan(bucket.amountCents)}</td>
                <td className="num">{bucket.knownOrders}</td>
                <td className="num">{bucket.unknownOrders}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">
          金额按订单创建月份归属、取当前记录金额；修改金额会影响该月份的汇总。
        </p>
      </section>

      {focus === "completed" && (
        <section className="panel">
          <header className="panel-head compact">
            <h2>本月完成事件</h2>
            <span className="muted">{events.length} 条</span>
          </header>
          {events.length === 0 ? (
            <p className="muted">本月还没有完成事件。</p>
          ) : (
            <ul className="timeline">
              {events.map((event) => (
                <li key={event.eventId}>
                  <span className="timeline-kind mono">{event.localTime}</span>
                  <span className="timeline-detail">
                    <code className="order-code">{event.code}</code> {event.title}
                    {event.stageTitle ? ` · ${event.stageTitle}` : ""}
                  </span>
                  <Link className="link-btn" to={`/orders?orderId=${event.orderId}`}>
                    查看订单
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
