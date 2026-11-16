import { createRoot } from "react-dom/client";
import { createHashRouter, RouterProvider } from "react-router-dom";

import App from "./App";
import OrdersPage from "./pages/OrdersPage";
import Placeholder from "./pages/Placeholder";
import SettingsPage from "./pages/SettingsPage";
import StatusPage from "./pages/StatusPage";
import "./styles.css";

const router = createHashRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <StatusPage /> },
      { path: "orders", element: <OrdersPage /> },
      {
        path: "clients",
        element: (
          <Placeholder
            title="客户"
            plan="DEV-03"
            items={["客户档案与关联订单历史", "客户改名反映到订单显示", "同名客户不自动合并"]}
          />
        ),
      },
      {
        path: "templates",
        element: (
          <Placeholder
            title="流程模板"
            plan="DEV-03"
            items={[
              "模板新建、复制、编辑、排序、删除",
              "每模板 1～20 个阶段且阶段名唯一",
              "唯一默认模板；删除默认模板前必须另选",
            ]}
          />
        ),
      },
      { path: "settings", element: <SettingsPage /> },
    ],
  },
]);

createRoot(document.getElementById("root") as HTMLElement).render(
  <RouterProvider router={router} />,
);
