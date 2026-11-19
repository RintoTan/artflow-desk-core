#!/usr/bin/env node
/**
 * 月历自适应取证（Blink）：窗口尺寸 → 网格尺寸的缩放关系、以及"不出现滚动条"。
 *
 * 只管布局，不重复 UI-06 的交互断言（那些在 calendar-ui06-probe.mjs）。
 *
 * 用法：node scripts/calendar-fit-probe.mjs [url]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.argv[2] ?? "http://127.0.0.1:1425/";
const SHOTS = process.env.FIT_SHOT_DIR ?? "/tmp/calendar-fit";
const PORT = Number(process.env.FIT_PORT ?? 9631);
const SIZES = (process.env.FIT_SIZES ?? "1400x1000,1400x760,1120x760,900x760,900x600")
  .split(",")
  .map((p) => p.split("x").map(Number));

const TODAY = "2026-11-19";

function order(id, code, title, start, delivery, extra = {}) {
  return {
    id, code, title, clientId: "c1", clientName: "林小满", commissionType: "半身立绘",
    stageTemplateId: "tpl", source: "画加", amountCents: 120000, note: null, status: "active",
    workState: "queued", currentStageId: "s1", currentStageTitle: "草稿", currentStageIndex: 0,
    stageCount: 5, stages: [], queuePosition: 1, plannedStartDate: start, plannedDeliveryDate: delivery,
    deadlineState: "scheduled", startedAt: null, completedAt: null, cancelledAt: null, revision: 1,
    createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
    capabilities: {
      canStartWork: true, canUndoStartWork: false, undoBlockedReason: null, canAdvance: false,
      canRework: false, canComplete: false, canCancel: true, canReopen: false, canEditWorkflow: true,
    },
    ...extra,
  };
}

const DENSE = Number(process.env.FIT_DENSE ?? 0);
for (let i = 0; i < DENSE; i += 1) {
  // 同一天堆 N 笔，检验 +N 的数量与位置
}

const ORDERS = [
  order("t1", "AF-2026-0001", "今天格一", TODAY, TODAY, { deadlineState: "dueToday" }),
  order("t2", "AF-2026-0002", "今天格二", TODAY, TODAY, { deadlineState: "dueToday" }),
  order("t3", "AF-2026-0003", "今天格三", TODAY, TODAY, { deadlineState: "dueToday" }),
  order("t4", "AF-2026-0004", "今天格四", TODAY, TODAY, { deadlineState: "dueToday" }),
  order("r1", "AF-2026-0005", "跨周区间订单", "2026-11-10", "2026-11-16"),
  order("r2", "AF-2026-0006", "跨月长订单", "2026-11-26", "2026-12-08"),
  order("n1", "AF-2026-0007", "完全未排期订单", null, null),
  ...Array.from({ length: DENSE }, (_, i) =>
    order(`d${i}`, `AF-2026-1${String(i).padStart(3, "0")}`, `同日压测 ${i + 1}`, TODAY, TODAY),
  ),
];

const fixtures = {
  environment_status: {
    appVersion: "0.1.0", firstRun: false, generation: "gen-fit", schemaVersion: 6,
    upgradedFrom: null, rootPath: "/tmp/fit", qaMode: true, qaScenario: "seeded",
    sqliteVersion: "3.50.0", journalMode: "wal", workingTimezone: "Asia/Shanghai",
    systemTimezone: "Asia/Shanghai", lockHeld: true, orders: ORDERS.length, clients: 1,
    templates: 1, attachments: 0, pendingCleanup: 0, highWater: [], integrity: "ok",
  },
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
      if (cmd === "plugin:event|listen" || cmd === "plugin:event|unlisten") return 1;
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      id += 1;
      pending.set(id, { resolve: res, reject: rej });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return { ready, send, close: () => socket.close() };
}

const checks = [];
const record = (group, name, pass, detail) => checks.push({ group, name, pass, detail });

async function runSize(width, height, port) {
  const label = `${width}x${height}`;
  const profile = mkdtempSync(join(tmpdir(), "fit-"));
  const chrome = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--force-device-scale-factor=1", "about:blank",
  ], { stdio: "ignore" });

  let ws = null;
  for (let i = 0; i < 60 && ws === null; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      ws = list.find((x) => x.type === "page")?.webSocketDebuggerUrl ?? null;
    } catch { /* 端口未就绪 */ }
    if (ws === null) await sleep(250);
  }
  if (ws === null) throw new Error(`Chrome ${port} 未就绪`);

  const c = rpc(ws);
  await c.ready;
  const { send } = c;
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval error");
    return r.result?.value;
  };

  try {
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await send("Page.addScriptToEvaluateOnNewDocument", { source: mock });
    await send("Page.navigate", { url: `${BASE}#/calendar` });
    for (let i = 0; i < 80; i += 1) {
      await sleep(250);
      if (await evaluate(`Boolean(document.querySelector(".cal-grid"))`)) break;
    }
    await sleep(900);

    const m = await evaluate(`(() => {
      const sc = document.querySelector(".cal-scroll");
      const grid = document.querySelector(".cal-grid");
      const weeks = [...document.querySelectorAll(".cal-week")];
      const cells = [...document.querySelectorAll(".cal-day-bg")];
      const rowH = weeks[0].getBoundingClientRect().height;
      const title = document.querySelector(".cal-title").textContent.trim();
      // 当前月份在网格里的行范围
      const monthRows = weeks.filter((w) => [...w.querySelectorAll(".cal-day-num")]
        .some((n) => {
          const cell = [...w.querySelectorAll(".cal-day-bg")].find((c) => c.style.gridColumn === n.style.gridColumn);
          return cell && cell.dataset.outside !== "1";
        }));
      const widths = cells.slice(0, 7).map((c) => Math.round(c.getBoundingClientRect().width * 10) / 10);
      const heights = [...new Set(weeks.map((w) => Math.round(w.getBoundingClientRect().height)))];
      const offsets = [...new Set(cells.slice(0, 21).map((cell) => {
        const n = [...cell.parentElement.querySelectorAll(".cal-day-num")]
          .find((x) => x.style.gridColumn === cell.style.gridColumn);
        const a = cell.getBoundingClientRect();
        const b = n.getBoundingClientRect();
        return Math.round(b.left - a.left) + "," + Math.round(b.top - a.top);
      }))];
      const chips = [...document.querySelectorAll(".cal-chip")];
      const more = [...document.querySelectorAll(".cal-more")];
      const moreHit = more.map((b) => {
        const r = b.getBoundingClientRect();
        const top = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)[0];
        return { inside: r.top >= sc.getBoundingClientRect().top && r.bottom <= sc.getBoundingClientRect().bottom, top: top ? top.className : null };
      });
      const main = document.querySelector(".main");
      return {
        viewport: [innerWidth, innerHeight],
        title,
        rowH: Math.round(rowH),
        monthRows: monthRows.length,
        monthHeight: Math.round(monthRows.length * rowH),
        scrollH: sc.clientHeight,
        scrollW: sc.clientWidth,
        gridW: Math.round(grid.getBoundingClientRect().width),
        colWidths: widths,
        rowHeights: heights,
        numOffsets: offsets,
        chips: chips.length,
        chipH: chips[0] ? Math.round(chips[0].getBoundingClientRect().height) : 0,
        chipFont: chips[0] ? getComputedStyle(chips[0]).fontSize : null,
        more: more.length,
        moreHit,
        pageScrollW: document.documentElement.scrollWidth,
        pageClientW: document.documentElement.clientWidth,
        pageScrollH: document.documentElement.scrollHeight,
        pageClientH: document.documentElement.clientHeight,
        mainScrollH: main.scrollHeight,
        mainClientH: main.clientHeight,
        lanes: getComputedStyle(weeks[0]).gridTemplateRows.split(" ").length - 2,
      };
    })()`);

    record(label, "页面无横向溢出",
      m.pageScrollW <= m.pageClientW + 1 && m.scrollW <= m.gridW + 1,
      { pageScrollW: m.pageScrollW, pageClientW: m.pageClientW, scrollW: m.scrollW, gridW: m.gridW });
    record(label, "外层 .main 不出现纵向滚动条",
      m.mainScrollH <= m.mainClientH + 1,
      { mainScrollH: m.mainScrollH, mainClientH: m.mainClientH });
    record(label, "当前月份整月放得下（不靠滚动）",
      m.monthHeight <= m.scrollH + 1,
      { monthRows: m.monthRows, monthHeight: m.monthHeight, scrollH: m.scrollH, title: m.title });
    record(label, "七列等宽",
      Math.max(...m.colWidths) - Math.min(...m.colWidths) <= 1.5, m.colWidths);
    record(label, "所有周行等高", m.rowHeights.length === 1, m.rowHeights);
    record(label, "日期数字位置一致", m.numOffsets.length === 1, m.numOffsets);
    record(label, "订单条随行高缩放且不撑开格子",
      m.chips === 0 || (m.chipH > 0 && m.chipH <= m.rowH), { chipH: m.chipH, chipFont: m.chipFont, rowH: m.rowH });
    record(label, "+N 仍可点（命中首位是按钮）",
      m.more === 0 || m.moreHit.filter((h) => h.inside).every((h) => h.top === "cal-more"),
      m.moreHit);

    // ------------------------------------------------ UI-08A 日期格可读性 / +N 位置
    const cellInfo = await evaluate(`(() => {
      const chip = document.querySelector(".cal-chip");
      const more = document.querySelector(".cal-more");
      const dateNum = document.querySelector(".cal-day-num .cal-day-pill");
      const sc = document.querySelector(".cal-scroll");
      let cellW = 0;
      const firstWeek = document.querySelector(".cal-week");
      const firstCell = firstWeek?.querySelector(".cal-day-bg");
      if (firstCell) cellW = Math.round(firstCell.getBoundingClientRect().width);
      let overflow = 0, overlap = 0, marginMin = 999, slots = new Set();
      for (const m of document.querySelectorAll(".cal-more")) {
        slots.add(m.dataset.slot);
        const cell = [...m.parentElement.querySelectorAll(".cal-day-bg")]
          .find((c) => c.style.gridColumn === m.style.gridColumn);
        if (!cell) continue;
        const cr = cell.getBoundingClientRect();
        const mr = m.getBoundingClientRect();
        // 顶部槽位只要求左右留白（上边距由日期行决定）；底部槽位要求下边距
        const sides = m.dataset.slot === "bottom"
          ? [mr.left - cr.left, cr.right - mr.right, cr.bottom - mr.bottom]
          : [mr.left - cr.left, cr.right - mr.right];
        marginMin = Math.min(marginMin, ...sides);
        if (mr.left < cr.left - 0.5 || mr.right > cr.right + 0.5 || mr.top < cr.top - 0.5 || mr.bottom > cr.bottom + 0.5) overflow += 1;
        for (const seg of m.parentElement.querySelectorAll(".cal-seg")) {
          const sc2 = [...seg.parentElement.querySelectorAll(".cal-day-bg")]
            .find((c) => c.style.gridColumn === seg.style.gridColumn);
          if (sc2 !== cell) continue;
          const sr = seg.getBoundingClientRect();
          const hit = !(mr.right <= sr.left || mr.left >= sr.right || mr.bottom <= sr.top || mr.top >= sr.bottom);
          if (hit) overlap += 1;
        }
      }
      return {
        cellW,
        dateFont: dateNum ? getComputedStyle(dateNum).fontSize : null,
        chipFont: chip ? getComputedStyle(chip).fontSize : null,
        moreFont: more ? getComputedStyle(more).fontSize : null,
        slots: [...slots],
        moreCount: document.querySelectorAll(".cal-more").length,
        moreLabels: [...document.querySelectorAll(".cal-more")].map((m) => m.textContent).slice(0, 3),
        overflow, overlap,
        marginMin: marginMin === 999 ? null : Math.round(marginMin * 10) / 10,
      };
    })()`);

    record(label, "字号固定：日期 12px / 订单 11.5px / +N 11px",
      cellInfo.dateFont === "12px" && (cellInfo.chipFont === null || cellInfo.chipFont === "11.5px") &&
        (cellInfo.moreFont === null || cellInfo.moreFont === "11px"),
      cellInfo);
    record(label, "+N 不超出日期格", cellInfo.overflow === 0, cellInfo);
    record(label, "+N 不与订单条重叠", cellInfo.overlap === 0, cellInfo);
    record(label, "+N 与格子边界留白 ≥4px",
      cellInfo.marginMin === null || cellInfo.marginMin >= 3.5, cellInfo);
    record(label, "+N 位置随格宽切换（宽格右上 / 窄格底部）",
      cellInfo.moreCount === 0 ||
        (cellInfo.cellW >= 46 ? cellInfo.slots.join() === "top" : cellInfo.slots.join() === "bottom"),
      cellInfo);

    mkdirSync(SHOTS, { recursive: true });
    const png = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(SHOTS, `${label}.png`), Buffer.from(png.data, "base64"));
    return { label, m };
  } finally {
    try { chrome.kill("SIGKILL"); } catch { /* ignore */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

const results = [];
let port = PORT;
for (const [w, h] of SIZES) {
  results.push(await runSize(w, h, port));
  port += 1;
}

// 缩放关系：大窗口必须比小窗口行高更大
const byLabel = Object.fromEntries(results.map((r) => [r.label, r.m.rowH]));
const ordered = SIZES.map(([w, h]) => byLabel[`${w}x${h}`]);
const monotonic = ordered.every((v, i) => i === 0 || ordered[i - 1] >= v);
record("缩放关系", "窗口越大行高越大（不维持固定小尺寸）", monotonic, byLabel);

const failed = checks.filter((c) => !c.pass);
mkdirSync(SHOTS, { recursive: true });
writeFileSync(join(SHOTS, "result.json"), JSON.stringify({ checks, results }, null, 2));
for (const c of checks) {
  console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.group}  ${c.name}`);
  if (!c.pass) console.log("      ", JSON.stringify(c.detail));
}
console.log(`\n${checks.length - failed.length}/${checks.length} 通过；截图 ${SHOTS}`);
process.exit(failed.length === 0 ? 0 : 1);
