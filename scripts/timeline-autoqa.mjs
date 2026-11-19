#!/usr/bin/env node
/**
 * DEV-06D-2-AUTO-QA-01：U6-D（容器 900px 几何）与 U6-E（横向滚动与左右列独立性）。
 *
 * 这是**测试脚本**，不是产品代码。它加载真实 Vite 页面，注入 Tauri IPC 假实现喂
 * 确定性订单数据，然后用 CDP 直接读写 DOM：
 *
 *   1. 容器 900：把 `.main-inner` 固定成 900px 内容宽，量时间线框/信息列/轨道/行高/
 *      图例/刻度与订单条坐标。
 *   2. 横向滚动：直接设 `.timeline-scroll.scrollLeft`，比较滚动前后的几何，
 *      逐项核对"右侧滚、左侧不动、表头与条同步、今天线同步、页面不横向溢出、行仍对齐"。
 *
 * Blink（无头 Chrome）结论，**不是** macOS WKWebView 实机结论。
 *
 * 用法：node scripts/timeline-autoqa.mjs [url]
 * 需要先起 dev server（npm run dev，端口按实际）。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL_BASE = process.argv[2] ?? "http://127.0.0.1:1425/";
const PORT = Number(process.env.AUTOQA_PORT ?? 9441);
const SHOT_DIR = process.env.AUTOQA_SHOT_DIR ?? "/tmp/timeline-autoqa";
const WINDOW_W = Number(process.env.AUTOQA_WIDTH ?? 1400);
const WINDOW_H = Number(process.env.AUTOQA_HEIGHT ?? 1300);
// 0 = 不改容器，按视口原生宽度量（900 / 1400 / 1680 布局回归用）。
const CONTAINER = Number(process.env.AUTOQA_CONTAINER ?? 900);

const STAGE_TITLES = ["草稿", "线稿", "固有色", "细化", "最终调整"];

/** 必须长到在 235px 的信息列里放不下，才能验证省略号而不是"刚好塞得下"。 */
const LONG_TITLE =
  "封面主视觉重绘与全彩上色第二版修订稿第三轮细化和背景补画以及最终交付前的整体检查IllustrationFullRedrawRevisionWithoutAnySpaces";

function order(id, code, title, position, dates) {
  const stageIndex = (position - 1) % STAGE_TITLES.length;
  return {
    id,
    code,
    title,
    clientId: "c1",
    clientName: "林小满",
    commissionType: "半身立绘",
    source: "画加",
    amountCents: 88000,
    note: "AUTO-QA-01 夹具",
    status: dates.status ?? "active",
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
    plannedStartDate: dates.start ?? null,
    plannedDeliveryDate: dates.delivery ?? null,
    deadlineState: dates.deadlineState ?? "scheduled",
    startedAt: "2026-11-02T00:00:00.000Z",
    completedAt: dates.completedAt ?? null,
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

// 固定订单：起点都落在 2026-11 月窗口内，方便把"刻度 x"与"条 x"直接对照。
const ORDERS = [
  order("q1", "AF-2026-1001", "AUTOQA 十一月区间", 1, { start: "2026-11-04", delivery: "2026-11-12" }),
  order("q2", "AF-2026-1002", "AUTOQA 单日", 2, { start: "2026-11-16", delivery: "2026-11-16" }),
  order("q3", "AF-2026-1003", "AUTOQA 仅开始", 3, { start: "2026-11-09", delivery: null }),
  order("q4", "AF-2026-1004", "AUTOQA 仅交付", 4, { start: null, delivery: "2026-11-21" }),
  order("q5", "AF-2026-1005", "AUTOQA 十二月区间", 5, { start: "2026-11-26", delivery: "2026-12-06" }),
  order("q6", "AF-2026-1006", "AUTOQA 完全未排期", 6, { start: null, delivery: null }),
  order("q7", "AF-2026-1007", LONG_TITLE, 7, { start: "2026-11-05", delivery: "2026-11-09" }),
];

const fixtures = {
  environment_status: {
    appVersion: "0.1.0",
    firstRun: false,
    generation: "gen-autoqa",
    schemaVersion: 3,
    upgradedFrom: null,
    rootPath: "/tmp/autoqa",
    qaMode: true,
    qaScenario: "timeline-unscheduled",
    sqliteVersion: "3.54.1",
    journalMode: "wal",
    workingTimezone: "Asia/Shanghai",
    systemTimezone: "Asia/Shanghai",
    lockHeld: true,
    orders: ORDERS.length,
    clients: 1,
    templates: 1,
    attachments: 0,
    pendingCleanup: 0,
    highWater: [],
    integrity: "ok",
  },
  ui_theme_get: { mode: "arctic", accent: null, storedMode: null },
  ui_icon_get: { variant: "orbit", storedVariant: null, defaultVariant: "orbit" },
  list_clients: [
    { id: "c1", displayName: "林小满", contact: null, note: null, orderCount: ORDERS.length, createdAt: "2026-11-01T00:00:00.000Z" },
  ],
  dashboard_metrics: {
    activeTotal: 6,
    queued: 2,
    inProgress: 4,
    dueSoon: 1,
    dueToday: 0,
    overdue: 1,
    unscheduled: 1,
    completedThisMonth: 0,
    cancelledThisMonth: 0,
    createdThisMonth: 6,
    timezone: "Asia/Shanghai",
    today: "2026-11-18",
    month: "2026-11",
  },
  list_orders: ORDERS,
};

const mockScript = `
(() => {
  window.__AUTOQA_CALLS__ = [];
  const table = ${JSON.stringify(fixtures)};
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      window.__AUTOQA_CALLS__.push(cmd);
      const value = table[cmd];
      if (typeof value === "function") return value(args);
      // 真实 IPC 每次都会把 JSON 反序列化成**新对象**；夹具必须一样，
      // 否则 React 会因为引用相同而跳过更新，测出假的"状态被保留"。
      if (value === undefined) {
        if (cmd === "get_order") {
          const hit = table.list_orders.find((o) => o.id === args?.orderId) ?? table.list_orders[0];
          return JSON.parse(JSON.stringify(hit));
        }
        return null;
      }
      return JSON.parse(JSON.stringify(value));
    },
    transformCallback: (cb) => cb,
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  };
  window.isTauri = true;

  // 容器宽度是这一轮的自变量：只改主内容容器，不动时间线自身样式。
  ${
    CONTAINER > 0
      ? `document.addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.textContent = ".main-inner { width: ${CONTAINER}px !important; padding-inline: 0 !important; }";
    document.head.appendChild(style);
  });`
      : ""
  }
})();
`;

const profile = mkdtempSync(join(tmpdir(), "timeline-autoqa-"));
mkdirSync(SHOT_DIR, { recursive: true });

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${WINDOW_W},${WINDOW_H}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--force-device-scale-factor=1",
    "--hide-scrollbars=false",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((item) => item.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* 端口还没就绪 */
    }
    await sleep(250);
  }
  throw new Error("Chrome 调试端口没有就绪");
}

function rpc(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
    else entry.resolve(msg.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return { ready, send, close: () => socket.close() };
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

const results = { width: WINDOW_W, container: CONTAINER, checks: [], observations: [], measurements: {} };
function check(name, pass, detail) {
  results.checks.push({ name, pass, detail });
}
/** 规格没有承诺、但实测存在的行为差异：记录数值，不当作门禁。 */
function observe(name, value, note) {
  results.observations.push({ name, value, note });
}

/** 一次读全：左列、轨道、表头刻度、网格线、条、今天线、行、图例、页面溢出。 */
const MEASURE = `(() => {
  const r = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x * 100) / 100, y: Math.round(b.y * 100) / 100, w: Math.round(b.width * 100) / 100, h: Math.round(b.height * 100) / 100 };
  };
  const scroller = document.querySelector(".timeline-scroll");
  const canvas = document.querySelector(".timeline-canvas");
  const frame = document.querySelector(".timeline-frame");
  const infos = [...document.querySelectorAll(".timeline-info")];
  const rows = [...document.querySelectorAll(".timeline-row")];
  const bars = [...document.querySelectorAll(".timeline-bar")];
  const marks = [...document.querySelectorAll(".timeline-mark")];
  const grid = [...document.querySelectorAll(".timeline-grid-line")];
  const ticks2 = [...document.querySelectorAll(".timeline-tier-2 .timeline-tick")];
  const todayLine = document.querySelector(".timeline-today-line");
  const todayFlag = document.querySelector(".timeline-today-flag");
  const legend = [...document.querySelectorAll(".timeline-legend li")];
  const panel = document.querySelector('[aria-labelledby="timeline-title"]');
  const mainInner = document.querySelector(".main-inner");
  const axis = document.querySelector(".timeline-axis");

  // 表头刻度与网格线必须同源：tier2 刻度 left 与网格线 left 之差。
  const gridLefts = grid.map((el) => Math.round(el.getBoundingClientRect().left * 100) / 100);
  const tickLefts = ticks2.map((el) => Math.round(el.getBoundingClientRect().left * 100) / 100);
  return {
    scrollLeft: scroller ? Math.round(scroller.scrollLeft) : null,
    scrollWidth: scroller ? scroller.scrollWidth : null,
    clientWidth: scroller ? scroller.clientWidth : null,
    canScroll: scroller ? scroller.scrollWidth > scroller.clientWidth + 1 : null,
    overflowX: scroller ? getComputedStyle(scroller).overflowX : null,
    verticalScroll: scroller ? scroller.scrollHeight > scroller.clientHeight + 1 : null,
    canvasWidth: canvas ? Math.round(canvas.getBoundingClientRect().width) : null,
    mainInner: mainInner ? Math.round(mainInner.getBoundingClientRect().width) : null,
    panel: r(panel),
    panelPad: panel ? getComputedStyle(panel).paddingInlineStart : null,
    frame: r(frame),
    axis: r(axis),
    corner: r(document.querySelector(".timeline-corner")),
    infoW: r(infos[0])?.w ?? null,
    rowH: r(rows[0])?.h ?? null,
    infoX: infos.map((el) => Math.round(el.getBoundingClientRect().x * 100) / 100),
    infoTops: infos.map((el) => Math.round(el.getBoundingClientRect().top * 100) / 100),
    rowTops: rows.map((el) => Math.round(el.getBoundingClientRect().top * 100) / 100),
    rowHAll: rows.map((el) => Math.round(el.getBoundingClientRect().height * 100) / 100),
    barX: bars.map((el) => Math.round(el.getBoundingClientRect().x * 100) / 100),
    barW: bars.map((el) => Math.round(el.getBoundingClientRect().width * 100) / 100),
    markX: marks.map((el) => Math.round(el.getBoundingClientRect().x * 100) / 100),
    gridLefts,
    tickLefts,
    tickLabels: ticks2.map((el) => (el.textContent || "").trim()),
    todayLineX: todayLine ? Math.round(todayLine.getBoundingClientRect().x * 100) / 100 : null,
    todayFlagX: todayFlag ? Math.round(todayFlag.getBoundingClientRect().x * 100) / 100 : null,
    legend: legend.map((li) => ({
      text: (li.textContent || "").trim(),
      w: Math.round(li.getBoundingClientRect().width),
      h: Math.round(li.getBoundingClientRect().height),
      fs: getComputedStyle(li).fontSize,
    })),
    pageScrollWidth: document.documentElement.scrollWidth,
    pageClientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    barCount: bars.length,
    markCount: marks.length,
    rowCount: rows.length,
    infoCount: infos.length,
    unscheduledText: (document.querySelector(".timeline-unscheduled")?.textContent || "").trim().slice(0, 120),
    // ISSUE-01：直接量 .timeline-title 自己的行盒与溢出，不用父元素代替。
    titleGeom: infos.map((el) => {
      const t = el.querySelector(".timeline-title");
      const infoBox = el.getBoundingClientRect();
      if (!t) return null;
      const box = t.getBoundingClientRect();
      const cs = getComputedStyle(t);
      return {
        text: (t.textContent || "").slice(0, 18),
        fullLength: (t.textContent || "").length,
        infoH: Math.round(infoBox.height * 100) / 100,
        titleTop: Math.round(box.top * 100) / 100,
        titleBottom: Math.round(box.bottom * 100) / 100,
        titleH: Math.round(box.height * 100) / 100,
        titleClientH: t.clientHeight,
        titleScrollH: t.scrollHeight,
        clientWidth: t.clientWidth,
        scrollWidth: t.scrollWidth,
        lineHeight: cs.lineHeight,
        overflow: cs.overflow,
        textOverflow: cs.textOverflow,
        whiteSpace: cs.whiteSpace,
        // 纵向：行盒装不下内容 → 被压扁；横向：内容超宽 → 应当出现省略号
        verticallyClipped: t.scrollHeight > t.clientHeight + 1,
        horizontallyTruncated: t.scrollWidth > t.clientWidth + 1,
        insideInfo: box.top >= infoBox.top - 0.5 && box.bottom <= infoBox.bottom + 0.5,
      };
    }),
    horizontalScrollbar: scroller ? scroller.offsetWidth - scroller.clientWidth : null,
  };
})()`;

async function evaluate(send, expression) {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true });
  return res.result?.value;
}

async function shot(send, name, beyondViewport = true) {
  const res = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: beyondViewport });
  const path = join(SHOT_DIR, name);
  writeFileSync(path, Buffer.from(res.data, "base64"));
  return path;
}

async function main() {
  const client = rpc(await wsUrl());
  await client.ready;
  const { send } = client;

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: WINDOW_W,
    height: WINDOW_H,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: mockScript });
  await send("Page.navigate", { url: URL_BASE });

  // 等时间线渲染出来（最多 15s）
  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    await sleep(250);
    ready = await evaluate(send, `Boolean(document.querySelector(".timeline-frame"))`);
    if (ready) break;
  }
  if (!ready) {
    const text = await evaluate(send, "document.body.innerText.slice(0, 400)");
    console.error("时间线没有渲染：", text);
    client.close();
    cleanup(1);
  }
  await sleep(400);

  const before = await evaluate(send, MEASURE);
  results.measurements.before = before;
  results.measurements.calls = await evaluate(send, "window.__AUTOQA_CALLS__.slice()");
  const shotBefore = await shot(send, "01-容器900-滚动前.png");

  // ---------------- U6-D：容器 900 几何
  const frameExpected = before.mainInner - 2 * parseFloat(before.panelPad) - 2;
  if (CONTAINER > 0) {
    check("主内容容器 ≈900px", Math.abs(before.mainInner - CONTAINER) <= 2, `mainInner=${before.mainInner}`);
    check(
      "时间线框 = 容器 − 面板内边距 − 边框",
      Math.abs(before.frame.w - frameExpected) <= 2,
      `frame=${before.frame.w} 期望≈${frameExpected}（容器 ${before.mainInner} − 2×${before.panelPad} − 2）`,
    );
  } else {
    results.measurements.layout = {
      mainInner: before.mainInner,
      frame: before.frame.w,
      info: before.infoW,
      track: before.clientWidth,
      row: before.rowH,
    };
  }
  if (CONTAINER > 0) {
    check("信息列 ≈235px", Math.abs(before.infoW - 235) <= 3, `infoWidth=${before.infoW}`);
    check("轨道可视宽 ≈622px", Math.abs(before.clientWidth - 622) <= 6, `trackWidth=${before.clientWidth}`);
  }
  check("行高 ≈56px 或窄窗 52px", before.rowH === 56 || before.rowH === 52, `rowHeight=${before.rowH}`);
  check(
    "信息列 + 轨道 ≤ 时间线框（无溢出）",
    before.infoW + before.clientWidth <= before.frame.w + 1,
    `${before.infoW} + ${before.clientWidth} ≤ ${before.frame.w}`,
  );
  const legendTexts = before.legend.map((l) => l.text);
  const expectedLegend = ["按排期", "三日内", "今天到期", "已逾期", "已结束"];
  check(
    "五条图例文字完整且可见",
    before.legend.length === 5 &&
      expectedLegend.every((t) => legendTexts.includes(t)) &&
      before.legend.every((l) => l.w > 0 && l.h > 0),
    JSON.stringify(before.legend),
  );
  check(
    "容器内无横向溢出",
    before.pageScrollWidth <= before.pageClientWidth + 1,
    `pageScrollWidth=${before.pageScrollWidth} clientWidth=${before.pageClientWidth}`,
  );
  check(
    "刻度与网格线同一坐标系（逐条 left 相等）",
    before.gridLefts.length === before.tickLefts.length &&
      before.gridLefts.every((x, i) => Math.abs(x - before.tickLefts[i]) <= 0.6),
    `${before.gridLefts.length} 格 / ${before.tickLefts.length} 刻度`,
  );
  check(
    "每个订单条都落在画布内",
    before.barX.every((x) => x >= before.frame.x + before.infoW - 1 && x <= before.frame.x + before.frame.w),
    JSON.stringify(before.barX),
  );
  check("信息列与轨道逐行 y 对齐", before.infoTops.every((t, i) => Math.abs(t - before.rowTops[i]) <= 0.6), JSON.stringify(before.rowTops));

  // ---------------- ISSUE-01：标题行盒完整、省略号只发生在横向
  const titles = before.titleGeom.filter(Boolean);
  check(
    "标题行盒不被纵向压缩（clientHeight 装得下 scrollHeight）",
    titles.every((t) => !t.verticallyClipped),
    titles.map((t) => `${t.titleClientH}/${t.titleScrollH}`).join(" · "),
  );
  check(
    "标题行高恒为 17px，且落在信息列矩形内",
    titles.every((t) => t.lineHeight === "17px" && Math.abs(t.titleH - 17) <= 0.6 && t.insideInfo),
    titles.map((t) => `${t.lineHeight}/${t.titleH}`).join(" · "),
  );
  check(
    "行高没有被标题撑高（与设计值一致且每行等高）",
    (before.rowH === 56 || before.rowH === 52) &&
      before.rowHAll.every((h) => Math.abs(h - before.rowH) <= 0.6),
    `rowH=${before.rowH}`,
  );
  const longTitle = titles.find((t) => t.fullLength > 40);
  const shortTitles = titles.filter((t) => t.fullLength <= 40);
  check(
    "超长标题走横向省略号（scrollWidth > clientWidth 且 text-overflow: ellipsis）",
    Boolean(longTitle) && longTitle.horizontallyTruncated && longTitle.textOverflow === "ellipsis" && longTitle.whiteSpace === "nowrap",
    longTitle ? `client ${longTitle.clientWidth} / scroll ${longTitle.scrollWidth} / ${longTitle.textOverflow}` : "没有找到长标题行",
  );
  check(
    "短标题不触发截断",
    shortTitles.length > 0 && shortTitles.every((t) => !t.horizontallyTruncated),
    shortTitles.map((t) => `${t.clientWidth}/${t.scrollWidth}`).join(" · "),
  );
  check(
    "标题 DOM 文本是完整原文（截断只在视觉层）",
    titles.every((t) => !t.text.endsWith("…")) && Boolean(longTitle) && longTitle.fullLength >= LONG_TITLE.length,
    `最长一行 ${longTitle?.fullLength ?? 0} 字，源标题 ${LONG_TITLE.length} 字`,
  );
  check("轨道没有纵向滚动", before.verticalScroll === false, `verticalScroll=${before.verticalScroll}`);
  check(
    "轨道可横向滚动（否则 U6-E 无对象）",
    before.canScroll === true,
    `scrollWidth=${before.scrollWidth} clientWidth=${before.clientWidth}`,
  );

  // ---------------- U6-E：横向滚动
  // 目标位置相对当前位置取，保证在任意视口都能产生一段可观测的位移
  // （进页面会自动把今天放到 45%，初始 scrollLeft 不是 0）。
  const maxScroll = (before.scrollWidth ?? 0) - (before.clientWidth ?? 0);
  const target = Math.min(maxScroll, (before.scrollLeft ?? 0) + 200);
  const applied = await evaluate(
    send,
    `(() => { const el = document.querySelector(".timeline-scroll"); el.scrollLeft = ${target}; return el.scrollLeft; })()`,
  );
  await sleep(300);
  const after = await evaluate(send, MEASURE);
  results.measurements.after = after;
  results.measurements.requestedScrollLeft = target;
  results.measurements.appliedScrollLeft = applied;
  const shotAfter = await shot(send, "02-容器900-滚动后.png");

  const dx = (after.scrollLeft ?? 0) - (before.scrollLeft ?? 0);
  check("轨道真的发生了横向滚动", Math.abs(applied - target) <= 1 && Math.abs(dx) > 100, `scrollLeft ${before.scrollLeft} → ${after.scrollLeft}（请求 ${target}）`);
  check(
    "左侧信息列位置不变",
    before.infoX.length === after.infoX.length && before.infoX.every((x, i) => Math.abs(x - after.infoX[i]) <= 0.6),
    `${JSON.stringify(before.infoX.slice(0, 3))} → ${JSON.stringify(after.infoX.slice(0, 3))}`,
  );
  check(
    "信息列宽度不变（滚动不影响布局）",
    Math.abs(before.infoW - after.infoW) <= 0.6,
    `${before.infoW} → ${after.infoW}`,
  );
  const tickDelta = Math.round((after.tickLefts[0] - before.tickLefts[0]) * 100) / 100;
  const barDelta = Math.round((after.barX[0] - before.barX[0]) * 100) / 100;
  check(
    "表头刻度与订单条同向同步移动",
    Math.abs(tickDelta + dx) <= 1 && Math.abs(barDelta + dx) <= 1 && Math.abs(tickDelta - barDelta) <= 1,
    `tick Δ=${tickDelta} bar Δ=${barDelta} scrollLeft Δ=${dx}`,
  );
  check(
    "刻度与网格线滚动后仍逐条重合",
    after.gridLefts.length === after.tickLefts.length &&
      after.gridLefts.every((x, i) => Math.abs(x - after.tickLefts[i]) <= 0.6),
    `${after.gridLefts.length} 格`,
  );
  const lineDelta = Math.round((after.todayLineX - before.todayLineX) * 100) / 100;
  const flagDelta = Math.round((after.todayFlagX - before.todayFlagX) * 100) / 100;
  check(
    "今天竖线与表头「今天」旗同步",
    before.todayLineX !== null &&
      after.todayLineX !== null &&
      Math.abs(lineDelta + dx) <= 1 &&
      Math.abs(flagDelta + dx) <= 1 &&
      Math.abs(lineDelta - flagDelta) <= 1,
    `line Δ=${lineDelta}（回到 0 时回推坐标=${Math.round((before.todayLineX + (before.scrollLeft ?? 0)) * 100) / 100}） flag Δ=${flagDelta}`,
  );
  check(
    "滚动后页面仍无横向溢出",
    after.pageScrollWidth <= after.pageClientWidth + 1,
    `pageScrollWidth=${after.pageScrollWidth} clientWidth=${after.pageClientWidth}`,
  );
  check(
    "滚动后各订单行仍然对齐",
    after.infoTops.every((t, i) => Math.abs(t - after.rowTops[i]) <= 0.6) &&
      after.rowHAll.every((h) => Math.abs(h - after.rowH) <= 0.6),
    `infoTops=${JSON.stringify(after.infoTops.slice(0, 3))} rowTops=${JSON.stringify(after.rowTops.slice(0, 3))}`,
  );

  // 滚回 0 再确认一次可逆（排除"只对一次赋值生效"的假象）
  const back = await evaluate(
    send,
    `(() => { const el = document.querySelector(".timeline-scroll"); el.scrollLeft = 0; return el.scrollLeft; })()`,
  );
  await sleep(250);
  const restored = await evaluate(send, MEASURE);
  results.measurements.restored = { scrollLeft: restored.scrollLeft, tick0: restored.tickLefts[0], bar0: restored.barX[0] };
  // 初始 scrollLeft 不是 0（进页面会自动把今天放到视口 45%），
  // 所以「回到 0」的正确期望是 before 坐标 + before.scrollLeft。
  const restoredTick = Math.round((restored.tickLefts[0] - (before.tickLefts[0] + (before.scrollLeft ?? 0))) * 100) / 100;
  const restoredBar = Math.round((restored.barX[0] - (before.barX[0] + (before.scrollLeft ?? 0))) * 100) / 100;
  check(
    "滚回 0 后坐标按 scrollLeft 线性复原",
    back === 0 && Math.abs(restoredTick) <= 0.6 && Math.abs(restoredBar) <= 0.6,
    `tick 误差 ${restoredTick}；bar 误差 ${restoredBar}（初始 scrollLeft=${before.scrollLeft}）`,
  );

  results.screenshots = { before: shotBefore, after: shotAfter };

  // ---------------- ISSUE-02：周视图范围诊断（A 窗口 / B 可视 / C 末刻度 / D 画布）
  await evaluate(
    send,
    `(() => {
      const btn = [...document.querySelectorAll(".segmented button")].find((b) => (b.textContent || "").trim() === "周");
      if (btn) btn.click();
      return Boolean(btn);
    })()`,
  );
  await sleep(400);
  await evaluate(send, `(() => { document.querySelector(".timeline-scroll").scrollLeft = 0; return 0; })()`);
  await sleep(250);
  const week = await evaluate(
    send,
    `(() => {
      const scroller = document.querySelector(".timeline-scroll");
      const text = document.querySelector('[data-testid="timeline-range"]').textContent || "";
      const ticks = [...document.querySelectorAll(".timeline-tier-2 .timeline-tick")].map((el) => ({
        label: (el.textContent || "").trim(),
        left: Math.round(el.getBoundingClientRect().left * 100) / 100,
        width: Math.round(el.getBoundingClientRect().width * 100) / 100,
      }));
      const grid = [...document.querySelectorAll(".timeline-grid-line")].map(
        (el) => Math.round(el.getBoundingClientRect().left * 100) / 100,
      );
      const canvas = document.querySelector(".timeline-canvas");
      const bars = [...document.querySelectorAll(".timeline-bar")].map((el) => {
        const b = el.getBoundingClientRect();
        return { right: Math.round(b.right * 100) / 100 };
      });
      return {
        rangeText: text,
        ticks,
        gridCount: grid.length,
        lastGridLeft: grid.length ? grid[grid.length - 1] : null,
        canvasWidth: Math.round(canvas.getBoundingClientRect().width),
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth,
        horizontalScrollbar: scroller.offsetWidth - scroller.clientWidth,
        canvasRight: Math.round(canvas.getBoundingClientRect().right * 100) / 100,
        maxBarRight: bars.length ? Math.max(...bars.map((b) => b.right)) : null,
      };
    })()`,
  );
  await evaluate(
    send,
    `(() => { const el = document.querySelector(".timeline-scroll"); el.scrollLeft = el.scrollWidth; return el.scrollLeft; })()`,
  );
  await sleep(300);
  const weekAtEnd = await evaluate(
    send,
    `(() => {
      const text = document.querySelector('[data-testid="timeline-range"]').textContent || "";
      const scroller = document.querySelector(".timeline-scroll");
      return { rangeText: text, scrollLeft: Math.round(scroller.scrollLeft), maxScroll: scroller.scrollWidth - scroller.clientWidth };
    })()`,
  );
  results.measurements.week = { start: week, end: weekAtEnd };

  const dayNum = (key) => {
    const [y, m, d] = key.split("-").map(Number);
    return Date.UTC(y, m - 1, d) / 86400000;
  };
  const winMatch = /窗口\s*(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})/.exec(week.rangeText);
  const visMatch0 = /可见\s*(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})/.exec(week.rangeText);
  const visMatchEnd = /可见\s*(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})/.exec(weekAtEnd.rangeText);
  const weekDays = winMatch ? dayNum(winMatch[2]) - dayNum(winMatch[1]) + 1 : null;

  check(
    "周窗口 = 2026-10-26 ~ 2027-01-17",
    Boolean(winMatch) && winMatch[1] === "2026-10-26" && winMatch[2] === "2027-01-17",
    week.rangeText.slice(0, 90),
  );
  check("周窗口天数 = 84（12 个完整自然周）", weekDays === 84, `${weekDays} 天`);
  check(
    "首刻度 10-26、末刻度 01-11，共 12 个周一刻度",
    week.ticks.length === 12 && week.ticks[0].label === "10-26" && week.ticks[11].label === "01-11",
    week.ticks.map((t) => t.label).join(" "),
  );
  check(
    "末刻度右缘 = 画布右缘（01-11 起算 7 天到 01-18 半开，视觉到 01-17）",
    Math.abs(week.ticks[11].left + week.ticks[11].width - week.canvasRight) <= 1.5,
    `末刻度右缘 ${Math.round((week.ticks[11].left + week.ticks[11].width) * 100) / 100}，画布右缘 ${week.canvasRight}`,
  );
  check("画布宽 = 84 × 26 = 2184", week.canvasWidth === 2184, `${week.canvasWidth}px`);
  check(
    "滚动到最右时可视范围止于 2027-01-17（窗口终点，而不是末刻度 01-11）",
    Boolean(visMatchEnd) && visMatchEnd[2] === "2027-01-17",
    weekAtEnd.rangeText.slice(0, 90),
  );
  check(
    "滚到 0 时可视范围从 10-26 起（10-16 在窗口之前，任何滚动位置都不会出现）",
    Boolean(visMatch0) && visMatch0[1] === "2026-10-26",
    `${visMatch0?.[1]} ~ ${visMatch0?.[2]}`,
  );
  observe(
    "周视图横向滚动条占位",
    `${week.horizontalScrollbar}px（scrollWidth ${week.scrollWidth} / clientWidth ${week.clientWidth}）`,
    "占位取决于平台滚动条；画布按 84 天算，滚动条不会裁掉最后几天",
  );
  observe(
    "末条网格线位置",
    `${week.lastGridLeft}（共 ${week.gridCount} 条，均在周一）`,
    "网格线画在刻度左缘：最后一条在 01-11，画布仍延伸到 01-17",
  );

  // ---------------- UX-TL-01：日期提示（hover / 键盘 / 不挡住点击）
  let pointerPrimed = false;
  const hoverAt = async (selector, dx = 0.5) => {
    if (!pointerPrimed) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 8, y: 8, buttons: 0 });
      await sleep(60);
      pointerPrimed = true;
    }
    const box = await evaluate(
      send,
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.left + b.width * ${dx}, y: b.top + b.height / 2 };
      })()`,
    );
    if (!box) return null;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y, buttons: 0 });
    await sleep(220);
    return box;
  };
  const readTip = () =>
    evaluate(
      send,
      `(() => {
        const tip = document.querySelector(".timeline-tip");
        if (!tip) return null;
        const b = tip.getBoundingClientRect();
        return {
          text: (tip.textContent || "").trim(),
          lines: [...tip.querySelectorAll("span")].map((s) => (s.textContent || "").trim()),
          left: Math.round(b.left),
          right: Math.round(b.right),
          top: Math.round(b.top),
          bottom: Math.round(b.bottom),
          pointerEvents: getComputedStyle(tip).pointerEvents,
          pageScrollWidth: document.documentElement.scrollWidth,
          pageClientWidth: document.documentElement.clientWidth,
          rowHeight: Math.round(document.querySelector(".timeline-row").getBoundingClientRect().height),
        };
      })()`,
    );

  // 切回月尺度：条与标记都在窗口内，提示内容好对照
  await evaluate(
    send,
    `(() => {
      const btn = [...document.querySelectorAll(".segmented button")].find((b) => (b.textContent || "").trim() === "月");
      if (btn) btn.click();
      return true;
    })()`,
  );
  // 切尺度会触发"把今天放到视口 45%"，等它落定再手动归零，
  // 否则后面按旧坐标悬浮会落空（这是脚本时序问题，不是产品行为）。
  await sleep(600);
  await evaluate(send, `(() => { const el = document.querySelector(".timeline-scroll"); el.scrollLeft = 0; return 0; })()`);
  await sleep(300);

  const pageBefore = await evaluate(send, `document.documentElement.scrollWidth`);
  const rowHBefore = await evaluate(
    send,
    `Math.round(document.querySelector(".timeline-row").getBoundingClientRect().height)`,
  );

  await hoverAt('.timeline-row[data-order-id="q1"] .timeline-bar');
  const tipBar = await readTip();
  check(
    "双日期：悬浮区间条给出完整起止日期",
    Boolean(tipBar) && tipBar.text.includes("开始日期：2026-11-04") && tipBar.text.includes("交付日期：2026-11-12"),
    tipBar?.text ?? "没有出现提示",
  );
  check(
    "提示不改变行高、不撑出页面横向溢出，且不吃鼠标事件",
    Boolean(tipBar) &&
      tipBar.pointerEvents === "none" &&
      tipBar.rowHeight === rowHBefore &&
      tipBar.pageScrollWidth === pageBefore,
    `rowH ${rowHBefore} → ${tipBar?.rowHeight}；scrollWidth ${pageBefore} → ${tipBar?.pageScrollWidth}；pointer-events ${tipBar?.pointerEvents}`,
  );
  check(
    "提示落在视口内",
    Boolean(tipBar) && tipBar.left >= 0 && tipBar.right <= pageBefore && tipBar.top >= 0,
    tipBar ? `left ${tipBar.left} right ${tipBar.right} top ${tipBar.top}` : "无提示",
  );
  const shotTip = await shot(send, "04-双日期提示.png", false);

  await hoverAt('.timeline-row[data-order-id="q2"] .timeline-bar');
  const tipSingle = await readTip();
  check(
    "同日订单：提示单日排期且只给一个日期",
    Boolean(tipSingle) &&
      tipSingle.text.includes("2026-11-16") &&
      tipSingle.text.includes("单日排期") &&
      (tipSingle.text.match(/2026-11-16/g) || []).length === 1,
    tipSingle?.text ?? "没有出现提示",
  );

  await hoverAt('.timeline-row[data-order-id="q3"] .timeline-mark');
  const tipStart = await readTip();
  check(
    "仅开始：提示「仅开始」+ 开始日期",
    Boolean(tipStart) && tipStart.text.includes("仅开始") && tipStart.text.includes("开始日期：2026-11-09"),
    tipStart?.text ?? "没有出现提示",
  );
  const shotMark = await shot(send, "05-仅开始提示.png", false);

  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 4, buttons: 0 });
  await sleep(250);
  const tipGone = await evaluate(send, `Boolean(document.querySelector(".timeline-tip"))`);
  check("鼠标离开后提示消失", tipGone === false, `tip 存在=${tipGone}`);

  // 键盘：聚焦排期图形同样能看到日期
  await evaluate(
    send,
    `(() => {
      const el = document.querySelector('.timeline-row[data-order-id="q1"] .timeline-bar');
      el.focus();
      return document.activeElement === el;
    })()`,
  );
  await sleep(250);
  const tipKeyboard = await readTip();
  check(
    "键盘聚焦区间条也能看到日期提示",
    Boolean(tipKeyboard) && tipKeyboard.text.includes("开始日期：2026-11-04"),
    tipKeyboard?.text ?? "没有出现提示",
  );
  const shotKeyboard = await shot(send, "06-键盘聚焦提示.png", false);
  await evaluate(send, `(() => { document.activeElement.blur(); return true; })()`);
  await sleep(200);
  const tipBlur = await evaluate(send, `Boolean(document.querySelector(".timeline-tip"))`);
  check("失焦后提示消失", tipBlur === false, `tip 存在=${tipBlur}`);

  results.screenshots.tip = { hover: shotTip, mark: shotMark, keyboard: shotKeyboard };

  // ---------------- D：订单跳转目标（浏览器侧只验 href 与 ID 对应关系）
  // 真点击跳转由组件测试覆盖：本脚本的夹具只喂工作台需要的命令，
  // 直接进 /orders 会因缺少订单页数据回退，不能拿它当"跳转失败"。
  const navTargets = await evaluate(
    send,
    `(() => {
      // 信息列和轨道是两个兄弟容器，链接在 .timeline-info-col 里
      const scheduled = [...document.querySelectorAll(".timeline-info[data-order-id]")].map((link) => ({
        id: link.dataset.orderId,
        href: link.getAttribute("href"),
        title: link.getAttribute("title"),
        text: (link.querySelector(".timeline-title")?.textContent || "").slice(0, 12),
      }));
      const unscheduled = [...document.querySelectorAll(".timeline-unscheduled a")].map((a) => ({
        href: a.getAttribute("href"),
        text: (a.textContent || "").trim().slice(0, 40),
      }));
      return { scheduled, unscheduled };
    })()`,
  );
  results.measurements.navigation = navTargets;

  check(
    "每条轨道行都指向 /orders?orderId=<自身 id>",
    navTargets.scheduled.length > 0 &&
      navTargets.scheduled.every((row) => row.href === `/orders?orderId=${row.id}`),
    navTargets.scheduled.map((r) => r.href).join(" | "),
  );
  check(
    "完全未排期订单同样有可跳转链接且带真实 id",
    navTargets.unscheduled.length > 0 &&
      navTargets.unscheduled.every((row) => /^\/orders\?orderId=[^&]+$/.test(row.href || "")),
    navTargets.unscheduled.map((r) => `${r.text} → ${r.href}`).join(" | "),
  );
  check(
    "跳转用的是订单 id 而不是编号",
    navTargets.scheduled.every((row) => !(row.href || "").includes("AF-")) &&
      navTargets.unscheduled.every((row) => !(row.href || "").includes("AF-")),
    `行 id 示例：${navTargets.scheduled[0]?.id ?? "-"}`,
  );

  // 提示不能吃鼠标事件，也不能改变排期图形本身的命中目标。
  // 真实跳转由组件测试覆盖（jsdom + MemoryRouter）：本脚本的夹具只喂了工作台
  // 需要的命令，直接导航到 /orders 会因缺少订单页数据而回退，不能当作产品缺陷。
  const hit = await evaluate(
    send,
    `(() => {
      const bar = document.querySelector('.timeline-row[data-order-id="q1"] .timeline-bar');
      const b = bar.getBoundingClientRect();
      const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return {
        hitSelf: el === bar,
        hitClass: el ? el.className : null,
        tipPointerEvents: (() => {
          const tip = document.querySelector(".timeline-tip");
          return tip ? getComputedStyle(tip).pointerEvents : null;
        })(),
      };
    })()`,
  );
  check(
    "排期图形自身仍在鼠标命中链上（提示不吃点击）",
    hit.hitSelf === true,
    `elementFromPoint=${hit.hitClass}`,
  );

  // ---------------- U7-B：失焦/重新获得焦点后的重取（用真实调用计数，不靠推断）
  const countList = `window.__AUTOQA_CALLS__.filter((c) => c === "list_orders").length`;
  const lo0 = await evaluate(send, countList);
  await evaluate(send, `window.dispatchEvent(new Event("focus")); true`);
  await sleep(400);
  const lo1 = await evaluate(send, countList);
  check("重新获得焦点会重新请求订单", lo1 === lo0 + 1, `list_orders ${lo0} → ${lo1}`);

  await evaluate(send, `window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("focus")); true`);
  await sleep(500);
  const lo2 = await evaluate(send, countList);
  const focusRows = await evaluate(
    send,
    `(() => {
      const ids = [...document.querySelectorAll(".timeline-row")].map((el) => el.dataset.orderId);
      return { ids, unique: new Set(ids).size, len: ids.length };
    })()`,
  );
  check("连续两次焦点切换各触发一次请求（无合并假象）", lo2 === lo1 + 2, `list_orders ${lo1} → ${lo2}`);
  check(
    "连续焦点切换后订单行没有重复",
    focusRows.len === focusRows.unique && focusRows.len === before.rowCount,
    `行 ${focusRows.len} / 去重 ${focusRows.unique} / 滚动前 ${before.rowCount}`,
  );

  // ---------------- U7-C：主动刷新（尺度、终态开关、滚动位置、行数）
  await evaluate(
    send,
    `(() => {
      const btn = [...document.querySelectorAll(".segmented button")].find((b) => (b.textContent || "").trim() === "周");
      if (btn) btn.click();
      return Boolean(btn);
    })()`,
  );
  await sleep(350);
  await evaluate(send, `(() => { document.querySelector(".timeline-scroll").scrollLeft = 250; })()`);
  await sleep(250);
  const preRefresh = await evaluate(
    send,
    `(() => {
      const scroller = document.querySelector(".timeline-scroll");
      return {
        scrollLeft: Math.round(scroller.scrollLeft),
        pressed: [...document.querySelectorAll(".segmented button")].find((b) => b.getAttribute("aria-pressed") === "true")?.textContent?.trim() ?? null,
        terminal: document.querySelector(".timeline-toggle input")?.checked ?? null,
        rows: document.querySelectorAll(".timeline-row").length,
        canvasWidth: Math.round(document.querySelector(".timeline-canvas").getBoundingClientRect().width),
      };
    })()`,
  );
  const lo3 = await evaluate(send, countList);
  await evaluate(send, `(() => { document.querySelector(".timeline-refresh").click(); return true; })()`);
  await sleep(600);
  const postRefresh = await evaluate(
    send,
    `(() => {
      const scroller = document.querySelector(".timeline-scroll");
      return {
        scrollLeft: Math.round(scroller.scrollLeft),
        pressed: [...document.querySelectorAll(".segmented button")].find((b) => b.getAttribute("aria-pressed") === "true")?.textContent?.trim() ?? null,
        terminal: document.querySelector(".timeline-toggle input")?.checked ?? null,
        rows: document.querySelectorAll(".timeline-row").length,
        canvasWidth: Math.round(document.querySelector(".timeline-canvas").getBoundingClientRect().width),
      };
    })()`,
  );
  const lo4 = await evaluate(send, countList);
  const shotRefresh = await shot(send, "03-容器900-刷新后.png");
  results.measurements.refresh = { preRefresh, postRefresh, calls: { before: lo3, after: lo4 } };
  results.screenshots.refresh = shotRefresh;

  check("主动刷新会重新请求订单", lo4 === lo3 + 1, `list_orders ${lo3} → ${lo4}`);
  check("刷新不重置时间尺度", postRefresh.pressed === preRefresh.pressed, `${preRefresh.pressed} → ${postRefresh.pressed}`);
  check("刷新不重置终态开关", postRefresh.terminal === preRefresh.terminal, `${preRefresh.terminal} → ${postRefresh.terminal}`);
  check(
    "刷新后订单行数不变（无重复插入）",
    postRefresh.rows === preRefresh.rows,
    `${preRefresh.rows} → ${postRefresh.rows}`,
  );
  // 规格 §9 只写了"进入工作台 / 重新获得焦点 / 点刷新时重取"，没有承诺保留横向位置。
  // 实测会重新把今天放到视口 45%，所以这里记为行为差异而不是门禁。
  observe(
    "刷新会重置横向滚动位置（规格未承诺保留）",
    `scrollLeft ${preRefresh.scrollLeft} → ${postRefresh.scrollLeft}`,
    "刷新成功后 setOrders 触发 [orders] 副作用 setCenterOn(today)，轨道被重新居中到今天",
  );

  // 焦点重取走同一条 load()，顺带确认是否同样重置。
  await evaluate(send, `(() => { document.querySelector(".timeline-scroll").scrollLeft = 250; })()`);
  await sleep(200);
  const focusBefore = await evaluate(send, `Math.round(document.querySelector(".timeline-scroll").scrollLeft)`);
  await evaluate(send, `window.dispatchEvent(new Event("focus")); true`);
  await sleep(500);
  const focusAfter = await evaluate(send, `Math.round(document.querySelector(".timeline-scroll").scrollLeft)`);
  observe(
    "重新获得焦点同样会重置横向滚动位置",
    `scrollLeft ${focusBefore} → ${focusAfter}`,
    "与刷新共用 load()，行为一致",
  );

  const failed = results.checks.filter((c) => !c.pass);
  results.summary = { total: results.checks.length, passed: results.checks.length - failed.length, failed: failed.length };
  console.log(JSON.stringify(results, null, 2));

  client.close();
  cleanup(failed.length === 0 ? 0 : 2);
}

main().catch((error) => {
  console.error(error);
  cleanup(1);
});
