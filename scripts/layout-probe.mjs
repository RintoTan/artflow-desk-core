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
  attachment_list: [],
};

function order(id, code, title, position) {
  return {
    id,
    code,
    title,
    clientId: "c1",
    clientName: "林小满",
    commissionType: "半身立绘",
    amountCents: 88000,
    note: "探针数据",
    status: "active",
    workState: "working",
    currentStageId: "s2",
    currentStageTitle: "线稿",
    currentStageIndex: 1,
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
];
fixtures.get_order = (args) => fixtures.list_orders.find((item) => item.id === args?.orderId) ?? fixtures.list_orders[0];

const mockScript = `
window.__TAURI_INTERNALS__ = {
  invoke: async (cmd, args) => {
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
  height: 800,
  deviceScaleFactor: 1,
  mobile: false,
});
await send("Page.addScriptToEvaluateOnNewDocument", { source: mockScript });
await send("Page.navigate", { url: `${url}#${route}` });
await sleep(1800);

const expression = `(() => {
  const main = document.querySelector("main.main");
  const layout = document.querySelector(".orders-layout");
  const list = document.querySelector(".orders-list");
  const detail = layout ? layout.children[1] : null;
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
    })),
    bodyText: document.body.innerText.slice(0, 1200),
  };
})()`;

const result = await send("Runtime.evaluate", {
  expression,
  returnByValue: true,
  awaitPromise: false,
});

console.log(JSON.stringify({ width, route, ...result.result?.result?.value }, null, 2));

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
