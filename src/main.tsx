import { createRoot } from "react-dom/client";
import { createHashRouter, RouterProvider } from "react-router-dom";

import App from "./App";
import CalendarPage from "./pages/CalendarPage";
import ClientsPage from "./pages/ClientsPage";
import DashboardPage from "./pages/DashboardPage";
import OrdersPage from "./pages/OrdersPage";
import StatsPage from "./pages/StatsPage";
import TemplatesPage from "./pages/TemplatesPage";
import SettingsPage from "./pages/SettingsPage";
import StatusPage from "./pages/StatusPage";
import "./styles.css";

const router = createHashRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: "status", element: <StatusPage /> },
      { path: "stats", element: <StatsPage /> },
      { path: "orders", element: <OrdersPage /> },
      { path: "calendar", element: <CalendarPage /> },
      { path: "clients", element: <ClientsPage /> },
      { path: "templates", element: <TemplatesPage /> },
      { path: "settings", element: <SettingsPage /> },
    ],
  },
]);

createRoot(document.getElementById("root") as HTMLElement).render(
  <RouterProvider router={router} />,
);
