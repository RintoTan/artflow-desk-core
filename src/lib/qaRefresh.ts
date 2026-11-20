import { createContext, useContext } from "react";

/**
 * 重新读取 QA 横幅数据（订单数 / 客户数 / 模板数）。
 *
 * 只服务顶部那条 QA 横幅：它在 App 启动时读一次，删除或恢复后就会过期。
 * 默认值是空函数，所以页面在测试或非 QA 环境里单独渲染时不需要额外包裹。
 *
 * 刻意**不做**成全局数据刷新：各页面的列表本来就随路由挂载重新读取。
 */
export const QaRefreshContext = createContext<() => void>(() => {});

export function useQaRefresh(): () => void {
  return useContext(QaRefreshContext);
}
