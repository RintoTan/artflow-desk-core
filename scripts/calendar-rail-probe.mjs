#!/usr/bin/env node
/** 左侧订单导航 + 图钉定位取证（Blink）。用法：node scripts/calendar-rail-probe.mjs [url] */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.argv[2] ?? "http://127.0.0.1:1425/";
const PORT = Number(process.env.RAIL_PORT ?? 9711);
const SHOTS = process.env.RAIL_SHOT_DIR ?? "/tmp/rail-shots";
const SIZE = (process.env.RAIL_SIZE ?? "1400x1000").split("x").map(Number);

function order(id, code, title, start, delivery, extra = {}) {
  return {
    id, code, title, clientId: "c1", clientName: "林小满", commissionType: "半身立绘",
    stageTemplateId: "tpl", source: "画加", amountCents: 120000, note: null, status: "active",
    workState: "queued", currentStageId: "s1", currentStageTitle: "草稿", currentStageIndex: 0,
    stageCount: 5, stages: [], queuePosition: 1, plannedStartDate: start, plannedDeliveryDate: delivery,
    deadlineState: "scheduled", startedAt: null, completedAt: null, cancelledAt: null, revision: 1,
    createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
    capabilities: { canStartWork: true, canUndoStartWork: false, undoBlockedReason: null, canAdvance: false, canRework: false, canComplete: false, canCancel: true, canReopen: false, canEditWorkflow: true },
    ...extra,
  };
}

const ORDERS = [
  order("s1", "AF-2026-0001", "本月排期订单", "2026-11-10", "2026-11-14"),
  order("s2", "AF-2026-0002", "跨年订单", "2027-02-01", "2027-02-10"),
  order("s3", "AF-2026-0003", "远端订单", "2027-08-03", "2027-08-05"),
  order("u1", "AF-2026-0004", "完全未排期订单", null, null),
  order("c1", "AF-2026-0005", "有历史日期的完成单", "2026-09-02", "2026-09-06", { status: "complete" }),
  order("c2", "AF-2026-0006", "未参与排期的完成单", null, null, { status: "complete" }),
];

const fixtures = {
  environment_status: {
    appVersion: "0.1.0", firstRun: false, generation: "gen-rail", schemaVersion: 6, upgradedFrom: null,
    rootPath: "/tmp/rail", qaMode: true, qaScenario: "seeded", sqliteVersion: "3.50.0", journalMode: "wal",
    workingTimezone: "Asia/Shanghai", systemTimezone: "Asia/Shanghai", lockHeld: true, orders: ORDERS.length,
    clients: 1, templates: 1, attachments: 0, pendingCleanup: 0, highWater: [], integrity: "ok",
  },
  ui_icon_get: { variant: "orbit", storedVariant: null, defaultVariant: "orbit" },
  list_clients: [{ id: "c1", displayName: "林小满", contact: null, note: null, orderCount: 6, createdAt: "2026-11-01T00:00:00.000Z" }],
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
      const v = table[cmd];
      return v === undefined ? null : JSON.parse(JSON.stringify(v));
    },
    transformCallback: (cb) => cb,
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  };
  window.isTauri = true;
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const record = (name, pass, detail) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? "" : "\n        " + JSON.stringify(detail)}`);
};

const profile = mkdtempSync(join(tmpdir(), "rail-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--force-device-scale-factor=1", "about:blank"], { stdio: "ignore" });
let ws = null;
for (let i = 0; i < 60 && ws === null; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    ws = list.find((x) => x.type === "page")?.webSocketDebuggerUrl ?? null;
  } catch { /* 等端口 */ }
  if (ws === null) await sleep(250);
}
const socket = new WebSocket(ws);
const pending = new Map();
let id = 0;
await new Promise((res) => socket.addEventListener("open", res, { once: true }));
socket.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
});
const send = (method, params = {}) => new Promise((res, rej) => { id += 1; pending.set(id, { resolve: res, reject: rej }); socket.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval");
  return r.result?.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: SIZE[0], height: SIZE[1], deviceScaleFactor: 1, mobile: false });
await send("Page.addScriptToEvaluateOnNewDocument", { source: mock });
await send("Page.navigate", { url: `${BASE}#/calendar` });
for (let i = 0; i < 80; i += 1) { await sleep(250); if (await ev(`Boolean(document.querySelector(".cal-grid"))`)) break; }
await sleep(800);

const sections = await ev(`(() => {
  const heads = [...document.querySelectorAll(".cal-rail-title")].map((n) => n.textContent);
  return { heads, cards: document.querySelectorAll(".cal-rail-card").length,
    doneExpanded: Boolean([...document.querySelectorAll(".cal-rail-head")].find((h) => h.textContent.includes("完成订单"))?.getAttribute("aria-expanded") === "true") };
})()`);
record("左侧三个分区都在（未排期 / 排期 / 完成）",
  sections.heads.join() === "未排期订单,排期订单,完成订单", sections);
record("完成订单默认折叠", sections.doneExpanded === false, sections);

// 搜索：跨分区命中完成订单
await ev(`(() => { const i = document.querySelector('.cal-rail-search input'); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(i, '未参与'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await sleep(300);
const searched = await ev(`(() => ({ cards: document.querySelectorAll(".cal-rail-card").length, text: document.querySelector(".cal-rail-scroll").innerText.replace(/\\n/g, " | ").slice(0, 80) }))()`);
record("搜索能跨分区命中（含未展开的完成订单）",
  searched.cards === 1 && searched.text.includes("未参与排期的完成单"), searched);
await ev(`(() => { const i = document.querySelector('.cal-rail-search input'); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await sleep(300);

// 图钉定位：本月订单
const located = await ev(`(async () => {
  const pin = [...document.querySelectorAll(".cal-rail-pin")].find((b) => b.getAttribute("aria-label") === "定位 AF-2026-0001");
  pin.click();
  await new Promise((r) => setTimeout(r, 700));
  const chip = document.querySelector('[data-order-id="s1"]');
  const seg = chip?.closest(".cal-seg");
  const sc = document.querySelector(".cal-scroll").getBoundingClientRect();
  const r = seg?.getBoundingClientRect();
  const others = [...document.querySelectorAll(".cal-seg:not(.is-focus-target) .cal-chip")].map((c) => Number(getComputedStyle(c).opacity));
  return {
    focused: seg?.className.includes("is-focus-target") ?? false,
    inView: r ? (r.top >= sc.top - 1 && r.bottom <= sc.bottom + 1) : false,
    dimmedOthers: others.length === 0 ? null : Math.max(...others),
    pinPressed: pin.getAttribute("aria-pressed"),
  };
})()`);
record("图钉定位：目标条进入视口并进入聚焦态", located.focused === true && located.inView === true, located);
record("A+B：其它订单被适度弱化（不是隐藏，也不动网格）",
  located.dimmedOthers === null || (located.dimmedOthers <= 0.5 && located.dimmedOthers > 0), located);

// 远月订单定位
const far = await ev(`(async () => {
  const pin = [...document.querySelectorAll(".cal-rail-pin")].find((b) => b.getAttribute("aria-label") === "定位 AF-2026-0003");
  pin.click();
  await new Promise((r) => setTimeout(r, 900));
  const seg = document.querySelector('[data-order-id="s3"]')?.closest(".cal-seg");
  const sc = document.querySelector(".cal-scroll").getBoundingClientRect();
  const r = seg?.getBoundingClientRect();
  return { title: document.querySelector(".cal-title").textContent.trim(), inView: r ? r.top >= sc.top - 1 && r.bottom <= sc.bottom + 1 : false };
})()`);
record("跨年订单定位：自动扩展并进入视口", far.inView === true && far.title.includes("8 月"), far);

// 再点同一图钉取消
const toggled = await ev(`(async () => {
  const pin = [...document.querySelectorAll(".cal-rail-pin")].find((b) => b.getAttribute("aria-label") === "定位 AF-2026-0003");
  pin.click();
  await new Promise((r) => setTimeout(r, 400));
  return { focused: Boolean(document.querySelector(".cal-seg.is-focus-target")), gridHasFocus: document.querySelector(".cal-grid").dataset.focusOrder !== undefined };
})()`);
record("再次点击同一图钉取消聚焦", toggled.focused === false && toggled.gridHasFocus === false, toggled);

// 未排期订单：定位到左侧卡片
const rail = await ev(`(async () => {
  const pin = [...document.querySelectorAll(".cal-rail-pin")].find((b) => b.getAttribute("aria-label") === "定位 AF-2026-0004");
  pin.click();
  await new Promise((r) => setTimeout(r, 400));
  const card = document.querySelector('[data-rail-order="u1"]');
  return { flash: card?.className.includes("is-flash") ?? false, focused: Boolean(document.querySelector(".cal-seg.is-focus-target")), title: document.querySelector(".cal-title").textContent.trim() };
})()`);
record("未排期订单定位到左侧卡片并短暂高亮，不改日期",
  rail.flash === true && rail.focused === false, rail);
await sleep(1800);

// 无日期的完成订单：展开完成分区并定位卡片
const done = await ev(`(async () => {
  const heads = [...document.querySelectorAll(".cal-rail-head")];
  const doneHead = heads.find((h) => h.textContent.includes("完成订单"));
  if (doneHead.getAttribute("aria-expanded") !== "true") doneHead.click();
  await new Promise((r) => setTimeout(r, 200));
  const pin = [...document.querySelectorAll(".cal-rail-pin")].find((b) => b.getAttribute("aria-label") === "定位 AF-2026-0006");
  pin.click();
  await new Promise((r) => setTimeout(r, 400));
  const card = document.querySelector('[data-rail-order="c2"]');
  return { expanded: doneHead.getAttribute("aria-expanded"), flash: card?.className.includes("is-flash") ?? false, text: card?.innerText.replace(/\\n/g, " ") ?? null };
})()`);
record("无日期完成单：定位到卡片并标注「未参与排期」",
  done.flash === true && (done.text ?? "").includes("未参与排期"), done);

// 有历史日期的完成单：临时打开显示开关并定位
const doneDated = await ev(`(async () => {
  const pin = [...document.querySelectorAll(".cal-rail-pin")].find((b) => b.getAttribute("aria-label") === "定位 AF-2026-0005");
  pin.click();
  await new Promise((r) => setTimeout(r, 900));
  const seg = document.querySelector('[data-order-id="c1"]')?.closest(".cal-seg");
  const sc = document.querySelector(".cal-scroll").getBoundingClientRect();
  const r = seg?.getBoundingClientRect();
  return { toggle: document.querySelector('input[type="checkbox"]')?.checked ?? null, inView: r ? r.top >= sc.top - 1 && r.bottom <= sc.bottom + 1 : false, focused: seg?.className.includes("is-focus-target") ?? false };
})()`);
record("完成单（有历史日期）：临时显示并定位到历史日期",
  doneDated.inView === true && doneDated.focused === true, doneDated);

await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
await sleep(300);
record("Esc 取消聚焦", (await ev(`Boolean(document.querySelector(".cal-seg.is-focus-target"))`)) === false, null);

mkdirSync(SHOTS, { recursive: true });
const png = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(SHOTS, "rail.png"), Buffer.from(png.data, "base64"));

const failed = checks.filter((c) => !c.pass);
writeFileSync(join(SHOTS, "result.json"), JSON.stringify(checks, null, 2));
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
try { chrome.kill("SIGKILL"); } catch { /* ignore */ }
try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failed.length === 0 ? 0 : 1);
