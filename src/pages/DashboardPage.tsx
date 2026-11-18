import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { describeError, statsApi, type DashboardMetrics } from "../bridge/commands";
import { ProjectTimeline } from "../components/ProjectTimeline";

type Card = {
  key: string;
  label: string;
  hint: string;
  to: string;
  value: (m: DashboardMetrics) => number;
  tone?: "danger" | "warn" | "accent";
};

const CARDS: Card[] = [
  {
    key: "active",
    label: "活动订单",
    hint: "当前仍在进行中的全部委托",
    to: "/orders?status=active",
    value: (m) => m.activeTotal,
  },
  {
    key: "queued",
    label: "排队中",
    hint: "活动但尚未开始制作",
    to: "/orders?status=active&work=queued",
    value: (m) => m.queued,
  },
  {
    key: "inProgress",
    label: "制作中",
    hint: "已经在制作",
    to: "/orders?status=active&work=inProgress",
    value: (m) => m.inProgress,
    tone: "accent",
  },
  {
    key: "dueSoon",
    label: "三日内到期",
    hint: "明天至第三天（不含今天）",
    to: "/orders?status=active&risk=dueSoon",
    value: (m) => m.dueSoon,
    tone: "warn",
  },
  {
    key: "today",
    label: "今天到期",
    hint: "交付日期就是今天",
    to: "/orders?status=active&risk=today",
    value: (m) => m.dueToday,
    tone: "warn",
  },
  {
    key: "overdue",
    label: "已逾期",
    hint: "交付日期早于今天",
    to: "/orders?status=active&risk=overdue",
    value: (m) => m.overdue,
    tone: "danger",
  },
  {
    key: "unscheduled",
    label: "未排期",
    hint: "还没有填预计交付日期",
    to: "/orders?status=active&risk=unscheduled",
    value: (m) => m.unscheduled,
  },
  {
    key: "completedThisMonth",
    label: "本月完成次数",
    hint: "按完成事件计数，同一订单再次完成会再计一次",
    to: "/stats?range=thisMonth&focus=completed",
    value: (m) => m.completedThisMonth,
    tone: "accent",
  },
];

export default function DashboardPage() {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    statsApi
      .dashboard()
      .then((value) => {
        if (alive) setMetrics(value);
      })
      .catch((e) => {
        if (alive) setError(describeError(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (loading) return <section className="panel">正在读取工作台…</section>;
  if (error) {
    return (
      <section className="panel panel-error">
        <h2>无法读取工作台</h2>
        <p className="mono">{error}</p>
      </section>
    );
  }
  if (!metrics) return null;

  const attention = metrics.overdue + metrics.dueToday + metrics.dueSoon;

  return (
    <>
      <section className="panel">
        <header className="panel-head">
          <div>
            <h2>工作台</h2>
            <p className="muted">
              今天是 {metrics.today}（{metrics.timezone}）· 本月 {metrics.month}
            </p>
          </div>
          <span className={`badge ${attention > 0 ? "badge-warn" : "badge-ok"}`}>
            {attention > 0 ? `${attention} 项需要关注` : "没有临期订单"}
          </span>
        </header>

        <div className="metric-grid">
          {CARDS.map((card) => (
            <Link key={card.key} to={card.to} className={`metric-card tone-${card.tone ?? "plain"}`}>
              <span className="metric-value">{card.value(metrics)}</span>
              <span className="metric-label">{card.label}</span>
              <span className="metric-hint">{card.hint}</span>
            </Link>
          ))}
        </div>
      </section>

      <ProjectTimeline />

      <section className="panel panel-quiet">
        <h2>提醒说明</h2>
        <p className="muted">
          到期提醒只影响这里的计数与订单列表里的状态标记，<strong>不会自动调整活动队列顺序</strong>。
          队列顺序始终由你手动决定。
        </p>
        <p className="muted">
          已完成与已取消的订单不进入到期提醒；日期一律按应用内的工作时时区判定。
        </p>
      </section>
    </>
  );
}
