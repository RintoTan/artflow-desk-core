#!/usr/bin/env node
/**
 * CAL-QA-01：50 笔虚构订单的日历压力与可用性取证。
 *
 * 数据只存在于浏览器内存夹具里：
 *   - 不写任何数据库（正式库 / QA 库都不写）
 *   - 不覆盖 qa_dataset 的固定场景
 *   - 每次运行重新生成，进程退出即消失，无需清理
 *
 * 用法：node scripts/calendar-stress.mjs [url]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.argv[2] ?? "http://127.0.0.1:1425/";
const PORT = Number(process.env.STRESS_PORT ?? 9601);
const WIDTH = Number(process.env.STRESS_WIDTH ?? 1400);
const HEIGHT = Number(process.env.STRESS_HEIGHT ?? 1100);
const SHOTS = process.env.STRESS_SHOT_DIR ?? "/tmp/calendar-stress";

/** 固定种子，保证每次生成同一批数据（可复现）。 */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const rand = rng(20261119);
const pick = (list) => list[Math.floor(rand() * list.length)];

const CLIENTS = [
  "林小满", "苏叶", "阿岚", "青禾", "沈知夏", "白鹭", "陶陶", "雾岛",
  "程一", "南星", "柳月", "顾川", "温言", "许拾", "安柏", "叶迟",
];
const TYPES = [
  "角色头像", "半身立绘", "全身立绘", "双人组合图", "表情包", "角色设计",
  "服装设计", "插画委托", "简单修图", "商业委托",
];
const SOURCES = ["画加", "米画师", "微博", "老客户", "站酷", "朋友介绍"];
const AMOUNTS = [8800, 16800, 28800, 48000, 68000, 98000, 128000, 188000];

const DAY = 86400000;
const base = Date.UTC(2026, 0, 1);
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (ms, n) => ms + n * DAY;

function makeOrder(index, spec) {
  return {
    id: `stress-${String(index).padStart(2, "0")}`,
    code: `AF-2026-${String(index).padStart(4, "0")}`,
    title: `${spec.type}·${spec.note}`,
    clientId: `stress-c-${spec.clientIndex}`,
    clientName: spec.client,
    commissionType: spec.type,
    stageTemplateId: "tpl-stress",
    source: spec.source,
    amountCents: spec.amount,
    note: null,
    status: spec.status,
    workState:
      spec.status === "complete"
        ? "completed"
        : spec.status === "cancelled"
          ? "cancelled"
          : spec.status === "active" && spec.started
            ? "inProgress"
            : "queued",
    currentStageId: "s1",
    currentStageTitle: "草稿",
    currentStageIndex: 0,
    stageCount: 5,
    stages: [],
    queuePosition: index,
    plannedStartDate: spec.start,
    plannedDeliveryDate: spec.delivery,
    deadlineState: spec.deadline,
    startedAt: spec.started ? "2026-01-02T00:00:00.000Z" : null,
    completedAt: spec.status === "complete" ? "2026-06-01T00:00:00.000Z" : null,
    cancelledAt: spec.status === "cancelled" ? "2026-06-02T00:00:00.000Z" : null,
    revision: 1,
    createdAt: new Date(base + index * 3600_000).toISOString(),
    updatedAt: new Date(base + index * 3600_000).toISOString(),
    capabilities: {
      canStartWork: spec.status === "active" && !spec.started,
      canUndoStartWork: false,
      undoBlockedReason: null,
      canAdvance: spec.status === "active",
      canRework: spec.status === "active",
      canComplete: false,
      canCancel: spec.status === "active",
      canReopen: spec.status === "complete",
      canEditWorkflow: true,
    },
  };
}

/** 50 笔：15 完成 / 5 取消 / 10 制作中 / 10 排队 / 10 未排期。 */
function buildOrders() {
  const out = [];
  const specs = [];
  let day = 2; // 2026-01-03 起

  // 15 已完成：1–8 月的历史，含跨月与单日
  for (let i = 0; i < 15; i += 1) {
    const start = addDays(base, day + i * 9);
    const span = pick([0, 2, 3, 5, 9, 14]);
    specs.push({
      status: "complete",
      start: iso(start),
      delivery: iso(addDays(start, span)),
      deadline: "scheduled",
    });
    day += 1;
  }
  // 5 已取消：含 2 笔未排期
  for (let i = 0; i < 5; i += 1) {
    const start = addDays(base, 120 + i * 11);
    const hasDates = i < 3;
    specs.push({
      status: "cancelled",
      start: hasDates ? iso(start) : null,
      delivery: hasDates ? iso(addDays(start, 4)) : null,
      deadline: "scheduled",
    });
  }
  // 10 制作中：9–11 月，彼此有重叠
  for (let i = 0; i < 10; i += 1) {
    const start = addDays(base, 245 + i * 5);
    specs.push({
      status: "active",
      started: true,
      start: iso(start),
      delivery: iso(addDays(start, pick([1, 3, 6, 10]))),
      deadline: pick(["scheduled", "dueSoon", "overdue", "dueToday"]),
    });
  }
  // 10 排队：11 月下旬–12 月，未来排期；其中 2 笔同一天
  for (let i = 0; i < 10; i += 1) {
    const start = addDays(base, 320 + i * 3);
    specs.push({
      status: "active",
      started: false,
      start: iso(start),
      delivery: iso(addDays(start, pick([0, 2, 4, 7]))),
      deadline: i < 3 ? "dueSoon" : "scheduled",
    });
  }
  // 10 未排期
  for (let i = 0; i < 10; i += 1) {
    specs.push({ status: "active", started: false, start: null, delivery: null, deadline: "scheduled" });
  }

  // 制造拥挤：把排队里 4 笔压到同一天（2026-11-20）交付，制造 +N
  const crowdDay = "2026-11-20";
  specs.slice(25, 29).forEach((spec) => {
    spec.start = "2026-11-18";
    spec.delivery = crowdDay;
  });
  // 3 笔同日开始（2026-11-24）
  specs.slice(29, 32).forEach((spec) => {
    spec.start = "2026-11-24";
    spec.delivery = "2026-11-28";
  });
  // 一笔跨年长单
  specs[24] = { ...specs[24], start: "2026-12-20", delivery: "2027-01-06" };
  // 单端日期：2 笔只有开始、2 笔只有交付
  specs[33] = { ...specs[33], delivery: null };
  specs[34] = { ...specs[34], delivery: null };
  specs[35] = { ...specs[35], start: null };
  specs[36] = { ...specs[36], start: null };

  specs.forEach((spec, i) => {
    const clientIndex = Math.floor(rand() * CLIENTS.length);
    out.push(
      makeOrder(i + 1, {
        ...spec,
        clientIndex,
        client: CLIENTS[clientIndex],
        type: TYPES[i % TYPES.length],
        source: pick(SOURCES),
        amount: AMOUNTS[Math.floor(rand() * AMOUNTS.length)],
        note: `${["A", "B", "C", "D", "E"][i % 5]} 稿${i + 1}`,
      }),
    );
  });
  return out;
}

const ORDERS = buildOrders();
const activeCount = ORDERS.filter((o) => o.status === "active").length;
const terminalCount = ORDERS.length - activeCount;

const fixtures = {
  environment_status: {
    appVersion: "0.1.0", firstRun: false, generation: "gen-stress", schemaVersion: 6,
    upgradedFrom: null, rootPath: "/tmp/stress", qaMode: true, qaScenario: "calendar-stress",
    sqliteVersion: "3.54.1", journalMode: "wal", workingTimezone: "Asia/Shanghai",
    systemTimezone: "Asia/Shanghai", lockHeld: true, orders: ORDERS.length, clients: 16,
    templates: 1, attachments: 0, pendingCleanup: 0, highWater: [], integrity: "ok",
  },
  ui_theme_get: { mode: "arctic", accent: null, storedMode: null },
  ui_icon_get: { variant: "orbit", storedVariant: null, defaultVariant: "orbit" },
  list_clients: [],
  list_orders: ORDERS,
};

const mock = `(() => {
  window.__CALLS__ = [];
  const table = ${JSON.stringify(fixtures)};
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      window.__CALLS__.push({ cmd, args, t: performance.now() });
      const v = table[cmd];
      if (v === undefined) return null;
      return JSON.parse(JSON.stringify(v));
    },
    transformCallback: (cb) => cb,
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  };
  window.isTauri = true;
})();`;

const profile = mkdtempSync(join(tmpdir(), "stress-"));
mkdirSync(SHOTS, { recursive: true });
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  `--window-size=${WIDTH},${HEIGHT}`, "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--force-device-scale-factor=1", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((x) => x.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* 未就绪 */ }
    await sleep(250);
  }
  throw new Error("Chrome 调试端口没有就绪");
}

function rpc(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  const ready = new Promise((res, rej) => {
    socket.addEventListener("open", res, { once: true });
    socket.addEventListener("error", rej, { once: true });
  });
  socket.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  });
  return {
    ready,
    send: (method, params = {}) =>
      new Promise((res, rej) => {
        id += 1;
        pending.set(id, { resolve: res, reject: rej });
        socket.send(JSON.stringify({ id, method, params }));
      }),
    close: () => socket.close(),
  };
}

function cleanup(code) {
  try { chrome.kill("SIGKILL"); } catch { /* ignore */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(code);
}

const results = { width: WIDTH, orders: ORDERS.length, checks: [], measurements: {} };
const check = (name, pass, detail) => results.checks.push({ name, pass, detail });
const evaluate = async (send, expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result?.value;
};
const shot = async (send, name, beyond = false) => {
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: beyond });
  const p = join(SHOTS, name);
  writeFileSync(p, Buffer.from(r.data, "base64"));
  return p;
};

async function main() {
  const client = rpc(await wsUrl());
  await client.ready;
  const { send } = client;
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: mock });

  const t0 = Date.now();
  await send("Page.navigate", { url: `${BASE}#/calendar` });
  let ready = false;
  for (let i = 0; i < 120; i += 1) {
    await sleep(200);
    ready = await evaluate(send, `Boolean(document.querySelector(".cal-chip")?.closest(".cal-week"))`);
    if (ready) break;
  }
  const loadMs = Date.now() - t0;
  if (!ready) { console.error("日历未渲染"); client.close(); cleanup(1); }
  await sleep(400);

  const base = await evaluate(send, `(() => {
    const grid = document.querySelector(".cal-grid");
    const chips = [...document.querySelectorAll(".cal-chip")];
    return {
      loadMs: ${loadMs},
      domNodes: document.getElementsByTagName("*").length,
      chips: chips.length,
      uniqOrders: new Set(chips.map((c) => c.getAttribute("data-order-id"))).size,
      moreButtons: document.querySelectorAll(".cal-more").length,
      moreText: [...document.querySelectorAll(".cal-more")].map((b) => b.textContent),
      poolItems: document.querySelectorAll(".cal-pool-item").length,
      gridTop: Math.round(grid.getBoundingClientRect().top),
      pageScrollWidth: document.documentElement.scrollWidth,
      pageClientWidth: document.documentElement.clientWidth,
      terminalChips: chips.filter((c) => c.className.includes("is-terminal")).length,
    };
  })()`);
  results.measurements.default = base;
  const shotDefault = await shot(send, "01-50单-默认.png", true);

  check("50 笔订单全部载入", base.uniqOrders <= 50 && base.chips > 0, `chips=${base.chips} uniq=${base.uniqOrders}`);
  check("默认不渲染终态 chip", base.terminalChips === 0, `terminal=${base.terminalChips}`);
  check("未排期池列出 10 笔活动未排期", base.poolItems >= 10, `pool=${base.poolItems}`);
  check("同日拥挤触发 +N", base.moreButtons > 0, `${base.moreButtons} 个：${base.moreText.join(" ")}`);
  check("页面无横向溢出", base.pageScrollWidth <= base.pageClientWidth + 1, `${base.pageScrollWidth}/${base.pageClientWidth}`);
  check("首屏渲染 < 2.5s", base.loadMs < 2500, `${base.loadMs}ms`);

  // 翻到 2026 年 1 月（历史已完成订单所在月份）再验证终态显示
  await evaluate(send, `(async () => {
    for (let i = 0; i < 10; i += 1) {
      [...document.querySelectorAll(".cal-nav button")].find((b) => (b.getAttribute("aria-label") || "") === "上一段").click();
      await new Promise((r) => setTimeout(r, 40));
    }
    return document.querySelector(".cal-title")?.textContent ?? "";
  })()`);
  await sleep(300);
  const january = await evaluate(send, `(() => ({
    title: document.querySelector(".cal-title")?.textContent ?? "",
    chips: document.querySelectorAll(".cal-chip").length,
  }))()`);
  results.measurements.january = january;

  // 开启显示已结束
  const tToggle = await evaluate(send, `(async () => {
    const box = document.querySelector(".cal-toggle input");
    const t = performance.now();
    box.click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { ms: Math.round(performance.now() - t) };
  })()`);
  await sleep(300);
  const withTerminal = await evaluate(send, `(() => {
    const chips = [...document.querySelectorAll(".cal-chip")];
    return {
      ms: ${tToggle.ms},
      chips: chips.length,
      terminalChips: chips.filter((c) => c.className.includes("is-terminal")).length,
      uniqOrders: new Set(chips.map((c) => c.getAttribute("data-order-id"))).size,
      domNodes: document.getElementsByTagName("*").length,
      pageScrollWidth: document.documentElement.scrollWidth,
      pageClientWidth: document.documentElement.clientWidth,
      poolItems: document.querySelectorAll(".cal-pool-item").length,
      historySection: Boolean([...document.querySelectorAll("h3")].find((h) => h.textContent.includes("已结束且未排期"))),
    };
  })()`);
  results.measurements.withTerminal = withTerminal;
  const shotTerminal = await shot(send, "02-50单-显示已结束.png", true);

  check(
    "开启后 1 月的终态订单出现（且不与活动订单抢轨道）",
    withTerminal.terminalChips > 0,
    `月份 ${january.title} / 开启前 ${january.chips} chip → 开启后 ${withTerminal.chips} chip（其中终态 ${withTerminal.terminalChips}）`,
  );
  check("开启后加载仍无横向溢出", withTerminal.pageScrollWidth <= withTerminal.pageClientWidth + 1, `${withTerminal.pageScrollWidth}/${withTerminal.pageClientWidth}`);
  check("切换耗时 < 200ms", withTerminal.ms < 200, `${withTerminal.ms}ms`);
  check("出现「已结束且未排期」历史分区", withTerminal.historySection === true, String(withTerminal.historySection));

  // 回到 2026 年 11 月（拥挤月份）再验 +N
  await evaluate(send, `(async () => {
    for (let i = 0; i < 10; i += 1) {
      [...document.querySelectorAll(".cal-nav button")].find((b) => (b.getAttribute("aria-label") || "") === "下一段").click();
      await new Promise((r) => setTimeout(r, 40));
    }
    return document.querySelector(".cal-title")?.textContent ?? "";
  })()`);
  await sleep(250);

  // +N 浮层：可滚动、在视口内、每单有入口
  const popover = await evaluate(send, `(async () => {
    const more = [...document.querySelectorAll(".cal-more")].sort((a, b) => Number(b.textContent.slice(1)) - Number(a.textContent.slice(1)))[0];
    if (!more) return { ok: false };
    more.click();
    await new Promise((r) => setTimeout(r, 150));
    const el = document.querySelector(".cal-popover");
    if (!el) return { ok: false };
    const b = el.getBoundingClientRect();
    return {
      ok: true,
      items: el.querySelectorAll("li").length,
      rescheduleButtons: [...el.querySelectorAll("button")].filter((x) => x.textContent.trim() === "改期").length,
      inViewport: b.left >= 0 && b.top >= 0 && b.right <= window.innerWidth && b.bottom <= window.innerHeight,
      scrollable: el.scrollHeight > el.clientHeight,
      text: el.textContent.slice(0, 80),
    };
  })()`);
  results.measurements.popover = popover;
  const shotPopover = await shot(send, "03-折叠浮层.png", false);
  check("浮层列出折叠订单", popover.ok === true && popover.items > 0, JSON.stringify(popover).slice(0, 120));
  check("浮层内每单都有改期入口", popover.rescheduleButtons === popover.items, `${popover.rescheduleButtons}/${popover.items}`);
  check("浮层不超出视口", popover.inViewport === true, `inViewport=${popover.inViewport}`);

  // 关闭浮层，切周视图
  await evaluate(send, `document.querySelector(".cal-popover header button")?.click()`);
  const weekMs = await evaluate(send, `(async () => {
    const t = performance.now();
    [...document.querySelectorAll(".cal-views button")].find((b) => b.textContent.trim() === "周").click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return Math.round(performance.now() - t);
  })()`);
  await sleep(300);
  const week = await evaluate(send, `(() => ({
    cells: document.querySelectorAll(".cal-day-bg").length,
    chips: document.querySelectorAll(".cal-chip").length,
    pageScrollWidth: document.documentElement.scrollWidth,
    pageClientWidth: document.documentElement.clientWidth,
  }))()`);
  results.measurements.week = { ms: weekMs, ...week };
  const shotWeek = await shot(send, "04-50单-周视图.png", false);
  check("周视图 7 列", week.cells === 7, `cells=${week.cells}`);
  check("周视图切换 < 200ms", weekMs < 200, `${weekMs}ms`);
  check("周视图无横向溢出", week.pageScrollWidth <= week.pageClientWidth + 1, `${week.pageScrollWidth}/${week.pageClientWidth}`);

  results.screenshots = { default: shotDefault, terminal: shotTerminal, popover: shotPopover, week: shotWeek };
  results.distribution = {
    total: ORDERS.length,
    active: activeCount,
    terminal: terminalCount,
    未排期: ORDERS.filter((o) => !o.plannedStartDate && !o.plannedDeliveryDate).length,
    单日: ORDERS.filter((o) => o.plannedStartDate && o.plannedStartDate === o.plannedDeliveryDate).length,
    跨月: ORDERS.filter((o) => o.plannedStartDate && o.plannedDeliveryDate && o.plannedStartDate.slice(0, 7) !== o.plannedDeliveryDate.slice(0, 7)).length,
    仅开始: ORDERS.filter((o) => o.plannedStartDate && !o.plannedDeliveryDate).length,
    仅交付: ORDERS.filter((o) => !o.plannedStartDate && o.plannedDeliveryDate).length,
  };

  const failed = results.checks.filter((c) => !c.pass);
  results.summary = { total: results.checks.length, passed: results.checks.length - failed.length, failed: failed.length };
  console.log(JSON.stringify(results, null, 2));
  client.close();
  cleanup(failed.length === 0 ? 0 : 2);
}

main().catch((e) => { console.error(e); cleanup(1); });
