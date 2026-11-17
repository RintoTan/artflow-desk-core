#!/usr/bin/env node
/**
 * 真实几何回归：用无头 Chrome 打开三个页面的九种组合，断言
 *   1) 列表与详情不重叠
 *   2) 页面没有横向溢出（scrollWidth <= 视口宽）
 *   3) 关键控件仍然存在且尺寸合理
 *   4) 订单页在单栏下，列表"内部可滚动区"真的够高
 *   5) 导航图标盒在折叠态居中、展开态文字起点一致
 *   6) 长标题气泡能出现、在视口内、滚动后收起
 *
 * 需要先起 dev server（npm run dev，端口 1420）。
 * 这不是 jsdom 测试：jsdom 没有排版，测不出这类问题。
 *
 * 与 WKWebView 的差异：Blink 与 WebKit 在 flex/grid 细节上偶有差别，
 * 结构性结论（是否单栏、是否重叠、是否横向溢出）一致，像素仍需人眼。
 */
import { execFileSync } from "node:child_process";

const URL = process.env.PROBE_URL ?? "http://127.0.0.1:1420/";
const ROUTES = ["/orders", "/clients", "/templates"];
const WIDTHS = [1400, 900, 530];

const failures = [];
let checks = 0;

function runProbe({ width, route, env = {} }) {
  const raw = execFileSync(
    process.execPath,
    ["scripts/layout-probe.mjs", URL, String(width), route],
    { encoding: "utf8", env: { ...process.env, PROBE_SLOT: "1", ...env } },
  );
  const tipAt = raw.indexOf("TOOLTIP ");
  const head = tipAt === -1 ? raw : raw.slice(0, tipAt);
  const data = JSON.parse(head.slice(head.indexOf("{")));
  let tooltip = null;
  if (tipAt !== -1) {
    const body = raw.slice(tipAt + "TOOLTIP ".length);
    tooltip = JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1));
  }
  return { data, tooltip };
}

function record(tag, problems, detail) {
  checks += 1;
  if (problems.length) {
    failures.push(`${tag}: ${problems.join("；")}`);
    console.log(`FAIL ${tag} — ${problems.join("；")}`);
  } else {
    console.log(`PASS ${tag} — ${detail}`);
  }
}

for (const route of ROUTES) {
  for (const width of WIDTHS) {
    const { data } = runProbe({ width, route });
    const problems = [];
    const tag = `${route} @${width}`;

    if (!data.list || !data.detail) problems.push("没有找到列表/详情容器");
    if (data.overlapArea > 0) problems.push(`重叠 ${data.overlapArea}px²`);
    if (data.pageScrollWidth > width) {
      problems.push(`页面横向溢出 ${data.pageScrollWidth} > ${width}`);
    }
    if (!data.navItemHeight || data.navItemHeight < 44) {
      problems.push(`导航命中高度 ${data.navItemHeight} < 44`);
    }
    if (data.containerSupported === false) {
      problems.push("容器查询不受支持（会走媒体查询退化路径，请人工确认）");
    }

    // 展开态：所有导航项图标盒与行中心对齐，且文字起点完全一致
    const nav = data.navGeom ?? [];
    if (nav.length !== 7) problems.push(`导航项数量 ${nav.length} ≠ 7`);
    const offsetsY = nav.map((n) => Math.abs(n.boxOffsetY ?? 99));
    if (offsetsY.some((v) => v > 1)) problems.push(`图标垂直偏移 ${offsetsY.join(",")}`);
    const textLefts = new Set(nav.map((n) => n.textLeft));
    if (textLefts.size !== 1) problems.push(`文字起点不一致 ${[...textLefts].join(",")}`);
    const heights = new Set(nav.map((n) => n.item?.h));
    if (heights.size !== 1) problems.push(`导航行高不一致 ${[...heights].join(",")}`);

    // 订单页单栏：内部滚动区必须够高，且整卡不占满屏
    if (route === "/orders" && width <= 900) {
      const box = data.rowsBox;
      const floor = width <= 560 ? 200 : 240;
      if (!box) problems.push("没有找到列表滚动区");
      else {
        if (box.h < floor) problems.push(`列表滚动区 ${box.h}px < ${floor}px`);
        if ((box.visibleRows ?? 0) < 2) problems.push(`一屏不足 2 行（${box.visibleRows}）`);
      }
      const share = data.list.h / data.viewport.h;
      if (share > 0.66) problems.push(`列表占视口 ${Math.round(share * 100)}% > 66%`);
    }

    record(
      tag,
      problems,
      `列 ${data.gridColumns}，卡片 ${data.list?.h}，滚动区 ${data.rowsBox?.h ?? "-"}，详情顶 ${data.detail?.y}`,
    );
  }
}

// 排期：列表必须没有轨道，详情里的轨道要按真实日期比例铺满
for (const width of [1400, 900, 530]) {
  const { data } = runProbe({ width, route: "/orders" });
  const sched = data.sched;
  const problems = [];
  if (sched?.listTrack) problems.push("列表里仍然有排期轨道");
  if (sched?.rowH !== 78) problems.push(`列表行高 ${sched?.rowH} ≠ 78`);
  if (width <= 900 && (data.rowsBox?.visibleRows ?? 0) < 3) {
    problems.push(`一屏只有 ${data.rowsBox?.visibleRows} 条完整订单`);
  }
  if (data.overlapArea > 0) problems.push(`列表与详情重叠 ${data.overlapArea}px²`);
  if (!sched?.track) problems.push("详情里没有排期轨道");
  else {
    if (sched.track.w < 300) problems.push(`轨道只有 ${sched.track.w}px 宽`);
    if (!sched.band) problems.push("有多端日期时没有画区间");
    if (sched.todayPct === null || sched.todayPct < 0 || sched.todayPct > 100) {
      problems.push(`今天位置异常 ${sched.todayPct}%`);
    }
    if ((sched.dates ?? []).length < 2) problems.push("日期文字缺失");
  }
  record(
    `orders schedule @${width}`,
    problems,
    `行高 ${sched?.rowH}，列表无轨道，详情轨道 ${sched?.track?.w}px，今天 ${sched?.todayPct}%`,
  );
}

// 统计图：宽屏单排、窄屏两排、两排刻度一致、都不横向滚动
for (const [width, expectedMode] of [
  [1400, "single"],
  [900, "split"],
  [530, "split"],
]) {
  const { data } = runProbe({ width, route: "/stats" });
  const c = data.chart;
  const problems = [];
  if (!c) problems.push("没有找到图表");
  else {
    if (c.mode !== expectedMode) problems.push(`模式 ${c.mode} ≠ ${expectedMode}`);
    if (c.months !== 12) problems.push(`只有 ${c.months} 个月，数据被截断`);
    if (c.rows !== (expectedMode === "single" ? 1 : 2)) problems.push(`排数 ${c.rows} 不对`);
    if (c.scrollable) problems.push("仍需横向滚动才能看全月份");
    if (c.overflowX) problems.push("整页出现横向溢出");
    if (c.axisMoved) problems.push("横向滚动时 Y 轴动了");
    if (new Set(c.rowTicks).size !== 1) problems.push(`两排刻度不一致：${c.rowTicks.join(" | ")}`);
    const ticks = c.ticks.map(Number);
    if (ticks.some((n, i) => !Number.isInteger(n) || n < 0 || (i > 0 && n <= ticks[i - 1]))) {
      problems.push(`刻度不是递增非负整数：${c.ticks.join(",")}`);
    }
    if (c.zeroBarHeight > 3) problems.push(`零值高 ${c.zeroBarHeight}px，像有值的柱子`);
    if (c.focusable !== c.months) problems.push(`可聚焦列 ${c.focusable} ≠ 月份 ${c.months}`);
    if (c.labels.length === 0) problems.push("没有数值标签");
  }
  record(
    `stats chart @${width}`,
    problems,
    c
      ? `${c.mode}（${c.rows} 排 ${c.months} 月），刻度 ${c.ticks.join("/")}，标签 ${c.labels.length}，滚动 ${c.scrollable ? "是" : "否"}`
      : "-",
  );
}

// 折叠侧栏：图标盒必须正好落在 44×44 命中区的中心
{
  const { data } = runProbe({ width: 1400, route: "/orders", env: { PROBE_COLLAPSED: "1" } });
  const problems = [];
  for (const item of data.navGeom ?? []) {
    if (item.item?.h < 44 || item.item?.w < 44) {
      problems.push(`${item.label} 命中区 ${item.item?.w}×${item.item?.h}`);
    }
    if (Math.abs(item.boxOffsetX) > 1) problems.push(`${item.label} 水平偏移 ${item.boxOffsetX}px`);
    if (Math.abs(item.boxOffsetY) > 1) problems.push(`${item.label} 垂直偏移 ${item.boxOffsetY}px`);
  }
  const button = data.collapseGeom?.button;
  if (!button || button.h < 44 || button.w < 44) {
    problems.push(`折叠按钮命中区 ${button?.w}×${button?.h}`);
  }
  record(
    "collapsed nav @1400",
    problems,
    `侧栏 ${data.sidebarWidth}px，按钮 ${button?.w}×${button?.h}，图标偏移 0`,
  );
}

// 展开侧栏：折叠按钮必须贴在底部组（不悬在半腰）
{
  const { data } = runProbe({ width: 1400, route: "/orders" });
  const problems = [];
  const g = data.collapseGeom;
  if (!g?.button || !g?.foot) problems.push("没有找到折叠按钮或版本区");
  else {
    if (g.gapToBottom < 40) problems.push(`按钮离底边过近 ${g.gapToBottom}px（会压住版本文字）`);
    if (g.gapToBottom > 120) problems.push(`按钮离底边 ${g.gapToBottom}px（悬在半腰）`);
    if (g.gapToFoot < 0) problems.push("按钮与版本区重叠");
  }
  record("sidebar bottom @1400", problems, `按钮底部距侧栏底 ${g?.gapToBottom}px，距版本区 ${g?.gapToFoot}px`);
}

// 矮窗口（1400×400）：导航自己滚，底部按钮和版本信息仍在窗口内
{
  const { data } = runProbe({
    width: 1400,
    route: "/orders",
    env: { PROBE_HEIGHT: "400" },
  });
  const problems = [];
  const nav = data.navBox;
  const button = data.collapseGeom?.button;
  const foot = data.collapseGeom?.foot;
  if (!nav || !button || !foot) problems.push("没有找到侧栏结构");
  else {
    if (nav.bottom > button.y) problems.push(`导航压住折叠按钮（${nav.bottom} > ${button.y}）`);
    if (button.bottom > data.viewport.h) problems.push("折叠按钮被挤出窗口");
    if (foot.bottom > data.viewport.h) problems.push("版本信息被挤出窗口");
    if (nav.scrollH <= nav.clientH) problems.push("导航没有退化为滚动容器");
  }
  record(
    "sidebar @1400x400",
    problems,
    `导航 ${nav?.clientH}/${nav?.scrollH}px 可滚，按钮 ${button?.y}–${button?.bottom}，版本区底 ${foot?.bottom}`,
  );
}

// 长标题气泡：出现位置、是否在视口内、滚动后是否收起
{
  const { tooltip } = runProbe({ width: 900, route: "/orders", env: { PROBE_TOOLTIP: "1" } });
  const problems = [];
  if (!tooltip?.before?.truncated) problems.push("长标题没有被截断（夹具失效）");
  if (!tooltip?.shown) problems.push("悬停后没有出现气泡");
  else {
    if (!tooltip.shown.inViewport) problems.push("气泡超出视口");
    if (tooltip.shown.parent !== "body") problems.push(`气泡没有挂到 body（会被裁切）：${tooltip.shown.parent}`);
    if (tooltip.shown.pointerEvents !== "none") problems.push("气泡会拦截指针事件");
  }
  if (!tooltip?.closedAfterScroll) problems.push("滚动后气泡没有收起");
  record(
    "tooltip @900",
    problems,
    `被截断 ${tooltip?.before?.clampedH}px → 完整 ${tooltip?.before?.cloneH}px，气泡 ${tooltip?.shown?.rect?.w}×${tooltip?.shown?.rect?.h}`,
  );
}

// 看板 / 表格：切换视图不得写业务数据，横向滚动只能发生在面板内部
for (const [view, widths] of [
  ["board", [1400, 900, 530]],
  ["table", [900, 530]],
]) {
  for (const width of widths) {
    const raw = execFileSync(
      process.execPath,
      ["scripts/layout-probe.mjs", URL, String(width), "/orders"],
      { encoding: "utf8", env: { ...process.env, PROBE_SLOT: "1", PROBE_VIEW: view } },
    );
    const line = raw.split("\n").find((l) => l.startsWith("VIEW "));
    const parsed = line ? JSON.parse(raw.slice(raw.indexOf("{", raw.indexOf("VIEW ")))) : null;
    const g = parsed?.geom;
    const problems = [];
    if (!parsed?.clicked) problems.push("找不到视图切换控件");
    else if (parsed.clicked.length !== 3) problems.push(`视图只有 ${parsed.clicked.length} 个`);
    if (!g) problems.push("没有拿到几何数据");
    else {
      if (g.overflowX) problems.push(`页面横向溢出 ${g.pageScrollW} > ${g.innerW}`);
      if (g.writeCalls.length) problems.push(`切换视图触发了业务写入：${g.writeCalls.join(",")}`);
      if (g.cards > 0) problems.push("切到宽视图后卡片列表仍在 DOM 里");
      if (view === "board") {
        if (!g.board.exists) problems.push("看板没有渲染");
        else {
          if (g.board.cols < 2) problems.push(`看板只有 ${g.board.cols} 列（夹具失效）`);
          if (g.board.minColW < 180) problems.push(`列宽 ${g.board.minColW}px < 180px`);
          const shouldScroll = g.board.scrollW > g.board.clientW;
          if (g.board.scrollsInside !== shouldScroll) problems.push("看板滚动状态异常");
          if (width <= 900 && !g.board.scrollsInside) problems.push("窄窗下看板没有在面板内横向滚动");
        }
      } else if (!g.table.exists) {
        problems.push("表格没有渲染");
      } else {
        if (!g.table.scrollsInside) problems.push("窄窗下表格没有在面板内横向滚动");
        if (g.table.wrapClientW > g.innerW) problems.push("表格容器比视口还宽");
      }
    }
    record(
      `view:${view} @${width}`,
      problems,
      g?.board?.exists
        ? `${g.board.cols} 列 / 最小列宽 ${g.board.minColW}px / 内部滚动 ${g.board.scrollsInside}`
        : `表格 ${g?.table?.wrapClientW}px 容器内滚动 ${g?.table?.scrollsInside}`,
    );
  }
}

if (failures.length) {
  console.error(`\n${failures.length}/${checks} 项几何回归失败`);
  process.exit(1);
}
console.log(`\n${checks} 项几何检查全部通过（无重叠、无横向溢出、滚动区够高、导航对齐、气泡可用）`);
