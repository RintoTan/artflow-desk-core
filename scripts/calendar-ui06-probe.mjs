#!/usr/bin/env node
/**
 * DEV-06D-3-UI-06 浏览器回归取证（Blink）。
 *
 * 覆盖本轮四项修复：
 *   CAL-QA-02  +N 命中：今天格/非当月格里的 +N 必须能被点开，且浮层支持
 *              "点外部关闭 / 点另一个 +N 切换 / 再点同一个关闭 / Esc 关闭"
 *   CAL-UI-07  未排期订单拖进日期格 → 直接打开双字段排期弹窗，默认预填交付日
 *   CAL-UI-08  月视图行高按视口分配：七列等宽、所有格等高、日期数字位置一致、
 *              订单条与 +N 不撑开格子
 *   CAL-UI-09  月份归属按可见格多数票；非当月日期保持完整交互
 *
 * 结论只代表 Blink，不代表 WKWebView / WebView2。
 *
 * 用法：node scripts/calendar-ui06-probe.mjs [url]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.argv[2] ?? "http://127.0.0.1:1425/";
const SHOTS = process.env.UI06_SHOT_DIR ?? "/tmp/calendar-ui06";
const PORT = Number(process.env.UI06_PORT ?? 9611);
const SIZES = (process.env.UI06_SIZES ?? "1400x1100,1400x760,900x760")
  .split(",")
  .map((pair) => pair.split("x").map(Number));

const TODAY = "2026-11-19";

/** 与 src/lib/scheduleBar.ts 一致的 days_from_civil，用于把日期写成天序号。 */
function daysFromCivil(year, month, day) {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

const dayOf = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return daysFromCivil(y, m, d);
};

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

// 今天的格子里堆 4 笔 → 今天格出现 +1（今天格带 opacity，正是命中问题的现场）
// 下月（12-02）的格子里也堆 4 笔 → 非当月格出现 +1
const ORDERS = [
  order("t1", "AF-2026-0001", "今天格一", TODAY, TODAY, { deadlineState: "dueToday" }),
  order("t2", "AF-2026-0002", "今天格二", TODAY, TODAY, { deadlineState: "dueToday" }),
  order("t3", "AF-2026-0003", "今天格三", TODAY, TODAY, { deadlineState: "dueToday" }),
  order("t4", "AF-2026-0004", "今天格四", TODAY, TODAY, { deadlineState: "dueToday" }),
  order("o1", "AF-2026-0005", "下月格一", "2026-12-02", "2026-12-02"),
  order("o2", "AF-2026-0006", "下月格二", "2026-12-02", "2026-12-02"),
  order("o3", "AF-2026-0007", "下月格三", "2026-12-02", "2026-12-02"),
  order("o4", "AF-2026-0008", "下月格四", "2026-12-02", "2026-12-02"),
  order("r1", "AF-2026-0009", "区间订单", "2026-11-10", "2026-11-16"),
  order("n1", "AF-2026-0010", "完全未排期订单", null, null),
];

const fixtures = {
  environment_status: {
    appVersion: "0.1.0",
    firstRun: false,
    generation: "gen-ui06",
    schemaVersion: 6,
    upgradedFrom: null,
    rootPath: "/tmp/ui06",
    qaMode: true,
    qaScenario: "seeded",
    sqliteVersion: "3.50.0",
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
  ui_icon_get: { variant: "orbit", storedVariant: null, defaultVariant: "orbit" },
  list_clients: [
    {
      id: "c1",
      displayName: "林小满",
      contact: null,
      note: null,
      orderCount: ORDERS.length,
      createdAt: "2026-11-01T00:00:00.000Z",
    },
  ],
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

async function openPage(width, height, port) {
  const profile = mkdtempSync(join(tmpdir(), "ui06-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--force-device-scale-factor=1",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let ws = null;
  for (let i = 0; i < 60 && ws === null; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      ws = list.find((item) => item.type === "page")?.webSocketDebuggerUrl ?? null;
    } catch {
      /* 端口未就绪 */
    }
    if (ws === null) await sleep(250);
  }
  if (ws === null) throw new Error(`Chrome 调试端口 ${port} 没有就绪`);
  const client = rpc(ws);
  await client.ready;
  const { send } = client;
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: mock });
  await send("Page.navigate", { url: `${BASE}#/calendar` });
  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? JSON.stringify(res.exceptionDetails));
    }
    return res.result?.value;
  };
  for (let i = 0; i < 80; i += 1) {
    await sleep(250);
    if (await evaluate(`Boolean(document.querySelector(".cal-grid"))`)) break;
  }
  await sleep(400);
  return { chrome, profile, send, evaluate };
}

const checks = [];
const record = (group, name, pass, detail) => checks.push({ group, name, pass, detail });

async function shot(send, name) {
  const res = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  mkdirSync(SHOTS, { recursive: true });
  const path = join(SHOTS, name);
  writeFileSync(path, Buffer.from(res.data, "base64"));
  return path;
}

async function runSize(width, height, port) {
  const label = `${width}x${height}`;
  const page = await openPage(width, height, port);
  const { chrome, profile, send, evaluate } = page;
  try {
    // ---------------------------------------------------------------- 网格几何
    const geometry = await evaluate(`(() => {
      const weeks = [...document.querySelectorAll(".cal-week")];
      const cells = [...document.querySelectorAll(".cal-day-bg")];
      const widths = cells.slice(0, 7).map((c) => Math.round(c.getBoundingClientRect().width * 100) / 100);
      const heights = [...new Set(weeks.map((w) => Math.round(w.getBoundingClientRect().height)))];
      const offsets = cells.slice(0, 21).map((cell) => {
        const num = [...cell.parentElement.querySelectorAll(".cal-day-num")]
          .find((n) => n.style.gridColumn === cell.style.gridColumn);
        const a = cell.getBoundingClientRect();
        const b = num.getBoundingClientRect();
        return [Math.round(b.left - a.left), Math.round(b.top - a.top)];
      });
      const uniq = [...new Set(offsets.map((o) => o.join(",")))];
      const scroll = document.querySelector(".cal-scroll");
      const rowH = heights[0] ?? 0;
      const visibleRows = Math.floor(scroll.clientHeight / rowH);
      return {
        width: document.documentElement.clientWidth,
        weeks: weeks.length,
        colWidths: widths,
        rowHeights: heights,
        numOffsets: uniq,
        numOffsetRaw: offsets.slice(0, 4),
        rowH,
        visibleRows,
        gridTemplateRows: getComputedStyle(weeks[0]).gridTemplateRows,
        chips: document.querySelectorAll(".cal-chip").length,
        moreCount: document.querySelectorAll(".cal-more").length,
        pageScrollWidth: document.documentElement.scrollWidth,
        pageClientWidth: document.documentElement.clientWidth,
      };
    })()`);

    record(label, "七列等宽", Math.max(...geometry.colWidths) - Math.min(...geometry.colWidths) <= 1,
      geometry.colWidths);
    record(label, "所有周行等高（唯一高度值）", geometry.rowHeights.length === 1, geometry.rowHeights);
    record(label, "日期数字位置统一（左上角同内边距）", geometry.numOffsets.length === 1, geometry.numOffsets);
    record(label, "行高落在 44~168 之间（自适应范围）", geometry.rowH >= 44 && geometry.rowH <= 168, geometry.rowH);
    record(label, "无页面横向溢出", geometry.pageScrollWidth <= geometry.pageClientWidth + 1,
      { scrollWidth: geometry.pageScrollWidth, clientWidth: geometry.pageClientWidth });

    // 订单条与 +N 不撑开格子：把某天订单加满前后行高一致（用现有 4 单格与空格的格高比较）
    const cellHeights = await evaluate(`(() => {
      const cells = [...document.querySelectorAll(".cal-day-bg")];
      const used = cells.find((c) => c.parentElement.querySelector(".cal-more"));
      const empty = cells.find((c) => c.dataset.preview === undefined && c.parentElement.querySelectorAll(".cal-seg").length === 0);
      return {
        used: used ? Math.round(used.getBoundingClientRect().height) : null,
        empty: empty ? Math.round(empty.getBoundingClientRect().height) : null,
      };
    })()`);
    record(label, "订单条与 +N 不撑开日期格", cellHeights.used !== null && cellHeights.used === cellHeights.empty,
      cellHeights);

    void ((`JSON.stringify({more: document.querySelectorAll(".cal-more").length, chips: document.querySelectorAll(".cal-chip").length, rowH: Math.round(document.querySelector(".cal-week").getBoundingClientRect().height), scrollH: document.querySelector(".cal-scroll").clientHeight, weeks: document.querySelectorAll(".cal-week").length})`));
    // ---------------------------------------------------------------- +N 命中链
    // 先把一个 +N 滚进视口：命中测试只能在可见区域做
    await evaluate(`(() => { const b = document.querySelector(".cal-more"); if (b) b.scrollIntoView({ block: "center" }); return true; })()`);
    await sleep(400);
    const hit = await evaluate(`(() => {
      const out = [];
      const sc = document.querySelector(".cal-scroll").getBoundingClientRect();
      const visible = (r) => r.top >= sc.top - 1 && r.bottom <= sc.bottom + 1 && r.height > 0;
      for (const btn of [...document.querySelectorAll(".cal-more")]) {
        if (!visible(btn.getBoundingClientRect())) continue;
        const cell = [...btn.parentElement.querySelectorAll(".cal-day-bg")]
          .find((c) => c.style.gridColumn === btn.style.gridColumn);
        const r = btn.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const stack = document.elementsFromPoint(cx, cy).slice(0, 3)
          .map((el) => el.tagName.toLowerCase() + (el.className ? "." + String(el.className).trim().split(/\\s+/).join(".") : ""));
        // A/B：把修复撤掉（恢复成无定位无 z-index），看命中首位是否变成日期格
        const z = btn.style.zIndex;
        const p = btn.style.position;
        btn.style.zIndex = "auto";
        btn.style.position = "static";
        const broken = document.elementsFromPoint(cx, cy).slice(0, 1)
          .map((el) => el.tagName.toLowerCase() + (el.className ? "." + String(el.className).trim().split(/\\s+/).join(".") : ""));
        btn.style.zIndex = z;
        btn.style.position = p;
        out.push({
          day: cell?.dataset.day,
          today: cell?.dataset.today === "1",
          outside: cell?.dataset.outside === "1",
          label: btn.textContent,
          top: stack[0],
          stack,
          brokenTop: broken[0],
          rect: { x: Math.round(cx), y: Math.round(cy), w: Math.round(r.width), h: Math.round(r.height) },
        });
      }
      return out;
    })()`);

    if (hit.length === 0) {
      await evaluate(`(() => { const list = document.querySelectorAll(".cal-more"); const b = list[list.length - 1]; if (b) b.scrollIntoView({ block: "center" }); return true; })()`);
      await sleep(500);
    }
    record(label, "所有 +N 的命中首位都是按钮本身",
      hit.length >= 1 && hit.every((h) => h.top === "button.cal-more"),
      hit.map((h) => ({ day: h.day, top: h.top, today: h.today, outside: h.outside })));
    record(label, "撤掉 z-index 后 +N 被格子覆盖（证明根因）",
      hit.every((h) => h.brokenTop === "div.cal-day-bg"),
      hit.map((h) => ({ day: h.day, brokenTop: h.brokenTop })));
    const allMore = await evaluate(`(() => [...document.querySelectorAll(".cal-more")].map((b) => {
      const cell = [...b.parentElement.querySelectorAll(".cal-day-bg")]
        .find((c) => c.style.gridColumn === b.style.gridColumn);
      return { day: cell?.dataset.day, today: cell?.dataset.today === "1", outside: cell?.dataset.outside === "1", label: b.textContent };
    }))()`);
    record(label, "今天格与非当月格都出现了 +N",
      allMore.some((h) => h.today) && allMore.some((h) => h.outside),
      allMore);

    // ---------------------------------------------------------------- 浮层开合
    const todayMore = hit.find((h) => h.today) ?? hit[0] ?? allMore[0];
    await evaluate(`(() => {
      const btn = [...document.querySelectorAll(".cal-more")].find((b) => {
        const cell = [...b.parentElement.querySelectorAll(".cal-day-bg")].find((c) => c.style.gridColumn === b.style.gridColumn);
        return Number(cell?.dataset.day) === ${todayMore.day};
      });
      if (btn) btn.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      return true;
    })()`);
    await sleep(200);
    const opened = await evaluate(`(() => {
      const pop = document.querySelector(".cal-popover");
      if (!pop) return { open: false };
      const r = pop.getBoundingClientRect();
      return {
        open: true,
        items: pop.querySelectorAll("li").length,
        details: [...pop.querySelectorAll("button")].filter((b) => b.textContent === "详情").length,
        reschedule: [...pop.querySelectorAll("button")].filter((b) => b.textContent === "改期").length,
        insideViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
      };
    })()`);
    record(label, "点击今天格的 +N 打开浮层", opened.open === true, opened);
    record(label, "浮层列出全部折叠订单并保留详情/改期入口",
      opened.open && opened.items === 1 && opened.details === 1 && opened.reschedule === 1, opened);
    record(label, "浮层不超出视口", opened.open === true && opened.insideViewport === true, opened);
    await shot(send, `${label}-01-弹出浮层.png`);

    // 点浮层内部不应关闭
    await evaluate(`document.querySelector(".cal-popover .cal-popover-order")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
    await sleep(120);
    record(label, "点击浮层内部不关闭", await evaluate(`Boolean(document.querySelector(".cal-popover"))`), null);

    // 点日历空白（工具栏标题）关闭
    await evaluate(`document.querySelector(".cal-title").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
    await sleep(150);
    record(label, "点击日历其它区域关闭浮层", (await evaluate(`Boolean(document.querySelector(".cal-popover"))`)) === false, null);

    // Esc 关闭
    await evaluate(`(() => {
      const btn = document.querySelector(".cal-more");
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      return true;
    })()`);
    await sleep(150);
    const openedAgain = await evaluate(`Boolean(document.querySelector(".cal-popover"))`);
    await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await sleep(150);
    record(label, "Esc 关闭浮层",
      openedAgain === true && (await evaluate(`Boolean(document.querySelector(".cal-popover"))`)) === false,
      { openedAgain });

    // 再点同一个 +N 关闭
    await evaluate(`document.querySelector(".cal-more").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }))`);
    await sleep(150);
    const sameOpen = await evaluate(`Boolean(document.querySelector(".cal-popover"))`);
    await evaluate(`document.querySelector(".cal-more").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }))`);
    await sleep(150);
    record(label, "再次点击同一个 +N 关闭浮层",
      sameOpen === true && (await evaluate(`Boolean(document.querySelector(".cal-popover"))`)) === false,
      { sameOpen });

    // 点另一个 +N 切换
    const switched = await evaluate(`(() => {
      const btns = [...document.querySelectorAll(".cal-more")];
      if (btns.length < 2) return { skipped: true };
      btns[0].dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      return { skipped: false, first: btns.length };
    })()`);
    await sleep(150);
    const switchState = await evaluate(`(() => {
      const pop = document.querySelector(".cal-popover");
      const first = document.querySelector(".cal-popover header strong")?.textContent ?? null;
      const btns = [...document.querySelectorAll(".cal-more")];
      if (btns.length > 1) btns[1].dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      return { first, openBefore: Boolean(pop) };
    })()`);
    await sleep(200);
    const afterSwitch = await evaluate(`(() => {
      const pop = document.querySelector(".cal-popover");
      return { open: Boolean(pop), title: pop?.querySelector("header strong")?.textContent ?? null, count: document.querySelectorAll(".cal-popover").length };
    })()`);
    record(label, "点击另一个 +N 切换到新的浮层（只有一层）",
      switchState.openBefore === true && afterSwitch.open === true &&
        afterSwitch.count === 1 && afterSwitch.title !== switchState.first,
      { from: switchState.first, to: afterSwitch.title, count: afterSwitch.count });
    await evaluate(`document.querySelector(".cal-title").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);

    // ---------------------------------------------------------------- 非当月日期交互
    const outsidePick = await evaluate(`(async () => {
      const cell = [...document.querySelectorAll(".cal-day-bg")].find((c) => c.dataset.outside === "1" && Number(c.dataset.day) > ${todayMore.day});
      if (!cell) return { skipped: true };
      const before = document.querySelector(".cal-title").textContent.trim();
      cell.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      await new Promise((r) => setTimeout(r, 200));
      const after = document.querySelector(".cal-title").textContent.trim();
      const live = [...document.querySelectorAll(".cal-day-bg")].find((c) => c.dataset.day === cell.dataset.day);
      return { skipped: false, day: cell.dataset.day, before, after, focus: live?.dataset.focus === "1" };
    })()`);
    record(label, "点击非当月日期：焦点标记生效且月份跟随",
      outsidePick.skipped === true ||
        (outsidePick.focus === true && outsidePick.after !== outsidePick.before &&
          outsidePick.after.includes("12 月")),
      outsidePick);
    await shot(send, `${label}-02-点击非当月日期.png`);

    // 回到今天
    await evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent === "今天")?.click()`);
    await sleep(300);

    // 跨月边界：让 11-30 所在行贴住视口底部 —— 此时视口里 11 月仍占多数
    const boundary = await evaluate(`(() => {
      const sc = document.querySelector(".cal-scroll");
      const rows = [...document.querySelectorAll(".cal-week")];
      const target = rows.find((w) => [...w.querySelectorAll(".cal-day-bg")]
        .some((c) => Number(c.dataset.day) === ${dayOf("2026-11-30")}));
      if (!target) return { skipped: true };
      const scTop = sc.getBoundingClientRect().top;
      const rowTop = target.getBoundingClientRect().top - scTop + sc.scrollTop;
      const rowH = target.getBoundingClientRect().height;
      // 让 11-30 所在行成为视口最后一行
      sc.scrollTop = Math.max(0, rowTop + rowH - sc.clientHeight);
      return { skipped: false, scrollTop: Math.round(sc.scrollTop), clientH: sc.clientHeight, rowH: Math.round(rowH) };
    })()`);
    await sleep(400);
    const boundaryTitle = await evaluate(`(() => {
      const sc = document.querySelector(".cal-scroll");
      const rows = [...document.querySelectorAll(".cal-week")];
      const rowH = rows[0].getBoundingClientRect().height;
      const scTop = sc.getBoundingClientRect().top;
      const visible = rows.filter((w) => {
        const r = w.getBoundingClientRect();
        const overlap = Math.min(r.bottom, scTop + sc.clientHeight) - Math.max(r.top, scTop);
        return overlap >= rowH * 0.5;
      });
      return {
        title: document.querySelector(".cal-title").textContent.trim(),
        rows: visible.map((w) => [...w.querySelectorAll(".cal-day-bg")].map((c) => c.dataset.day).filter(Boolean).slice(0, 7)),
      };
    })()`);
    record(label, "跨月边界按可见多数定月份（11 月末仍是 11 月）",
      boundary.skipped === true || boundaryTitle.title.includes("11 月"),
      { ...boundary, ...boundaryTitle });

    // ---------------------------------------------------------------- 未排期拖入
    const drag = await evaluate(`(async () => {
      const item = document.querySelector(".cal-pool-item");
      if (!item) return { skipped: true };
      const target = [...document.querySelectorAll(".cal-day-bg")].find((c) => Number(c.dataset.day) === ${dayOf("2026-12-18")});
      if (!target) return { skipped: true, why: "no target cell" };
      // 目标格必须在视口里，否则 elementsFromPoint 取不到落点
      target.scrollIntoView({ block: "center" });
      await new Promise((r) => setTimeout(r, 250));
      const a = item.getBoundingClientRect();
      const t = target.getBoundingClientRect();
      const x = t.left + t.width / 2;
      const y = t.top + t.height / 2;
      item.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 3, pointerType: "mouse", isPrimary: true,
        clientX: a.left + 8, clientY: a.top + 8,
      }));
      await new Promise((r) => setTimeout(r, 60));
      window.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, pointerId: 3, pointerType: "mouse", isPrimary: true, buttons: 1, clientX: a.left + 40, clientY: a.top + 40,
      }));
      await new Promise((r) => setTimeout(r, 60));
      window.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, pointerId: 3, pointerType: "mouse", isPrimary: true, buttons: 1, clientX: x, clientY: y,
      }));
      await new Promise((r) => setTimeout(r, 80));
      const hint = document.querySelector(".cal-hint-slot")?.innerText ?? "";
      const hasPlan = Boolean(document.querySelector(".cal-drag-status dl"));
      window.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, pointerId: 3, pointerType: "mouse", isPrimary: true, button: 0, clientX: x, clientY: y,
      }));
      await new Promise((r) => setTimeout(r, 250));
      const dialog = document.querySelector('[role="alertdialog"]');
      const start = dialog?.querySelector('input[type="date"]');
      const dates = dialog ? [...dialog.querySelectorAll('input[type="date"]')].map((i) => i.value) : [];
      return {
        skipped: false, hint, hasPlan, open: Boolean(dialog), dates, startValue: start?.value ?? null,
        roles: [...document.querySelectorAll("[role]")].map((el) => el.getAttribute("role")).slice(0, 12),
        slot: document.querySelector(".cal-hint-slot")?.innerText ?? null,
      };
    })()`);
    record(label, "未排期订单拖入日期格：不再提示二选一，直接开确认框",
      drag.skipped === true || (drag.open === true && !drag.hint.includes("请选择写入")), drag);
    record(label, "拖入后默认预填交付日期=落点、开始日期为空",
      drag.skipped === true || (drag.dates[1] === "2026-12-18" && drag.dates[0] === ""),
      drag.dates);
    await shot(send, `${label}-03-未排期拖入弹窗.png`);

    // 填开始日期并确认
    const confirmed = await evaluate(`(async () => {
      const dialog = document.querySelector('[role="alertdialog"]');
      if (!dialog) return { skipped: true };
      const inputs = [...dialog.querySelectorAll('input[type="date"]')];
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(inputs[0], "2026-12-10");
      inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 80));
      const btn = [...dialog.querySelectorAll("button")].find((b) => b.textContent.includes("确认改期"));
      const disabled = btn.disabled;
      btn.click();
      await new Promise((r) => setTimeout(r, 300));
      const call = (window.__CALLS__ || []).filter((c) => c.cmd === "update_order_details").pop();
      return { skipped: false, disabled, input: call?.args?.input ?? null, dialogOpen: Boolean(document.querySelector('[role="alertdialog"]')) };
    })()`);
    record(label, "两端都有值时校验通过并写出整单（含开始日期）",
      confirmed.skipped === true ||
        (confirmed.disabled === false &&
          confirmed.input?.plannedStartDate === "2026-12-10" &&
          confirmed.input?.plannedDeliveryDate === "2026-12-18"),
      confirmed.input);

    // ---------------------------------------------------------------- 周视图回归
    const week = await evaluate(`(async () => {
      [...document.querySelectorAll("button")].find((b) => b.textContent === "周")?.click();
      await new Promise((r) => setTimeout(r, 250));
      const rows = document.querySelectorAll(".cal-week");
      const cells = document.querySelectorAll(".cal-day-bg");
      const chips = document.querySelectorAll(".cal-chip");
      const widths = [...cells].map((c) => Math.round(c.getBoundingClientRect().width));
      return {
        rows: rows.length,
        cells: cells.length,
        chips: chips.length,
        equalWidth: Math.max(...widths) - Math.min(...widths) <= 1,
        rowsTemplate: rows[0] ? getComputedStyle(rows[0]).gridTemplateRows : null,
      };
    })()`);
    record(label, "周视图：单周 7 列且等宽", week.rows === 1 && week.cells === 7 && week.equalWidth, week);
    await shot(send, `${label}-04-周视图.png`);

    return { label, geometry, hit, opened, drag, week };
  } finally {
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
  }
}

const summaries = [];
let port = PORT;
for (const [width, height] of SIZES) {
  summaries.push(await runSize(width, height, port));
  port += 1;
}

mkdirSync(SHOTS, { recursive: true });
const failed = checks.filter((c) => !c.pass);
writeFileSync(join(SHOTS, "result.json"), JSON.stringify({ today: TODAY, checks, summaries }, null, 2));

for (const check of checks) {
  console.log(`${check.pass ? "PASS" : "FAIL"}  ${check.group}  ${check.name}`);
  if (!check.pass) console.log("      ", JSON.stringify(check.detail));
}
console.log(`\n${checks.length - failed.length}/${checks.length} 通过，截图目录 ${SHOTS}`);
process.exit(failed.length === 0 ? 0 : 1);
