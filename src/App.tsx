import { NavLink, Outlet } from "react-router-dom";

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
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <strong>ArtFlow miniDesk</strong>
            <small>本地委托台账</small>
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
        <Outlet />
      </main>
    </div>
  );
}
