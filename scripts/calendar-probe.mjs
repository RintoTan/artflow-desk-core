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

  // 回到月视图，模拟拖放：把 a1 拖到 11-20 那一格
  await evaluate(send, `[...document.querySelectorAll(".cal-views button")].find((b) => b.textContent.trim() === "月").click()`);
  await sleep(300);
  const drag = await evaluate(
    send,
    `(async () => {
      const chip = document.querySelector('.cal-chip[data-order-id="a1"]');
      const target = [...document.querySelectorAll(".cal-day-bg")].find((el) => {
        const t = document.querySelector(".cal-title")?.textContent ?? "";
        return el.getAttribute("data-day") && el.dataset.inside === undefined;
      });
      // 用几何命中：把 11-20 那一格找出来（用 cal-day-num 文本 20 所在列）
      const nums = [...document.querySelectorAll(".cal-day-num")];
      const cell20 = nums.find((el) => el.textContent.trim() === "20");
      const col = cell20 ? Number(getComputedStyle(cell20).gridColumnStart) : 0;
      const weekRow = cell20 ? cell20.parentElement : null;
      const bg = weekRow ? weekRow.querySelector('.cal-day-bg[data-day]') && [...weekRow.querySelectorAll(".cal-day-bg")][col - 1] : null;
      if (!chip || !bg) return { ok: false, reason: "找不到 chip 或目标格" };
      // 窄窗下日历内部要横向滚动，先把目标格滚进可视区再做几何命中
      const scroller = document.querySelector(".cal-main");
      if (scroller) {
        scroller.scrollLeft = Math.max(0, bg.offsetLeft - 60);
        await new Promise((r) => setTimeout(r, 120));
      }
      const from = chip.getBoundingClientRect();
      const to = bg.getBoundingClientRect();
      const opts = (x, y) => ({ bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true });
      chip.dispatchEvent(new PointerEvent("pointerdown", opts(from.left + 6, from.top + from.height / 2)));
      await new Promise((r) => setTimeout(r, 60));
      window.dispatchEvent(new PointerEvent("pointermove", opts(to.left + to.width / 2, to.top + to.height / 2)));
      await new Promise((r) => setTimeout(r, 120));
      const hint = document.querySelector(".cal-hint")?.textContent ?? "";
      window.dispatchEvent(new PointerEvent("pointerup", opts(to.left + to.width / 2, to.top + to.height / 2)));
      await new Promise((r) => setTimeout(r, 200));
      const dialog = document.querySelector('[role="alertdialog"]');
      return {
        ok: Boolean(dialog),
        hint,
        dialogText: dialog ? dialog.textContent.slice(0, 200) : null,
        writes: window.__CALLS__.filter((c) => c.cmd === "update_order_details").length,
      };
    })()`,
  );
  results.measurements.drag = drag;
  check("拖放后弹出确认框", drag.ok === true, drag.dialogText ?? drag.reason ?? "无对话框");
  check("拖放阶段没有写库", drag.writes === 0, `update_order_details=${drag.writes}`);
  const shotDialog = await shot(send, "03-拖放确认框.png", false);

  // 取消 → 零写入
  const cancelled = await evaluate(
    send,
    `(async () => {
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
  check("取消后对话框关闭", cancelled.closed === true, "");
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

  results.screenshots = { month: shotMonth, week: shotWeek, dialog: shotDialog, pool: shotPool };
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
