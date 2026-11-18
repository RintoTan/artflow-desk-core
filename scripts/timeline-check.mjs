#!/usr/bin/env node
/**
 * 工作台时间线的真实排版检查（Blink，不是 WKWebView）。
 *
 * 断言：
 *   1) 左信息列与右轨道逐行 y 对齐
 *   2) 表头底边与信息列起点同一 y
 *   3) 信息列 + 轨道 + 分隔线 = 时间线框宽
 *   4) 表头第一个刻度与轨道共用坐标（滚动后仍为 0）
 *   5) 五条图例文字完整可见
 *   6) 页面没有横向溢出
 *   7) 轨道没有纵向滚动（不允许嵌套纵向滚动区）
 *   8) 表头不是 sticky
 *   9) 终态默认隐藏、完全未排期只收两个日期都为空的订单
 *
 * 需要先起 dev server（npm run dev）。
 * 用法：node scripts/timeline-check.mjs [url]
 */
import { execFileSync } from "node:child_process";

const URL = process.env.PROBE_URL ?? "http://127.0.0.1:1425/";
const CASES = [
  { tag: "视口 900", width: 900 },
  { tag: "视口 1400", width: 1400 },
  { tag: "视口 1680", width: 1680 },
  { tag: "容器 900", width: 1400, container: 900 },
];

const EXPECT_INFO = { "视口 900": 178, "视口 1400": 300, "视口 1680": 300, "容器 900": 236 };
const LEGEND = ["按排期", "三日内", "今天到期", "已逾期", "已结束"];

let checks = 0;
const failures = [];

function record(tag, problems, detail) {
  checks += 1;
  if (problems.length) {
    failures.push(`${tag}: ${problems.join("；")}`);
    console.log(`FAIL ${tag} — ${problems.join("；")}`);
  } else {
    console.log(`PASS ${tag} — ${detail}`);
  }
}

function probe({ width, container }) {
  const env = { ...process.env, PROBE_TIMELINE: "1", PROBE_HEIGHT: "1600", PROBE_SLOT: "7" };
  if (container) env.PROBE_CONTAINER = String(container);
  const raw = execFileSync(
    process.execPath,
    ["scripts/layout-probe.mjs", URL, String(width), "/"],
    { encoding: "utf8", env },
  );
  return JSON.parse(raw.slice(raw.indexOf("{"))).timelineGeom;
}

for (const item of CASES) {
  const g = probe(item);
  if (!g || !g.present) {
    record(item.tag, ["时间线没有渲染"], "");
    continue;
  }
  const problems = [];
  if (g.infoCount !== g.rowCount) problems.push(`信息列 ${g.infoCount} 行 ≠ 轨道 ${g.rowCount} 行`);
  if (g.maxRowTopDelta > 0.5) problems.push(`逐行 y 差 ${g.maxRowTopDelta}px`);
  if (Math.abs(g.cornerBottom - g.axisBottom) > 0.5) {
    problems.push(`表头底 ${g.cornerBottom} ≠ 信息列起点 ${g.axisBottom}`);
  }
  if (Math.abs(g.infoWidth + g.trackWidth + 1 - g.frame.w) > 2) {
    problems.push(`信息列 ${g.infoWidth} + 轨道 ${g.trackWidth} + 1 ≠ 框宽 ${g.frame.w}`);
  }
  if (g.firstTickLeft + g.scrollLeft !== 0) {
    problems.push(`首个刻度不在坐标原点：${g.firstTickLeft} + ${g.scrollLeft}`);
  }
  const texts = g.legend.map((li) => li.text);
  if (texts.length !== 5 || LEGEND.some((label, i) => texts[i] !== label)) {
    problems.push(`图例文案不符：${texts.join("/")}`);
  }
  if (!g.legendVisible) problems.push("图例不是全部可见");
  if (g.pageScrollWidth > g.windowInnerWidth + 1) {
    problems.push(`页面横向溢出 ${g.pageScrollWidth} > ${g.windowInnerWidth}`);
  }
  if (g.trackVerticalScroll) problems.push("轨道出现纵向滚动");
  if (g.hasStickyHeader === "sticky") problems.push("表头用了 sticky");
  if (g.terminalRows !== 0) problems.push(`终态默认隐藏失效：${g.terminalRows} 行`);
  if (!(g.unscheduledText ?? "").includes("AF-2026-0006")) problems.push("完全未排期区没有列出两个日期都为空的订单");
  if (!(g.unscheduledText ?? "").includes("1")) problems.push("完全未排期计数不是 1");
  const expectedInfo = EXPECT_INFO[item.tag];
  if (Math.abs(g.infoWidth - expectedInfo) > 2) {
    problems.push(`信息列宽 ${g.infoWidth} ≠ 参考值 ${expectedInfo}`);
  }

  record(
    item.tag,
    problems,
    `信息列 ${g.infoWidth}px · 轨道 ${g.trackWidth}px · 行高 ${g.rowHeight}px · 画布 ${g.canvasWidth}px · 行对齐 ${g.maxRowTopDelta}px · 条 ${g.barCount} 根 · 标记 ${g.markCount} 个`,
  );
}

console.log(`\n${checks - failures.length}/${checks} 通过`);
if (failures.length) {
  console.log(failures.map((line) => `- ${line}`).join("\n"));
  process.exit(1);
}
