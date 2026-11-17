import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { NavLink, Outlet } from "react-router-dom";

import { api, describeError } from "./bridge/commands";
import UnsavedChangesDialog from "./components/UnsavedChangesDialog";
import {
  currentIcon,
  iconAsset,
  loadIcon,
  subscribeIcon,
} from "./lib/appIcon";
import { subscribeModalStack, topModal } from "./lib/modalStack";
import {
  applyTheme,
  currentChoice,
  loadTheme,
  subscribeTheme,
  systemPrefersDark,
  watchSystemAppearance,
} from "./lib/theme";
import {
  activeGuard,
  dirtyGuards,
  guardLabel,
  useHasUnsavedDraft,
} from "./lib/unsavedRegistry";

type NavIconName =
  | "dashboard"
  | "orders"
  | "clients"
  | "templates"
  | "stats"
  | "settings"
  | "status";

type NavItem = {
  to: string;
  label: string;
  icon: NavIconName;
  end?: boolean;
};

const NAV: NavItem[] = [
  { to: "/", label: "工作台", icon: "dashboard", end: true },
  { to: "/orders", label: "订单", icon: "orders" },
  { to: "/clients", label: "客户", icon: "clients" },
  { to: "/templates", label: "流程模板", icon: "templates" },
  { to: "/stats", label: "历史统计", icon: "stats" },
  { to: "/settings", label: "设置", icon: "settings" },
  { to: "/status", label: "数据环境", icon: "status" },
];

/** 折叠后只剩图标，所以每个图标要能独立辨认，并配 title 提示。 */
const ICON_PATHS: Record<NavIconName, string> = {
  // 统一 Lucide 轮廓风格：24 网格、1.8 描边、圆角端点
  dashboard: "M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z",
  orders:
    "M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1zM8 6H6a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-2M9 11h6M9 15h6M9 19h4",
  clients:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  templates: "M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  stats: "M3 3v18h18M8 17V9M13 17V5M18 17v-6",
  settings:
    "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 15a7.9 7.9 0 0 0 .1-1 7.9 7.9 0 0 0-.1-1l2-1.6-2-3.4-2.4 1a8 8 0 0 0-1.7-1l-.4-2.6h-4l-.4 2.6a8 8 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a8 8 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a8 8 0 0 0 1.7 1l.4 2.6h4l.4-2.6a8 8 0 0 0 1.7-1l2.4 1 2-3.4z",
  status:
    "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6",
};

function NavIcon({ name }: { name: NavIconName }) {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d={ICON_PATHS[name]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type CloseKind = "window" | "quit";

type TauriBridge = {
  destroy: () => Promise<void>;
  exit: () => Promise<void>;
};

export default function App() {
  // QA 模式必须在界面上一眼可见：连不上后端时保持普通外观，不猜。
  const [qa, setQa] = useState<{ scenario: string | null } | null>(null);
  const [closeKind, setCloseKind] = useState<CloseKind | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [closeBusy, setCloseBusy] = useState(false);

  const hasDraft = useHasUnsavedDraft();
  const [themeTick, setThemeTick] = useState(0);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem("minidesk.sidebar") === "collapsed";
    } catch {
      return false;
    }
  });
  // 打开确认框时快照一次草稿名单，用于提示"有几处、分别是什么"。
  const [dirtyLabels, setDirtyLabels] = useState<string[]>([]);
  const closingRef = useRef(false);
  const closeInFlight = useRef(false);
  const pendingCloseRef = useRef<CloseKind | null>(null);
  const closeKindRef = useRef<CloseKind | null>(null);
  const bridgeRef = useRef<TauriBridge | null>(null);

  closeKindRef.current = closeKind;

  // 主题：启动读一次、跟随系统、预览/保存都会通过 subscribeTheme 触发重渲染。
  useEffect(() => {
    let alive = true;
    void loadTheme().then(() => {
      if (alive) setThemeTick((n) => n + 1);
    });
    const stopWatching = watchSystemAppearance();
    const unsubscribe = subscribeTheme(() => setThemeTick((n) => n + 1));
    return () => {
      alive = false;
      stopWatching();
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    applyTheme(document.documentElement, currentChoice(), systemPrefersDark());
  }, [themeTick]);

  // 应用图标：只有品牌图标跟着变，主题色与状态色不受影响。
  const iconVariant = useSyncExternalStore(subscribeIcon, currentIcon, currentIcon);
  useEffect(() => {
    void loadIcon();
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem("minidesk.sidebar", collapsed ? "collapsed" : "expanded");
    } catch {
      /* 存不了就只在本次会话生效 */
    }
  }, [collapsed]);

  useEffect(() => {
    let alive = true;
    api
      .status()
      .then((status) => {
        if (!alive) return;
        setQa(status.qaMode ? { scenario: status.qaScenario ?? null } : null);
      })
      .catch(() => {
        /* 状态查询失败不影响外壳渲染 */
      });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * 真正关闭：程序化关闭会绕过下面的拦截，所以先置 closingRef，
   * 保证"保存后关闭"不会再被自己的 onCloseRequested 拦一次（否则无限循环）。
   */
  const finishClose = useCallback(async (kind: CloseKind) => {
    const bridge = bridgeRef.current;
    closingRef.current = true;
    if (!bridge) return;
    if (kind === "quit") {
      await bridge.exit();
    } else {
      await bridge.destroy();
    }
  }, []);

  const openCloseDialog = useCallback(
    (kind: CloseKind) => {
      if (!activeGuard()) {
        void finishClose(kind);
        return;
      }
      setCloseError(null);
      setDirtyLabels(dirtyGuards().map((guard) => guardLabel(guard)));
      setCloseKind(kind);
    },
    [finishClose],
  );

  /**
   * 关窗请求的入口（红色按钮与 Cmd+Q 共用一个通道）。
   * - 已有其它模态打开时先记下来，等栈空了再问，避免同时出现两个保护弹窗；
   * - 已经在问的时候再次点击不做任何事（不重复保存、不重复关闭）。
   */
  const requestClose = useCallback(
    (kind: CloseKind) => {
      if (closingRef.current) return;
      if (closeKindRef.current !== null) return;
      if (topModal() !== null) {
        pendingCloseRef.current = kind;
        return;
      }
      openCloseDialog(kind);
    },
    [openCloseDialog],
  );

  // 其它模态关掉后，把排队中的关窗请求补上。
  useEffect(
    () =>
      subscribeModalStack(() => {
        const pending = pendingCloseRef.current;
        if (pending && topModal() === null) {
          pendingCloseRef.current = null;
          openCloseDialog(pending);
        }
      }),
    [openCloseDialog],
  );

  // 真实 Tauri 事件接线：只在 Tauri 里注册，浏览器预览下保持安静。
  useEffect(() => {
    let disposed = false;
    let unlistenClose: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;

    (async () => {
      const core = await import("@tauri-apps/api/core");
      if (!core.isTauri()) return;
      const [windowApi, eventApi] = await Promise.all([
        import("@tauri-apps/api/window"),
        import("@tauri-apps/api/event"),
      ]);
      if (disposed) return;

      const win = windowApi.getCurrentWindow();
      bridgeRef.current = {
        destroy: () => win.destroy(),
        exit: async () => {
          await core.invoke("confirm_close");
        },
      };

      unlistenClose = await win.onCloseRequested((event) => {
        if (closingRef.current) return;
        // 拦下系统关闭，再由界面决定close/discard。
        event.preventDefault();
        requestClose("window");
      });

      // Cmd+Q 走的是应用退出链路，不是窗口关闭：由 Rust 侧拦下后发这个事件。
      unlistenExit = await eventApi.listen("app://exit-requested", () => {
        if (closingRef.current) return;
        requestClose("quit");
      });
    })().catch(() => {
      /* 非 Tauri 环境：没有桥，也就没有关窗拦截 */
    });

    return () => {
      disposed = true;
      unlistenClose?.();
      unlistenExit?.();
    };
  }, [requestClose]);

  async function handleSaveAndClose() {
    const kind = closeKindRef.current;
    if (!kind) return;
    if (closeInFlight.current) return;
    closeInFlight.current = true;
    setCloseBusy(true);
    setCloseError(null);
    try {
      // 逐个保存全部草稿（内层优先）。契约：save() 返回 null 表示已落库，
      // 因此只有**每一份**都成功才允许关闭；任一份失败就停下，其余草稿继续受保护。
      for (const guard of dirtyGuards()) {
        // 上一份保存可能让这一份随组件一起卸载（例如新建面板创建后自动关闭）。
        if (!dirtyGuards().some((item) => item.id === guard.id)) continue;
        const error = await guard.save();
        if (error) {
          setCloseError(`${guardLabel(guard)}：${error}`);
          return;
        }
      }
      await finishClose(kind);
    } catch (e) {
      setCloseError(describeError(e));
    } finally {
      closeInFlight.current = false;
      setCloseBusy(false);
    }
  }

  async function handleDiscardAndClose() {
    const kind = closeKindRef.current;
    if (!kind) return;
    if (closeInFlight.current) return;
    closeInFlight.current = true;
    try {
      // 明确选择"放弃"是对**全部**草稿的处置，逐个清空，避免外层草稿残留。
      for (const guard of dirtyGuards()) guard.discard();
      await finishClose(kind);
    } finally {
      closeInFlight.current = false;
    }
  }

  function handleCancelClose() {
    setCloseKind(null);
    setCloseError(null);
  }

  return (
    <div className={collapsed ? "shell shell-sidebar-collapsed" : "shell"}>
      <aside className="sidebar">
        <div className="brand">
          <img
            className="brand-mark"
            src={iconAsset(iconVariant)}
            alt=""
            aria-hidden="true"
            data-icon-variant={iconVariant}
          />
          <div className="brand-text">
            <strong>ArtFlow miniDesk</strong>
            <small>{qa ? "QA 测试环境" : "本地委托台账"}</small>
          </div>
        </div>

        <nav aria-label="主导航">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              title={item.label}
              /* 折叠后文字被隐藏，必须有独立可访问名 */
              aria-label={item.label}
              aria-current={undefined}
              className={({ isActive }) => (isActive ? "nav-item nav-item-active" : "nav-item")}
            >
              <span className="nav-icon-box">
                <NavIcon name={item.icon} />
              </span>
              <span className="nav-label">{item.label}</span>
            </NavLink>
          ))}
        </nav>

        {/* 底部组：折叠按钮 + 分隔线 + 版本信息。三者一起贴底，
            按钮不会单独漂在侧栏中下部。 */}
        <div className="sidebar-bottom">
          <button
            type="button"
            className="sidebar-collapse"
            onClick={() => setCollapsed((value) => !value)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
            title={collapsed ? "展开侧边栏" : "折叠侧边栏"}
          >
            <span className="nav-icon-box">
              <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d={collapsed ? "M9 5l7 7-7 7" : "M15 5l-7 7 7 7"}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="nav-label">{collapsed ? "展开" : "折叠"}</span>
          </button>

          <footer className="sidebar-foot">
            <span>{hasDraft ? "有未保存的修改" : "DEV-06A 关窗保护"}</span>
            <span className="muted">未完成 v1.0</span>
          </footer>
        </div>
      </aside>

      <main className="main">
        {qa && (
          <p className="qa-banner" role="status">
            QA 测试环境（{qa.scenario === "clean" ? "空白场景" : "预置场景"}）·
            数据目录与正式应用完全隔离，这里的订单不会出现在正式台账里
          </p>
        )}
        <Outlet />
      </main>

      <UnsavedChangesDialog
        open={closeKind !== null}
        title={closeKind === "quit" ? "退出前有未保存的修改" : "关闭窗口前有未保存的修改"}
        detail={
          dirtyLabels.length > 1
            ? `${closeKind === "quit" ? "退出应用" : "关闭窗口"}会丢失 ${dirtyLabels.length} 处未保存的修改：${dirtyLabels.join("、")}。`
            : closeKind === "quit"
              ? "退出 ArtFlow miniDesk 会丢失尚未保存的修改。"
              : "关闭这个窗口会丢失尚未保存的修改。"
        }
        saveLabel="保存并关闭"
        discardLabel="放弃修改并关闭"
        stayLabel="取消，继续编辑"
        hint="按 Esc 等同于「取消，继续编辑」，不会丢失草稿。"
        error={closeError}
        busy={closeBusy}
        onSaveAndLeave={handleSaveAndClose}
        onDiscard={handleDiscardAndClose}
        onStay={handleCancelClose}
      />
    </div>
  );
}
