import { useEffect, useState } from "react";
import { api, describeError, type EnvironmentStatus } from "../bridge/commands";

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      <span className="row-value" title={hint ?? value}>
        {value}
      </span>
    </div>
  );
}

export default function StatusPage() {
  const [status, setStatus] = useState<EnvironmentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .status()
      .then(setStatus)
      .catch((e) => setError(describeError(e)));
  }, []);

  if (error) {
    return (
      <section className="panel panel-error">
        <h2>无法读取数据环境</h2>
        <p className="mono">{error}</p>
        <p className="muted">
          应用已停止写入。请检查数据目录是否存在、是否被其他进程占用，或从备份恢复。
        </p>
      </section>
    );
  }

  if (!status) {
    return <section className="panel">正在读取数据环境…</section>;
  }

  return (
    <>
      <section className="panel">
        <header className="panel-head">
          <div>
            <h2>数据环境</h2>
            <p className="muted">
              {status.firstRun
                ? "本次是首次启动，已初始化正式数据库。"
                : "已连接到既有数据环境。"}
            </p>
          </div>
          <span className={`badge ${status.integrity === "ok" ? "badge-ok" : "badge-warn"}`}>
            完整性 {status.integrity === "ok" ? "正常" : status.integrity}
          </span>
        </header>

        <div className="grid">
          <Row
            label="运行模式"
            value={
              status.qaMode
                ? `ArtFlow Desk Core — QA 测试环境 · ${status.qaScenario === "clean" ? "空白场景" : "预置场景"}（与正式数据隔离）`
                : "正式应用"
            }
          />
          <Row label="应用版本" value={status.appVersion} />
          <Row label="数据库结构" value={`v${status.schemaVersion}`} />
          <Row label="数据代际" value={status.generation} hint={status.generation} />
          <Row label="SQLite" value={status.sqliteVersion} />
          <Row label="日志模式" value={status.journalMode} />
          <Row label="写入锁" value={status.lockHeld ? "本进程持有" : "未持有"} />
          <Row label="工作时区" value={status.workingTimezone} />
          <Row label="系统时区" value={status.systemTimezone} />
        </div>

        <div className="path-block">
          <span className="row-label">数据目录</span>
          <code>{status.rootPath}</code>
        </div>
      </section>

      <section className="panel">
        <header className="panel-head">
          <h2>当前数据</h2>
          <p className="muted">只统计真实存在的记录，不包含任何演示数据。</p>
        </header>
        <div className="stat-row stat-row-metrics">
          {[
            { label: "订单", value: status.orders },
            { label: "客户", value: status.clients },
            { label: "流程模板", value: status.templates },
            { label: "附件", value: status.attachments },
            { label: "待清理", value: status.pendingCleanup },
          ].map((item) => (
            <div className="stat" key={item.label}>
              <span className="stat-value">{item.value}</span>
              <span className="stat-label">{item.label}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <header className="panel-head">
          <h2>编号高水位</h2>
          <p className="muted">
            年度编号记录独立存放，恢复旧备份不会降低；编号与队列位置无关。
          </p>
        </header>
        {status.highWater.length === 0 ? (
          <p className="muted">尚无已分配的订单编号。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>年份</th>
                <th>已保留的最大序号</th>
                <th>下一编号</th>
              </tr>
            </thead>
            <tbody>
              {status.highWater.map((item) => (
                <tr key={item.year}>
                  <td>{item.year}</td>
                  <td className="mono">{item.lastAllocated}</td>
                  <td className="mono">
                    AF-{item.year}-{String(item.lastAllocated + 1).padStart(4, "0")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
