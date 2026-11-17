import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";

import { api } from "./bridge/commands";

const NAV = [
  { to: "/", label: "工作台", end: true },
  { to: "/orders", label: "订单" },
  { to: "/clients", label: "客户" },
  { to: "/templates", label: "流程模板" },
  { to: "/stats", label: "历史统计" },
  { to: "/settings", label: "设置" },
  { to: "/status", label: "数据环境" },
];

export default function App() {
  // QA 模式必须在界面上一眼可见：连不上后端时保持普通外观，不猜。
  const [qaMode, setQaMode] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .status()
      .then((status) => {
        if (alive) setQaMode(Boolean(status.qaMode));
      })
      .catch(() => {
        /* 状态查询失败不影响外壳渲染 */
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <strong>ArtFlow miniDesk</strong>
            <small>{qaMode ? "QA 测试环境" : "本地委托台账"}</small>
          </div>
        </div>

        <nav aria-label="主导航">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => (isActive ? "nav-item nav-item-active" : "nav-item")}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <footer className="sidebar-foot">
          <span>DEV-01 数据基座</span>
          <span className="muted">未完成 v1.0</span>
        </footer>
      </aside>

      <main className="main">
        {qaMode && (
          <p className="qa-banner" role="status">
            QA 测试环境 · 数据目录与正式应用完全隔离，这里的订单不会出现在正式台账里
          </p>
        )}
        <Outlet />
      </main>
    </div>
  );
}
