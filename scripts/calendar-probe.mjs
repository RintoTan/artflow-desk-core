#!/usr/bin/env node
/**
 * 日历（DEV-06D-3）真实浏览器几何与交互取证。
 *
 * 用 Vite 页面 + 假 IPC 夹具跑真实 Chromium：
 *   - 月视图 6×7 网格、周视图 7 列、无页面横向溢出
 *   - 轨道分配与 +N 折叠
 *   - 拖放预览 → 确认框（取消零写入）
 *   - 未排期池改期入口
 *
 * 结论仅代表 Blink，不代表 WKWebView / WebView2。
 *
 * 用法：node scripts/calendar-probe.mjs [url]   （默认 http://127.0.0.1:1425/）
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.argv[2] ?? "http://127.0.0.1:1425/";
const PORT = Number(process.env.CAL_PROBE_PORT ?? 9551);
const WIDTH = Number(process.env.CAL_PROBE_WIDTH ?? 1400);
const HEIGHT = Number(process.env.CAL_PROBE_HEIGHT ?? 1000);
const SHOTS = process.env.CAL_PROBE_SHOT_DIR ?? "/tmp/calendar-probe";

function order(id, code, title, start, delivery, extra = {}) {
  return {
    id,
    code,
    title,
    clientId: "c1",
    clientName: "林小满",
    commissionType: "半身立绘",
    stageTemplateId: "tpl",
    source: "画加",
    amountCents: 120000,
    note: null,
    status: "active",
    workState: "queued",
    currentStageId: "s1",
    currentStageTitle: "草稿",
    currentStageIndex: 0,
    stageCount: 5,
    stages: [],
    queuePosition: 1,
    plannedStartDate: start,
    plannedDeliveryDate: delivery,
    deadlineState: "scheduled",
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    revision: 1,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    capabilities: {
      canStartWork: true,
      canUndoStartWork: false,
      undoBlockedReason: null,
      canAdvance: false,
      canRework: false,
      canComplete: false,
      canCancel: true,
      canReopen: false,
      canEditWorkflow: true,
    },
    ...extra,
  };
}

const ORDERS = [
  order("a1", "AF-2026-0001", "十一月区间订单", "2026-11-10", "2026-11-16"),
  order("a2", "AF-2026-0002", "单日交付订单", "2026-11-18", "2026-11-18", { deadlineState: "dueToday" }),
  order("a3", "AF-2026-0003", "只有开始日期", "2026-11-12", null),
  order("a4", "AF-2026-0004", "只有交付日期", null, "2026-11-24", { deadlineState: "dueSoon" }),
  order("a5", "AF-2026-0005", "已逾期订单", "2026-11-02", "2026-11-05", { deadlineState: "overdue" }),
  order("a6", "AF-2026-0006", "跨月长订单", "2026-11-26", "2026-12-08"),
  order("n1", "AF-2026-0007", "完全未排期订单", null, null),
  order("n2", "AF-2026-0008", "另一个未排期", null, null),
  order("t1", "AF-2026-0009", "已完成订单", "2026-11-14", "2026-11-15", {
    status: "complete",
    workState: "completed",
    deadlineState: "scheduled",
    completedAt: "2026-11-16T00:00:00.000Z",
  }),
  order("t2", "AF-2026-0010", "已取消且未排期", null, null, {
    status: "cancelled",
    workState: "cancelled",
  }),
  // 同一天扎堆，用来触发 +N
  ...["11", "12", "13", "14"].map((n) =>
    order(`c${n}`, `AF-2026-00${n}`, `同日订单 ${n}`, "2026-11-20", "2026-11-20"),
  ),
];

const fixtures = {
  environment_status: {
    appVersion: "0.1.0",
    firstRun: false,
    generation: "gen-cal",
    schemaVersion: 6,
    upgradedFrom: null,
    rootPath: "/tmp/cal",
    qaMode: true,
    qaScenario: "calendar-probe",
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
  list_clients: [{ id: "c1", displayName: "林小满", contact: null, note: null, orderCount: ORDERS.length, createdAt: "2026-11-01T00:00:00.000Z" }],
  list_orders: ORDERS,
  update_order_details: ORDERS[0],
};

const mock = `(() => {
  window.__CALLS__ = [];
  const table = ${JSON.stringify(fixtures)};
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      window.__CALLS__.push({ cmd, args });
      const value = table[cmd];
      if (value === undefined) return null;
      return JSON.parse(JSON.stringify(value));
    },
    transformCallback: (cb) => cb,
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  };
  window.isTauri = true;
})();`;

const profile = mkdtempSync(join(tmpdir(), "cal-probe-"));
mkdirSync(SHOTS, { recursive: true });
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--force-device-scale-factor=1",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((item) => item.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* 端口未就绪 */
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

const results = { width: WIDTH, checks: [], measurements: {} };
const check = (name, pass, detail) => results.checks.push({ name, pass, detail });
const observe = (name, value, note) => (results.observations ??= []).push({ name, value, note });

async function evaluate(send, expression) {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
  return res.result?.value;
}

async function shot(send, name, beyond = true) {
  const res = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: beyond });
  const path = join(SHOTS, name);
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
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: mock });
  await send("Page.navigate", { url: `${BASE}#/calendar` });

  let ready = false;
  for (let i = 0; i < 80; i += 1) {
    await sleep(250);
    ready = await evaluate(send, `Boolean(document.querySelector(".cal-grid"))`);
    if (ready) break;
  }
  if (!ready) {
    const text = await evaluate(send, `document.body.innerText.slice(0, 400)`);
    console.error("日历没有渲染：", text);
    client.close();
    cleanup(1);
  }
  await sleep(500);

  const month = await evaluate(
    send,
    `(() => {
      const grid = document.querySelector(".cal-grid");
      const weeks = [...document.querySelectorAll(".cal-week")];
      const cells = [...document.querySelectorAll(".cal-day-bg")];
      const chips = [...document.querySelectorAll(".cal-chip")];
      const more = [...document.querySelectorAll(".cal-more")];
      const pool = document.querySelector(".cal-pool");
      const main = document.querySelector(".cal-main");
      const firstChip = chips[0];
      const firstChipBox = firstChip ? firstChip.getBoundingClientRect() : null;
      return {
        gridWidth: Math.round(grid.getBoundingClientRect().width),
        gridHeight: Math.round(grid.getBoundingClientRect().height),
        weeks: weeks.length,
        weekHeights: weeks.map((el) => Math.round(el.getBoundingClientRect().height)),
        gridBottom: Math.round(grid.getBoundingClientRect().bottom),
        mainBottom: main ? Math.round(main.getBoundingClientRect().bottom) : null,
        cells: cells.length,
        chips: chips.length,
        moreButtons: more.length,
        moreLabels: more.map((el) => el.textContent),
        poolWidth: pool ? Math.round(pool.getBoundingClientRect().width) : null,
        mainWidth: main ? Math.round(main.getBoundingClientRect().width) : null,
        pageScrollWidth: document.documentElement.scrollWidth,
        pageClientWidth: document.documentElement.clientWidth,
        firstChip: firstChipBox
          ? { left: Math.round(firstChipBox.left), width: Math.round(firstChipBox.width), height: Math.round(firstChipBox.height) }
          : null,
        chipKinds: chips.map((el) => el.getAttribute("data-kind")),
        callCount: window.__CALLS__.filter((c) => c.cmd === "update_order_details").length,
        title: document.querySelector(".cal-title")?.textContent ?? null,
      };
    })()`,
  );
  results.measurements.month = month;

  check("月视图 6 行", month.weeks === 6, `weeks=${month.weeks}`);
  check("月视图 42 格", month.cells === 42, `cells=${month.cells}`);
  check("页面无横向溢出", month.pageScrollWidth <= month.pageClientWidth + 1, `${month.pageScrollWidth}/${month.pageClientWidth}`);
  check("左侧未排期池存在且宽度合理", month.poolWidth >= 150 && month.poolWidth <= 320, `pool=${month.poolWidth}`);
  check("同日 4 单触发 +N 折叠", month.moreButtons > 0 && month.moreLabels.some((t) => t === "+1"), JSON.stringify(month.moreLabels));
  check(
    "四种日期形状都画出来了",
    ["range", "single", "startOnly", "deliveryOnly"].every((k) => month.chipKinds.includes(k)),
    JSON.stringify([...new Set(month.chipKinds)]),
  );
  const shotMonth = await shot(send, "01-月视图.png");

  // 周视图
  await evaluate(send, `[...document.querySelectorAll(".cal-views button")].find((b) => b.textContent.trim() === "周").click()`);
  await sleep(400);
  const week = await evaluate(
    send,
    `(() => {
      const cells = [...document.querySelectorAll(".cal-day-bg")];
      return {
        weeks: document.querySelectorAll(".cal-week").length,
        cells: cells.length,
        title: document.querySelector(".cal-title")?.textContent ?? null,
        chipCount: document.querySelectorAll(".cal-chip").length,
        pageScrollWidth: document.documentElement.scrollWidth,
        pageClientWidth: document.documentElement.clientWidth,
      };
    })()`,
  );
  results.measurements.week = week;
  check("周视图 1 行 7 列", week.weeks === 1 && week.cells === 7, `${week.weeks}×${week.cells}`);
  check("周视图保留当前浏览日期", typeof week.title === "string" && week.title.includes("~"), week.title ?? "");
  const shotWeek = await shot(send, "02-周视图.png");

  // 回到月视图，模拟拖放：把 a1 的条身拖到 11-20 那一格
  await evaluate(send, `[...document.querySelectorAll(".cal-views button")].find((b) => b.textContent.trim() === "月").click()`);
  await sleep(300);

  const HELPERS = `
      const chip = document.querySelector('.cal-chip[data-order-id="a1"]');
      const cellByText = (text) =>
        [...document.querySelectorAll(".cal-day-num")].find((el) => el.textContent.trim() === text);
      const bgOf = (numEl) => {
        const col = Number(getComputedStyle(numEl).gridColumnStart);
        return numEl.parentElement ? [...numEl.parentElement.querySelectorAll(".cal-day-bg")][col - 1] : null;
      };
      const opts = (x, y) => ({ bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true });
      const snapshot = () => ({
        hint: document.querySelector(".cal-drag-status")?.textContent ?? "",
        invalid: Boolean(document.querySelector(".cal-drag-status.is-invalid")),
        ghost: Boolean(chip && chip.className.includes("is-ghost")),
        previews: [...document.querySelectorAll(".cal-preview")].map((el) => ({
          width: Math.round(el.getBoundingClientRect().width),
          valid: el.getAttribute("data-valid"),
          invalidStyle: el.className.includes("is-invalid"),
        })),
        writes: window.__CALLS__.filter((c) => c.cmd === "update_order_details").length,
      });
  `;

  const gridBefore = await evaluate(
    send,
    `(() => { const g = document.querySelector(".cal-grid").getBoundingClientRect();
      return { top: Math.round(g.top), left: Math.round(g.left), width: Math.round(g.width), height: Math.round(g.height) }; })()`,
  );
  results.measurements.gridBefore = gridBefore;

  // 1) 合法拖动：条身 → 11-20，先停在拖动中截屏
  const dragging = await evaluate(
    send,
    `(async () => {
      ${HELPERS}
      const cell = cellByText("20");
      const bg = cell ? bgOf(cell) : null;
      if (!chip || !bg) return { ok: false, reason: "找不到 chip 或目标格" };
      const scroller = document.querySelector(".cal-main");
      if (scroller) { scroller.scrollLeft = Math.max(0, bg.offsetLeft - 60); await new Promise((r) => setTimeout(r, 120)); }
      const gridAtStart = (() => {
        const g = document.querySelector(".cal-grid").getBoundingClientRect();
        return {
          top: Math.round(g.top), left: Math.round(g.left),
          width: Math.round(g.width), height: Math.round(g.height),
          scrollLeft: Math.round(scroller ? scroller.scrollLeft : 0),
        };
      })();
      const from = chip.getBoundingClientRect();
      const to = bg.getBoundingClientRect();
      chip.dispatchEvent(new PointerEvent("pointerdown", opts(from.left + from.width / 2, from.top + from.height / 2)));
      await new Promise((r) => setTimeout(r, 60));
      window.dispatchEvent(new PointerEvent("pointermove", opts(to.left + to.width / 2, to.top + to.height / 2)));
      await new Promise((r) => setTimeout(r, 160));
      const snap = snapshot();
      snap.gridAtStart = gridAtStart;
      const week = document.querySelector(".cal-week");
      snap.weekWidth = week ? Math.round(week.getBoundingClientRect().width) : 0;
      window.__TARGET__ = { x: to.left + to.width / 2, y: to.top + to.height / 2 };
      return { ok: true, ...snap };
    })()`,
  );
  const gridDuring = await evaluate(
    send,
    `(() => { const g = document.querySelector(".cal-grid").getBoundingClientRect();
      const sc = document.querySelector(".cal-main");
      return { top: Math.round(g.top), left: Math.round(g.left), width: Math.round(g.width), height: Math.round(g.height), scrollLeft: Math.round(sc ? sc.scrollLeft : 0) }; })()`,
  );
  results.measurements.gridDuring = gridDuring;
  const gridAtStart = dragging.gridAtStart ?? null;
  check(
    "拖动期间日历网格不位移（起点=拖动中，含滚动位置）",
    gridAtStart !== null && JSON.stringify(gridAtStart) === JSON.stringify(gridDuring),
    `${JSON.stringify(gridAtStart)} → ${JSON.stringify(gridDuring)}`,
  );
  const statusBox = await evaluate(
    send,
    `(() => { const el = document.querySelector(".cal-drag-status"); if (!el) return null;
      const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      return { position: cs.position, pointerEvents: cs.pointerEvents, inViewport: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth }; })()`,
  );
  results.measurements.dragStatus = statusBox;
  check(
    "拖动状态是浮层且不吃指针",
    statusBox?.position === "absolute" && statusBox?.pointerEvents === "none" && statusBox?.inViewport === true,
    JSON.stringify(statusBox),
  );
  results.measurements.dragging = dragging;
  check("拖动时原位置保留幽灵", dragging.ghost === true, `ghost=${dragging.ghost}`);
  check(
    "拖动时目标位置有蓝色预览条",
    dragging.previews.length > 0 && dragging.previews.every((p) => p.valid === "1" && p.invalidStyle === false),
    JSON.stringify(dragging.previews),
  );
  check(
    "预览条总长度 = 改后区间天数 / 7 × 周宽（跨两周时分段）",
    dragging.previews.length > 0 &&
      Math.abs(
        dragging.previews.reduce((sum, p) => sum + p.width, 0) - dragging.weekWidth,
      ) <= 8,
    `分段 ${JSON.stringify(dragging.previews.map((p) => p.width))} 合计 / 周宽 ${dragging.weekWidth}（7 天 = 一周）`,
  );
  check(
    "拖动时显示开始/交付的 before→after",
    /开始日期/.test(dragging.hint) && /交付日期/.test(dragging.hint) && /→/.test(dragging.hint),
    dragging.hint.slice(0, 100),
  );
  const shotDragging = await shot(send, "03-拖动预览.png", false);

  // 松开 → 确认框
  const released = await evaluate(
    send,
    `(async () => {
      const t = window.__TARGET__;
      const opts = (x, y) => ({ bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true });
      window.dispatchEvent(new PointerEvent("pointerup", opts(t.x, t.y)));
      await new Promise((r) => setTimeout(r, 220));
      const dialog = document.querySelector('[role="alertdialog"]');
      return {
        ok: Boolean(dialog),
        text: dialog ? dialog.textContent.slice(0, 160) : null,
        writes: window.__CALLS__.filter((c) => c.cmd === "update_order_details").length,
      };
    })()`,
  );
  results.measurements.release = released;
  check("松开后进入确认框", released.ok === true, released.text ?? "无对话框");
  check("拖动全过程零写入", released.writes === 0, `update_order_details=${released.writes}`);
  const shotDialog = await shot(send, "04-拖放确认框.png", false);

  // 2) 非法拖动：把 a1 的「开始端」拖到 11-24（晚于交付 11-16）
  const invalidDrag = await evaluate(
    send,
    `(async () => {
      const dialog = document.querySelector('[role="alertdialog"]');
      if (dialog) {
        const cancel = [...dialog.querySelectorAll("button")].find((b) => b.textContent.trim() === "取消");
        if (cancel) cancel.click();
      }
      await new Promise((r) => setTimeout(r, 200));
      ${HELPERS}
      const cell = cellByText("24");
      const bg = cell ? bgOf(cell) : null;
      if (!chip || !bg) return { ok: false, reason: "找不到 chip 或目标格" };
      const scroller = document.querySelector(".cal-main");
      if (scroller) { scroller.scrollLeft = Math.max(0, bg.offsetLeft - 60); await new Promise((r) => setTimeout(r, 120)); }
      const from = chip.getBoundingClientRect();
      const to = bg.getBoundingClientRect();
      // 左端 → 改开始日期
      chip.dispatchEvent(new PointerEvent("pointerdown", opts(from.left + 3, from.top + from.height / 2)));
      await new Promise((r) => setTimeout(r, 60));
      window.dispatchEvent(new PointerEvent("pointermove", opts(to.left + to.width / 2, to.top + to.height / 2)));
      await new Promise((r) => setTimeout(r, 160));
      return { ok: true, ...snapshot(), target: { x: to.left + to.width / 2, y: to.top + to.height / 2 } };
    })()`,
  );
  results.measurements.invalidDrag = invalidDrag;
  check("非法拖动显示红色预览", invalidDrag.previews.length > 0 && invalidDrag.previews.every((p) => p.valid === "0" && p.invalidStyle), JSON.stringify(invalidDrag.previews));
  check("非法拖动给出原因", invalidDrag.invalid === true && /不能早于/.test(invalidDrag.hint), invalidDrag.hint.slice(0, 90));
  const shotInvalid = await shot(send, "05-非法拖动.png", false);

  // pointercancel 恢复：不进入确认框、零写入
  const cancelledByPointer = await evaluate(
    send,
    `(async () => {
      const t = ${JSON.stringify(invalidDrag.target ?? { x: 0, y: 0 })};
      window.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, clientX: t.x, clientY: t.y, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      await new Promise((r) => setTimeout(r, 220));
      return {
        dialog: Boolean(document.querySelector('[role="alertdialog"]')),
        preview: Boolean(document.querySelector(".cal-preview")),
        ghost: Boolean(document.querySelector(".cal-chip.is-ghost")),
        writes: window.__CALLS__.filter((c) => c.cmd === "update_order_details").length,
      };
    })()`,
  );
  results.measurements.pointerCancel = cancelledByPointer;
  check("pointercancel 后预览与幽灵都消失", cancelledByPointer.preview === false && cancelledByPointer.ghost === false, JSON.stringify(cancelledByPointer));
  check("pointercancel 不进入确认框、零写入", cancelledByPointer.dialog === false && cancelledByPointer.writes === 0, JSON.stringify(cancelledByPointer));

  // 3) 取消确认 → 零写入
  const cancelled = await evaluate(
    send,
    `(async () => {
      const chip = document.querySelector('.cal-chip[data-order-id="a1"]');
      const cell = [...document.querySelectorAll(".cal-day-num")].find((el) => el.textContent.trim() === "22");
      const col = cell ? Number(getComputedStyle(cell).gridColumnStart) : 0;
      const bg = cell ? [...cell.parentElement.querySelectorAll(".cal-day-bg")][col - 1] : null;
      if (!chip || !bg) return { closed: false, writes: -1 };
      const from = chip.getBoundingClientRect();
      const to = bg.getBoundingClientRect();
      const opts = (x, y) => ({ bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true });
      chip.dispatchEvent(new PointerEvent("pointerdown", opts(from.left + from.width / 2, from.top + from.height / 2)));
      await new Promise((r) => setTimeout(r, 50));
      window.dispatchEvent(new PointerEvent("pointermove", opts(to.left + to.width / 2, to.top + to.height / 2)));
      await new Promise((r) => setTimeout(r, 120));
      window.dispatchEvent(new PointerEvent("pointerup", opts(to.left + to.width / 2, to.top + to.height / 2)));
      await new Promise((r) => setTimeout(r, 220));
      const dialog = document.querySelector('[role="alertdialog"]');
      const cancel = dialog ? [...dialog.querySelectorAll("button")].find((b) => b.textContent.trim() === "取消") : null;
      if (cancel) cancel.click();
      await new Promise((r) => setTimeout(r, 200));
      return {
        closed: !document.querySelector('[role="alertdialog"]'),
        writes: window.__CALLS__.filter((c) => c.cmd === "update_order_details").length,
      };
    })()`,
  );
  results.measurements.cancel = cancelled;
  check("取消后对话框关闭", cancelled.closed === true, JSON.stringify(cancelled));
  check("取消确认零写入", cancelled.writes === 0, `update_order_details=${cancelled.writes}`);

  // 未排期池的改期入口
  const poolDialog = await evaluate(
    send,
    `(async () => {
      const btn = [...document.querySelectorAll(".cal-pool-reschedule")][0];
      if (!btn) return { ok: false };
      btn.click();
      await new Promise((r) => setTimeout(r, 200));
      const dialog = document.querySelector('[role="alertdialog"]');
      return { ok: Boolean(dialog), text: dialog ? dialog.textContent.slice(0, 220) : null };
    })()`,
  );
  results.measurements.poolDialog = poolDialog;
  check("未排期池可打开改期并选择写入哪一端", poolDialog.ok === true && /写入计划/.test(poolDialog.text ?? ""), (poolDialog.text ?? "").slice(0, 80));
  const shotPool = await shot(send, "04-未排期改期.png", false);

  // 5) 三段操作区：CSS 规则 + 键盘聚焦可见性（headless 下 CDP 悬停不生效，见报告）
  await evaluate(send, `document.querySelector(".cal-today")?.click()`);
  await sleep(300);
  const zoneRules = await evaluate(
    send,
    `(() => {
      const found = [];
      for (const sheet of document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; }
        for (const rule of rules) {
          if (rule.selectorText && /cal-chip(:hover|:focus-visible) \.cal-chip-handle|cal-chip-handle\.is-(start|end)|cal-chip-grip/.test(rule.selectorText)) {
            found.push(rule.selectorText);
          }
        }
      }
      return found;
    })()`,
  );
  results.measurements.zoneRules = zoneRules;
  check(
    "订单条存在左/右抓手与移动握把的样式规则",
    zoneRules.some((r) => r.includes("is-start")) &&
      zoneRules.some((r) => r.includes("is-end")) &&
      zoneRules.some((r) => r.includes("cal-chip-grip")),
    JSON.stringify(zoneRules).slice(0, 160),
  );

  const focusZone = async (name) => {
    await evaluate(
      send,
      `(() => { const chip = document.querySelector('.cal-chip[data-order-id="a5"]'); if (chip) chip.focus(); return true; })()`,
    );
    await sleep(250);
    const state = await evaluate(
      send,
      `(() => {
        const chip = document.querySelector('.cal-chip[data-order-id="a5"]');
        if (!chip) return null;
        const handles = [...chip.querySelectorAll(".cal-chip-handle")].map((h) => ({
          side: h.className.includes("is-start") ? "start" : "end",
          opacity: getComputedStyle(h).opacity,
        }));
        return {
          handles,
          cursor: getComputedStyle(chip).cursor,
          focused: document.activeElement === chip,
          focusVisible: chip.matches(":focus-visible"),
        };
      })()`,
    );
    const path = await shot(send, `${name}.png`, false);
    return { state, path };
  };
  const zoneShot = await focusZone("06-三段抓手-聚焦");
  results.measurements.zoneAffordance = zoneShot?.state;
  observe(
    "聚焦时抓手是否可见",
    JSON.stringify(zoneShot?.state ?? null),
    "headless 里程序化 focus 不满足 :focus-visible 时会保持 opacity 0；规则本身已验证存在",
  );

  // 6) 点击跳转 vs 拖动不跳转（用真实 DOM 事件验证应用逻辑；CDP 鼠标在本探针环境不投递）
  const clickChip = async (id) => {
    const hash = await evaluate(
      send,
      `(async () => {
        const chip = document.querySelector('.cal-chip[data-order-id="${id}"]');
        if (!chip) return "no-chip";
        chip.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
        await new Promise((r) => setTimeout(r, 400));
        return location.hash;
      })()`,
    );
    await evaluate(send, `history.back()`);
    await sleep(400);
    for (let i = 0; i < 20; i += 1) {
      if (await evaluate(send, `Boolean(document.querySelector(".cal-grid"))`)) break;
      await sleep(150);
    }
    return hash;
  };

  const clickHash = await clickChip("a5");
  results.measurements.clickNav = clickHash;
  check(
    "普通点击进入订单详情（#/orders?orderId=a5）",
    typeof clickHash === "string" && clickHash.includes("/orders") && clickHash.includes("orderId=a5"),
    String(clickHash),
  );

  const draggedHash = await evaluate(
    send,
    `(async () => {
      const chip = document.querySelector('.cal-chip[data-order-id="a5"]');
      const cell = [...document.querySelectorAll(".cal-day-num")].find((el) => el.textContent.trim() === "12");
      const col = cell ? Number(getComputedStyle(cell).gridColumnStart) : 0;
      const bg = cell ? [...cell.parentElement.querySelectorAll(".cal-day-bg")][col - 1] : null;
      if (!chip || !bg) return "no-target";
      const from = chip.getBoundingClientRect();
      const to = bg.getBoundingClientRect();
      const opts = (x, y) => ({ bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true });
      chip.dispatchEvent(new PointerEvent("pointerdown", opts(from.left + from.width / 2, from.top + from.height / 2)));
      await new Promise((r) => setTimeout(r, 40));
      window.dispatchEvent(new PointerEvent("pointermove", opts(to.left + to.width / 2, to.top + to.height / 2)));
      await new Promise((r) => setTimeout(r, 120));
      window.dispatchEvent(new PointerEvent("pointerup", opts(to.left + to.width / 2, to.top + to.height / 2)));
      chip.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      await new Promise((r) => setTimeout(r, 400));
      return location.hash;
    })()`,
  );
  results.measurements.dragNav = draggedHash;
  check(
    "拖动后紧跟的 click 被吞掉（不跳详情）",
    typeof draggedHash === "string" && !draggedHash.includes("orderId"),
    String(draggedHash),
  );

  await evaluate(
    send,
    `(() => { const d = document.querySelector('[role="alertdialog"]');
      const c = d ? [...d.querySelectorAll("button")].find((b) => b.textContent.trim() === "取消") : null;
      if (c) c.click(); return true; })()`,
  );
  await sleep(300);
  const clickAgain = await clickChip("a5");
  results.measurements.clickAgain = clickAgain;
  check(
    "拖动之后普通点击仍然可以进详情",
    typeof clickAgain === "string" && clickAgain.includes("orderId=a5"),
    String(clickAgain),
  );

  results.screenshots = {
    month: shotMonth,
    week: shotWeek,
    dragging: shotDragging,
    dialog: shotDialog,
    invalid: shotInvalid,
    pool: shotPool,
    zone: zoneShot?.path,
  };
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
