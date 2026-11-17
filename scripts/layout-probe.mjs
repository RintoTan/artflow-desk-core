#!/usr/bin/env node
/**
 * 真实排版探针（开发用，不随应用分发）。
 *
 * 为什么不用 jsdom：它没有排版引擎，任何 getBoundingClientRect 都是 0，
 * 用它断言"没有重叠"是自欺。这里用无头 Chrome（Blink）加载真实的 Vite 页面，
 * 注入 Tauri IPC 的假实现喂数据，再读取计算样式与元素矩形。
 *
 * 与 WKWebView 的差异：Blink 与 WebKit 在 flex/grid 细节上偶有差别，
 * 但"两栏是否塌成单栏""粘性定位是否仍生效"这类结构性结论是一致的。
 *
 * 用法：node scripts/layout-probe.mjs <url> <width> [route]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const url = process.argv[2] ?? "http://127.0.0.1:1420/";
const width = Number(process.argv[3] ?? 900);
const route = process.argv[4] ?? "/orders";
const height = Number(process.env.PROBE_HEIGHT ?? 800);
const port = 9333 + (Number(process.env.PROBE_SLOT ?? 0) || 0);

const profile = mkdtempSync(join(tmpdir(), "layout-probe-"));

const fixtures = {
  environment_status: {
    appVersion: "0.1.0",
    firstRun: false,
    generation: "gen-probe",
    schemaVersion: 3,
    upgradedFrom: null,
    rootPath: "/tmp/probe",
    qaMode: true,
    qaScenario: "seeded",
    sqliteVersion: "3.54.1",
    journalMode: "wal",
    workingTimezone: "Asia/Shanghai",
    systemTimezone: "Asia/Shanghai",
    lockHeld: true,
    orders: 3,
    clients: 2,
    templates: 2,
    attachments: 0,
    pendingCleanup: 0,
    highWater: [],
    integrity: "ok",
    foreignKeys: true,
    attachmentIssues: 0,
    generationCount: 1,
    backupCount: 0,
  },
  ui_theme_get: { mode: "arctic", accent: null, storedMode: null },
  working_timezone_get: {
    workingTimezone: "Asia/Shanghai",
    systemTimezone: "Asia/Shanghai",
    sameAsSystem: true,
  },
  preference_get: { listDensity: "comfortable" },
  queue_list: {
    revision: 0,
    entries: [
      { id: "o1", code: "AF-2026-0001", title: "双完成演示稿", queuePosition: 1 },
      { id: "o2", code: "AF-2026-0002", title: "跨月完成稿", queuePosition: 2 },
    ],
  },
  list_clients: [
    {
      id: "c1",
      displayName: "林小满",
      contact: "a@example.test",
      note: null,
      revision: 0,
      orderCount: 2,
      activeCount: 1,
      completedCount: 1,
      knownAmountCents: 176000,
      lastOrderAt: "2026-11-02T03:04:05.000Z",
      tags: [{ id: "t1", name: "长期客户", clientCount: 1 }],
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
    {
      id: "c2",
      displayName: "陈叙",
      contact: null,
      note: null,
      revision: 0,
      orderCount: 1,
      activeCount: 1,
      completedCount: 0,
      knownAmountCents: 0,
      lastOrderAt: null,
      tags: [],
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
    },
  ],
  template_list: [
    {
      id: "tpl-default",
      name: "通用制作流程",
      isDefault: true,
      revision: 0,
      stepCount: 5,
      usageCount: 2,
      steps: [
        { id: "s1", title: "草稿", position: 0 },
        { id: "s2", title: "线稿", position: 1 },
        { id: "s3", title: "固有色", position: 2 },
        { id: "s4", title: "细化", position: 3 },
        { id: "s5", title: "最终调整", position: 4 },
      ],
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
    {
      id: "tpl-light",
      name: "轻量三阶段",
      isDefault: false,
      revision: 0,
      stepCount: 3,
      usageCount: 0,
      steps: [
        { id: "l1", title: "草稿", position: 0 },
        { id: "l2", title: "线稿", position: 1 },
        { id: "l3", title: "完稿", position: 2 },
      ],
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
  ],
  list_order_events: [],
  dashboard: {
    activeTotal: 4,
    queued: 1,
    inProgress: 3,
    dueSoon: 1,
    dueToday: 0,
    overdue: 1,
    unscheduled: 0,
    completedThisMonth: 2,
    cancelledThisMonth: 1,
    createdThisMonth: 4,
    timezone: "Asia/Shanghai",
    today: "2026-11-17",
    month: "2026-11",
  },
  client_tag_list: [{ id: "t1", name: "长期客户", clientCount: 1 }],
  attachment_list: [],
};

const STAGE_TITLES = ["草稿", "线稿", "固有色", "细化", "最终调整"];

function order(id, code, title, position) {
  // 让四张单分布在不同阶段，看板才会有多列可量（横向滚动是否只发生在面板内）。
  const stageIndex = (position - 1) % STAGE_TITLES.length;
  return {
    id,
    code,
    title,
    clientId: "c1",
    clientName: "林小满",
    commissionType: "半身立绘",
    source: position % 2 === 0 ? "米画师" : "画加",
    amountCents: position === 3 ? null : 88000,
    note: "探针数据",
    status: "active",
    workState: "inProgress",
    currentStageId: `s${stageIndex + 1}`,
    currentStageTitle: STAGE_TITLES[stageIndex],
    currentStageIndex: stageIndex,
    stageCount: 5,
    stages: [
      { id: "s1", title: "草稿", position: 0, isCurrent: false },
      { id: "s2", title: "线稿", position: 1, isCurrent: true },
      { id: "s3", title: "固有色", position: 2, isCurrent: false },
      { id: "s4", title: "细化", position: 3, isCurrent: false },
      { id: "s5", title: "最终调整", position: 4, isCurrent: false },
    ],
    queuePosition: position,
    plannedStartDate: "2026-11-01",
    plannedDeliveryDate: "2026-11-20",
    deadlineState: "scheduled",
    startedAt: "2026-11-02T00:00:00.000Z",
    completedAt: null,
    cancelledAt: null,
    revision: 0,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    capabilities: {
      canStartWork: false,
      canUndoStartWork: false,
      undoBlockedReason: "已推进阶段",
      canAdvance: true,
      canRework: true,
      canComplete: false,
      canCancel: true,
      canReopen: false,
      canEditWorkflow: true,
    },
  };
}

fixtures.list_orders = [
  order("o1", "AF-2026-0001", "双完成演示稿", 1),
  order("o2", "AF-2026-0002", "跨月完成稿", 2),
  order(
    "o3",
    "AF-2026-0003",
    "这是一个非常非常长的中文订单标题用于测试换行与溢出处理是否会撑破容器宽度",
    3,
  ),
  // 真的会被两行截断的标题：中文 + 英文 + 一长串不带空格的 token
  order(
    "o4",
    "AF-2026-0004",
    "封面主视觉重绘与全彩上色第二版修订稿第三轮细化和背景补画以及最终交付前的整体检查IllustrationFullRedrawRevisionWithoutAnySpacesAtAll请勿删改直接覆盖原稿",
    4,
  ),
];
fixtures.get_order = (args) => fixtures.list_orders.find((item) => item.id === args?.orderId) ?? fixtures.list_orders[0];

// 月度趋势图：12 个月，含零值月份与大值月份，用来量轴、标签与滚动。
// PROBE_MONTHS=6 时只给半年，验证"6 个月内逐柱标签"的分支。
{
  const months = Number(process.env.PROBE_MONTHS ?? 12);
  const data = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(2026, 10, 1));
    d.setUTCMonth(d.getUTCMonth() - i);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const seed = (i * 7) % 11;
    data.push({
      month: key,
      created: i === 0 ? 10 : i % 3 === 0 ? 0 : seed,
      completed: i === 1 ? 6 : i % 4 === 0 ? 0 : Math.max(0, seed - 3),
      cancelled: i % 5 === 0 ? 2 : 0,
      amountCents: 0,
      knownOrders: 0,
      unknownOrders: 0,
    });
  }
  fixtures.stats_report = {
    range: "last12",
    timezone: "Asia/Shanghai",
    fromMonth: data[0].month,
    toMonth: data[data.length - 1].month,
    months: data,
    totals: {
      month: `${data[0].month}~${data[data.length - 1].month}`,
      created: data.reduce((n, m) => n + m.created, 0),
      completed: data.reduce((n, m) => n + m.completed, 0),
      cancelled: data.reduce((n, m) => n + m.cancelled, 0),
      amountCents: 0,
      knownOrders: 0,
      unknownOrders: 0,
    },
    basis: [],
  };
}

// 设置页会读图标变体；给它一个稳定值，截图才有意义。
fixtures.ui_icon_get = { variant: "orbit", storedVariant: null, defaultVariant: "orbit" };

// 深色主题由后端设置决定，不是 localStorage，所以必须在夹具里给。
if (process.env.PROBE_DARK === "1") {
  fixtures.ui_theme_get = {
    mode: "dark",
    accent: null,
    storedMode: "dark",
  };
}

const mockScript = `
window.__MINIDESK_CALLS__ = [];
window.__TAURI_INTERNALS__ = {
  invoke: async (cmd, args) => {
    window.__MINIDESK_CALLS__.push(cmd);
    const table = ${JSON.stringify(fixtures)};
    const value = table[cmd];
    if (typeof value === "function") return value(args);
    if (value === undefined) {
      if (cmd === "get_order") return table.list_orders[0];
      return null;
    }
    return value;
  },
  transformCallback: (cb) => cb,
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
};
window.isTauri = true;
${process.env.PROBE_COLLAPSED === "1" ? `try { window.localStorage.setItem("minidesk.sidebar", "collapsed"); } catch {}` : ""}
`;

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function targetUrl() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((item) => item.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error("Chrome 调试端口没有就绪");
}

function cleanup(code) {
  try {
    chrome.kill("SIGKILL");
  } catch {
    /* ignore */
  }
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(code);
}

const ws = new WebSocket(await targetUrl());
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

let seq = 0;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});

function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width,
  height,
  // PROBE_DSF=2 / 3：高清截图用。几何读数不受影响（仍是 CSS 像素）。
  deviceScaleFactor: Number(process.env.PROBE_DSF ?? 1),
  mobile: false,
});
await send("Page.addScriptToEvaluateOnNewDocument", { source: mockScript });
await send("Page.navigate", { url: `${url}#${route}` });
await sleep(1800);

const expression = `(() => {
  const main = document.querySelector("main.main");
  const layout = document.querySelector(".orders-layout");
  const list = document.querySelector(".orders-list");
  // 必须按类名定位：布局的首个子节点可能是 <datalist> 之类的无盒元素，
  // 用 children 序号会把列表当成详情，量出"自己和自己重叠"的假失败。
  const detail = document.querySelector(".orders-detail");
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) };
  };
  const cs = (el, prop) => (el ? getComputedStyle(el)[prop] : null);
  const a = rect(list);
  const b = rect(detail);
  const overlap = a && b
    ? Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x)) *
      Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y))
    : 0;
  return {
    innerWidth: window.innerWidth,
    mainClientWidth: main ? main.clientWidth : null,
    mainScrollWidth: main ? main.scrollWidth : null,
    pageScrollWidth: document.documentElement.scrollWidth,
    layoutWidth: layout ? Math.round(layout.getBoundingClientRect().width) : null,
    gridColumns: layout ? cs(layout, "gridTemplateColumns") : null,
    listPosition: list ? cs(list, "position") : null,
    listMaxHeight: list ? cs(list, "maxHeight") : null,
    listComputed: list
      ? {
          height: cs(list, "height"),
          maxHeight: cs(list, "maxHeight"),
          minHeight: cs(list, "minHeight"),
          overflow: cs(list, "overflow"),
          display: cs(list, "display"),
          alignSelf: cs(list, "alignSelf"),
        }
      : null,
    detailChildren: detail ? detail.children.length : null,
    list: a,
    detail: b,
    overlapArea: overlap,
    containerSupported: CSS.supports("container-type: inline-size"),
    resolvedTheme: document.documentElement.getAttribute("data-theme"),
    navItemHeight: (() => { const n = document.querySelector(".nav-item"); return n ? Math.round(n.getBoundingClientRect().height) : null; })(),
    navItemWidth: (() => { const n = document.querySelector(".nav-item"); return n ? Math.round(n.getBoundingClientRect().width) : null; })(),
    sidebarWidth: (() => { const s = document.querySelector(".sidebar"); return s ? Math.round(s.getBoundingClientRect().width) : null; })(),
    titleOverflow: (() => {
      const el = document.querySelector(".order-row-title"); // 兼容旧字段
      return el ? { scrollW: el.scrollWidth, clientW: el.clientWidth, h: Math.round(el.getBoundingClientRect().height), lineHeight: getComputedStyle(el).lineHeight, clamp: getComputedStyle(el).webkitLineClamp } : null;
    })(),

    gridRows: layout ? cs(layout, "gridTemplateRows") : null,
    gridAutoFlow: layout ? cs(layout, "gridAutoFlow") : null,
    layoutDisplay: layout ? cs(layout, "display") : null,
    children: layout ? Array.from(layout.children).map((el) => ({
      cls: el.className,
      pos: getComputedStyle(el).position,
      top: getComputedStyle(el).top,
      rowStart: getComputedStyle(el).gridRowStart,
      colStart: getComputedStyle(el).gridColumnStart,
      marginTop: getComputedStyle(el).marginTop,
      rect: rect(el),
    })) : null,
    titles: Array.from(document.querySelectorAll(".order-row-title")).map((el) => ({
      text: el.textContent.slice(0, 12),
      h: Math.round(el.getBoundingClientRect().height),
      scrollH: el.scrollHeight,
      clientW: el.clientWidth,
      scrollW: el.scrollWidth,
    })),

    // 列表卡片内部各块的高度拆分：判断"可滚动区域被谁吃掉"
    listChrome: list
      ? {
          total: Math.round(list.getBoundingClientRect().height),
          parts: Array.from(list.children).map((el) => ({
            cls: String(el.className).slice(0, 28),
            h: Math.round(el.getBoundingClientRect().height),
          })),
        }
      : null,
    rowsBox: (() => {
      const el = document.querySelector(".order-rows");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const rowH = el.firstElementChild ? el.firstElementChild.getBoundingClientRect().height : 0;
      return {
        h: Math.round(r.height),
        clientH: el.clientHeight,
        scrollH: el.scrollHeight,
        rowHeight: Math.round(rowH),
        visibleRows: rowH ? Math.floor(el.clientHeight / rowH) : null,
      };
    })(),

    // 导航几何：命中区、图标盒、SVG、文字的实际矩形
    navGeom: Array.from(document.querySelectorAll(".nav-item")).map((el) => {
      const box = el.querySelector(".nav-icon-box");
      const svg = el.querySelector("svg");
      const label = el.querySelector(".nav-label");
      const rr = (n) => {
        if (!n) return null;
        const r = n.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cy: Math.round(r.y + r.height / 2) };
      };
      const item = rr(el);
      const bx = rr(box);
      const sx = rr(svg);
      const lb = rr(label);
      const cs2 = getComputedStyle(el);
      return {
        label: el.textContent.trim(),
        item,
        box: bx,
        svg: sx,
        text: lb,
        // 图标盒中心 - 命中区中心：越接近 0 越居中
        boxOffsetX: item && bx ? Math.round(bx.x + bx.w / 2 - (item.x + item.w / 2)) : null,
        boxOffsetY: item && bx ? bx.cy - item.cy : null,
        svgOffset: bx && sx ? { x: Math.round(sx.x + sx.w / 2 - (bx.x + bx.w / 2)), y: Math.round(sx.y + sx.h / 2 - (bx.y + bx.h / 2)) } : null,
        textLeft: lb ? lb.x : null,
        justify: cs2.justifyContent,
        paddingLeft: cs2.paddingLeft,
        height: cs2.height,
      };
    }),
    collapseGeom: (() => {
      const b = document.querySelector(".sidebar-collapse");
      const s = document.querySelector(".sidebar");
      const f = document.querySelector(".sidebar-foot");
      const rr = (n) => {
        if (!n) return null;
        const r = n.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) };
      };
      const br = rr(b);
      const sr = rr(s);
      const fr = rr(f);
      return {
        button: br,
        sidebar: sr,
        foot: fr,
        gapToFoot: br && fr ? Math.round(fr.y - br.bottom) : null,
        gapToBottom: br && sr ? Math.round(sr.bottom - br.bottom) : null,
      };
    })(),
    // 图表：单排/两排模式、轴是否固定、标签密度、零值是否伪装成柱子
    chart: (() => {
      const frame = document.querySelector(".chart-frame");
      if (!frame) return null;
      const axis = frame.querySelector(".chart-axis");
      const scroll = frame.querySelector(".chart-scroll");
      const rows = frame.querySelectorAll(".chart-row");
      const cols = frame.querySelectorAll(".chart-col");
      const rect = (n) => {
        const r = n.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      };
      const axisBefore = rect(axis);
      let axisMoved = false;
      let scrollable = false;
      if (scroll) {
        const before = scroll.scrollLeft;
        scrollable = scroll.scrollWidth > scroll.clientWidth;
        scroll.scrollLeft = 240;
        axisMoved = rect(axis).x !== axisBefore.x;
        scroll.scrollLeft = before;
      }
      const labelNodes = Array.from(frame.querySelectorAll(".bar-value"));
      return {
        mode: frame.dataset.mode,
        rows: rows.length,
        axisCount: frame.querySelectorAll(".chart-axis").length,
        axis: axisBefore,
        axisMoved,
        axisHeight: axisBefore.h,
        plotHeight: Math.round(frame.querySelector(".chart-bars")?.getBoundingClientRect().height ?? 0),
        ticks: Array.from(axis.querySelectorAll(".chart-tick")).map((n) => n.textContent),
        months: cols.length,
        // 每排的刻度必须完全一致，否则两排柱高不可比
        rowTicks: Array.from(frame.querySelectorAll(".chart-axis")).map((a) =>
          Array.from(a.querySelectorAll(".chart-tick")).map((n) => n.textContent).join("/"),
        ),
        labels: labelNodes.map((n) => n.textContent),
        labelsPerRow: Array.from(rows).map((r) => r.querySelectorAll(".bar-value").length),
        zeroBars: frame.querySelectorAll(".bar-zero").length,
        zeroBarHeight: Math.round(
          Array.from(frame.querySelectorAll(".bar-zero")).reduce(
            (max, n) => Math.max(max, n.getBoundingClientRect().height),
            0,
          ),
        ),
        realBars: frame.querySelectorAll(".bar:not(.bar-zero)").length,
        scrollable,
        scrollW: scroll ? scroll.scrollWidth : null,
        clientW: scroll ? scroll.clientWidth : null,
        frameW: Math.round(frame.getBoundingClientRect().width),
        focusable: frame.querySelectorAll('.chart-col[tabindex="0"]').length,
        firstAria: cols[0]?.getAttribute("aria-label") ?? null,
        lastAria: cols[cols.length - 1]?.getAttribute("aria-label") ?? null,
        overflowX: document.documentElement.scrollWidth > window.innerWidth,
      };
    })(),

    // 排期：列表里不应有轨道；详情里的轨道要量出真实比例
    sched: (() => {
      const row = document.querySelector(".order-row");
      const inList = document.querySelector(".order-list .schedule-track");
      const track = document.querySelector(".detail .schedule-track, .orders-detail .schedule-track");
      const band = track?.querySelector(".schedule-band");
      const today = track?.querySelector(".schedule-today");
      const rr = (n) => {
        if (!n) return null;
        const r = n.getBoundingClientRect();
        return {
          x: Math.round(r.x),
          w: Math.round(r.width),
          h: Math.round(r.height),
          leftPct: track ? Math.round(((r.x - track.getBoundingClientRect().x) / track.getBoundingClientRect().width) * 100) : null,
        };
      };
      return {
        rowH: row ? Math.round(row.getBoundingClientRect().height) : null,
        listTrack: Boolean(inList),
        track: rr(track),
        band: rr(band),
        todayPct: today
          ? Math.round(
              ((today.getBoundingClientRect().x - track.getBoundingClientRect().x) /
                track.getBoundingClientRect().width) *
                100,
            )
          : null,
        marks: track ? track.querySelectorAll(".schedule-mark").length : 0,
        overflowMarks: track ? track.querySelectorAll("[data-overflow]").length : 0,
        dates: Array.from(document.querySelectorAll(".schedule-dates dd")).map((n) => n.textContent),
        empty: Boolean(document.querySelector(".empty-inline")),
      };
    })(),
    navBox: (() => {
      const n = document.querySelector("nav");
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return {
        y: Math.round(r.y),
        bottom: Math.round(r.bottom),
        h: Math.round(r.height),
        clientH: n.clientHeight,
        scrollH: n.scrollHeight,
        overflowY: getComputedStyle(n).overflowY,
      };
    })(),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    bodyText: document.body.innerText.slice(0, 1200),
  };
})()`;

const result = await send("Runtime.evaluate", {
  expression,
  returnByValue: true,
  awaitPromise: false,
});

console.log(JSON.stringify({ width, route, ...result.result?.result?.value }, null, 2));

// PROBE_MUTATE：用 "||" 分隔的若干段临时 CSS 修改，逐段应用后重新测量。
// 用来定位"哪一条属性真正在决定高度"，比反复改源码快，也不会留下补丁。
if (process.env.PROBE_MUTATE) {
  const measure = `(() => {
    const l = document.querySelector(".orders-layout");
    const list = document.querySelector(".orders-list");
    const rows = document.querySelector(".order-rows");
    // 用类名定位详情，不要用子节点序号：布局里可能插入 <datalist> 等无盒节点。
    const detail = document.querySelector(".orders-detail");
    const rr = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { y: Math.round(r.y), h: Math.round(r.height), bottom: Math.round(r.bottom) }; };
    const a = rr(list), b = rr(detail);
    return {
      rows: l ? getComputedStyle(l).gridTemplateRows : null,
      listH: a ? a.h : null,
      rowsH: rows ? Math.round(rows.getBoundingClientRect().height) : null,
      overlap: a && b ? Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y)) : null,
    };
  })()`;

  for (const step of process.env.PROBE_MUTATE.split("||")) {
    const value = await send("Runtime.evaluate", {
      expression: `${step} ; ${measure}`,
      returnByValue: true,
    });
    console.log("MUTATE", step.slice(0, 72).padEnd(74), JSON.stringify(value.result?.result?.value));
  }
}

// PROBE_VIEW=board|table：切换到指定视图并测量几何，同时核对"切换视图没有业务写入"。
if (process.env.PROBE_VIEW) {
  const run = async (expression) => {
    const value = await send("Runtime.evaluate", { expression, returnByValue: true });
    return value.result?.result?.value;
  };
  const viewLabel =
    process.env.PROBE_VIEW === "board" ? "看板" : process.env.PROBE_VIEW === "table" ? "表格" : "卡片";
  const clicked = await run(`(() => {
    const box = document.querySelector('[aria-label="切换订单视图"]');
    if (!box) return null;
    const target = Array.from(box.querySelectorAll("button")).find(
      (b) => b.textContent.trim() === ${JSON.stringify(viewLabel)}
    );
    if (!target) return null;
    target.click();
    return Array.from(box.querySelectorAll("button")).map((b) => b.textContent.trim());
  })()`);
  await sleep(500);

  if (process.env.PROBE_DRAWER) {
    await run(`(() => {
      const card = document.querySelector(".board-card-open");
      if (card) card.click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 700));
  }

  const geom = await run(`(() => {
    const root = document.documentElement;
    const board = document.querySelector(".board");
    const cols = board ? Array.from(board.querySelectorAll(".board-col")) : [];
    const widths = cols.map((c) => Math.round(c.getBoundingClientRect().width));
    const table = document.querySelector(".table-wrap");
    const tableEl = document.querySelector(".order-table");
    const wide = document.querySelector(".orders-wide");
    const writeCalls = (window.__MINIDESK_CALLS__ || []).filter((cmd) =>
      /^(create_order|update_order_details|advance_stage|rework_stage|start_work|undo_start_work|complete_order|cancel_order|reopen_order|queue_move|client_create|client_update|client_tag_\w+|attachment_\w+|workflow_\w+|template_\w+)$/.test(cmd)
    );
    return {
      pageScrollW: root.scrollWidth,
      innerW: window.innerWidth,
      overflowX: root.scrollWidth > window.innerWidth + 1,
      wideW: wide ? Math.round(wide.getBoundingClientRect().width) : null,
      board: board
        ? {
            exists: true,
            cols: cols.length,
            totalCols: document.querySelectorAll(".board-nav-chip").length,
            minColW: widths.length ? Math.min(...widths) : 0,
            scrollW: Math.round(board.scrollWidth),
            clientW: Math.round(board.clientWidth),
            scrollsInside: board.scrollWidth > board.clientWidth,
          }
        : { exists: false },
      table: table
        ? {
            exists: true,
            wrapScrollW: Math.round(table.scrollWidth),
            wrapClientW: Math.round(table.clientWidth),
            tableW: tableEl ? Math.round(tableEl.getBoundingClientRect().width) : 0,
            scrollsInside: table.scrollWidth > table.clientWidth,
          }
        : { exists: false },
      writeCalls,
      headBox: (() => {
        const head = document.querySelector(".orders-head");
        if (!head) return null;
        const r = head.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      })(),
      switchBox: (() => {
        const sw = document.querySelector(".view-switch");
        if (!sw) return null;
        const r = sw.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y) };
      })(),
      tableCells: (() => {
        const row = document.querySelector(".order-table tbody tr");
        if (!row) return null;
        return Array.from(row.querySelectorAll("td")).map((td) => {
          const style = getComputedStyle(td);
          return {
            text: (td.textContent || "").trim().slice(0, 12),
            lines: Math.round(td.getBoundingClientRect().height / parseFloat(style.lineHeight || "16")),
            nowrap: style.whiteSpace === "nowrap",
            w: Math.round(td.getBoundingClientRect().width),
          };
        });
      })(),
      bottomGap: (() => {
        const map = [
          [".order-rows", "rows"],
          [".board-cards", "board"],
          [".table-scroll", "table"],
        ];
        for (const [sel, key] of map) {
          const box = document.querySelector(sel);
          if (!box) continue;
          box.scrollTop = box.scrollHeight;
          const items = box.querySelectorAll(".order-row, .board-card, tbody tr");
          const last = items[items.length - 1];
          if (!last) continue;
          const b = box.getBoundingClientRect();
          const l = last.getBoundingClientRect();
          return { key, gap: Math.round(b.bottom - l.bottom) };
        }
        return null;
      })(),
      bottomPad: (() => {
        const pick = (sel) => {
          const node = document.querySelector(sel);
          return node ? Math.round(parseFloat(getComputedStyle(node).paddingBottom || "0")) : null;
        };
        return {
          rows: pick(".order-rows"),
          board: pick(".board-cards"),
          table: pick(".table-wrap"),
          detail: pick(".orders-detail"),
        };
      })(),
      drawer: (() => {
        const bar = document.querySelector(".drawer-bar");
        const close = document.querySelector(".drawer-close");
        const panel = document.querySelector(".orders-detail");
        if (!bar || !close || !panel) return null;
        const c = close.getBoundingClientRect();
        const p = panel.getBoundingClientRect();
        return {
          size: Math.round(c.width),
          h: Math.round(c.height),
          offsetTop: Math.round(c.top - p.top),
          inside: c.left >= p.left - 1 && c.right <= p.right + 1,
        };
      })(),
      boardNav: (() => {
        const nav = document.querySelector(".board-nav");
        if (!nav) return null;
        const chips = Array.from(nav.querySelectorAll(".board-nav-chip"));
        return { chips: chips.length, labels: chips.map((c) => c.textContent.trim()) };
      })(),
      cards: document.querySelectorAll(".order-row").length,
      chips: Array.from(document.querySelectorAll(".view-switch button")).map((b) => b.textContent.trim()),
    };
  })()`);

  console.log("VIEW", JSON.stringify({ clicked, geom }, null, 2));
}

// PROBE_TOOLTIP：模拟悬停长标题，验证气泡出现位置、是否被裁、滚动后是否收起。
if (process.env.PROBE_TOOLTIP === "1") {
  const run = async (expression) => {
    const value = await send("Runtime.evaluate", { expression, returnByValue: true });
    return value.result?.result?.value;
  };

  const before = await run(`(() => {
    const spans = Array.from(document.querySelectorAll(".order-row-title"));
    const span = spans[spans.length - 1];
    const r = span.getBoundingClientRect();
    span.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse", clientX: r.x + 8, clientY: r.y + 6 }));
    const host = span.closest("li");
    const clone = span.cloneNode(true);
    Object.assign(clone.style, { position: "absolute", visibility: "hidden", left: "0", top: "0", width: span.clientWidth + "px", height: "auto", display: "block", overflow: "visible" });
    clone.style.setProperty("-webkit-line-clamp", "unset");
    clone.style.setProperty("-webkit-box-orient", "initial");
    host.appendChild(clone);
    const ccs = getComputedStyle(clone);
    const cloneDiag = {
      h: Math.round(clone.getBoundingClientRect().height),
      display: ccs.display,
      clamp: ccs.webkitLineClamp,
      orient: ccs.webkitBoxOrient,
      w: Math.round(clone.getBoundingClientRect().width),
      scrollH: clone.scrollHeight,
    };
    const cloneH = Math.round(clone.getBoundingClientRect().height);
    clone.remove();
    const range = document.createRange();
    range.selectNodeContents(span);
    const lineRects = Array.from(range.getClientRects()).filter((x) => x.height > 1);
    return {
      text: span.textContent.slice(0, 24),
      clampedH: Math.round(r.height),
      scrollH: span.scrollHeight,
      clientH: span.clientHeight,
      cloneH, cloneDiag,
      rangeLines: lineRects.length,
      rangeH: Math.round(lineRects.reduce((max, x) => Math.max(max, x.bottom), 0) - lineRects[0]?.top ?? 0),
      truncated: span.scrollHeight > Math.round(r.height) + 1,
    };
  })()`);

  await sleep(700);
  const shown = await run(`(() => {
    const tip = document.querySelector(".title-tooltip");
    if (!tip) return null;
    const t = tip.getBoundingClientRect();
    const rows = document.querySelector(".order-rows");
    const rr = rows.getBoundingClientRect();
    const cs = getComputedStyle(tip);
    return {
      text: tip.textContent.slice(0, 24),
      rect: { x: Math.round(t.x), y: Math.round(t.y), w: Math.round(t.width), h: Math.round(t.height), bottom: Math.round(t.bottom) },
      placement: tip.dataset.placement,
      inViewport: t.x >= 0 && t.y >= 0 && t.right <= window.innerWidth && t.bottom <= window.innerHeight,
      // 与列表滚动容器相交并不代表被裁：它是 fixed + portal 到 body
      parent: tip.parentElement === document.body ? "body" : tip.parentElement?.className,
      pointerEvents: cs.pointerEvents,
      overflowWrap: cs.overflowWrap,
    };
  })()`);

  const afterScroll = await run(`(() => {
    const rows = document.querySelector(".order-rows");
    rows.scrollTop = rows.scrollTop + 20;
    rows.dispatchEvent(new Event("scroll", { bubbles: true }));
    return true;
  })()`);
  await sleep(120);
  const closed = await run(`!document.querySelector(".title-tooltip")`);

  console.log("TOOLTIP", JSON.stringify({ before, shown, afterScroll, closedAfterScroll: closed }, null, 2));
}

// PROBE_SHOT=/path.png：把当前视口截下来，供人眼复核（Blink，不是 WKWebView）。
if (process.env.PROBE_SHOT) {
  // PROBE_CLIP=x,y,w,h（CSS 像素）：只截一块区域，便于放大审查侧栏等局部
  const clip = (process.env.PROBE_CLIP ?? "")
    .split(",")
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const shot = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    ...(clip.length === 4
      ? { clip: { x: clip[0], y: clip[1], width: clip[2], height: clip[3], scale: 1 } }
      : {}),
  });
  if (shot.result?.data) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(process.env.PROBE_SHOT, Buffer.from(shot.result.data, "base64"));
    console.log("SHOT", process.env.PROBE_SHOT);
  }
}

const experiment = process.env.EXPERIMENT === "1";
if (experiment) {
  const probeFn = `(() => {
    const l = document.querySelector(".orders-layout");
    const a = l.children[0], b = l.children[1];
    const r = (e) => { const x = e.getBoundingClientRect(); return { y: Math.round(x.y), h: Math.round(x.height), bottom: Math.round(x.bottom) }; };
    const ra = r(a), rb = r(b);
    return {
      rows: getComputedStyle(l).gridTemplateRows,
      align: getComputedStyle(l).alignItems,
      a: ra, b: rb,
      overlapY: Math.max(0, Math.round(Math.min(ra.bottom, rb.bottom) - Math.max(ra.y, rb.y))),
    };
  })()`;

  const steps = [
    ["baseline", ""],
    ["align-items: stretch", "document.querySelector('.orders-layout').style.alignItems='stretch';"],
    ["list overflow: visible", "document.querySelector('.orders-layout').style.alignItems='';document.querySelector('.orders-list').style.overflow='visible';"],
    ["list max-height none", "document.querySelector('.orders-list').style.overflow='';document.querySelector('.orders-list').style.maxHeight='none';"],
  ];

  for (const [label, mutation] of steps) {
    const value = await send("Runtime.evaluate", {
      expression: `${mutation} ${probeFn}`,
      returnByValue: true,
    });
    console.log(label.padEnd(24), JSON.stringify(value.result?.result?.value));
  }
}

ws.close();
cleanup(0);
