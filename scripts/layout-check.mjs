#!/usr/bin/env node
/**
 * 真实几何回归：用无头 Chrome 打开三个页面的九种组合，断言
 *   1) 列表与详情不重叠
 *   2) 页面没有横向溢出（scrollWidth <= 视口宽）
 *   3) 关键控件仍然存在且尺寸合理
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

for (const route of ROUTES) {
  for (const width of WIDTHS) {
    const raw = execFileSync(
      process.execPath,
      ["scripts/layout-probe.mjs", URL, String(width), route],
      { encoding: "utf8", env: { ...process.env, PROBE_SLOT: "1" } },
    );
    const data = JSON.parse(raw.slice(raw.indexOf("{")));
    const problems = [];

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

    const tag = `${route} @${width}`;
    if (problems.length) {
      failures.push(`${tag}: ${problems.join("；")}`);
      console.log(`FAIL ${tag} — ${problems.join("；")}`);
    } else {
      console.log(
        `PASS ${tag} — 列 ${data.gridColumns}，列表高 ${data.list.h}，详情顶 ${data.detail.y}`,
      );
    }
  }
}

if (failures.length) {
  console.error(`\n${failures.length} 项几何回归失败`);
  process.exit(1);
}
console.log("\n九种组合全部通过（无重叠、无横向溢出）");
