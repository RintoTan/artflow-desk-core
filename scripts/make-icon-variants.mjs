#!/usr/bin/env node
/**
 * 从三份原始 SVG 派生浅色 / 深色六份变体。
 *
 * 硬约束：**只替换色值字面量**，不碰路径、节点数、比例、圆角、透明度、
 * 属性名与结构。脚本最后会自己做一次校验：把两份文件的色值抠掉后必须逐字节相同，
 * 否则直接失败。原始文件保持不动，便于追溯。
 *
 * 用法：node scripts/make-icon-variants.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DIR = resolve(import.meta.dirname, "../src/assets/app-icons");

/**
 * 每套图标的配色映射：原色 → [浅色, 深色]。
 * 深色基准取自 miniDesk 深色主题（--bg #0F151B / --surface #182028 / --sidebar-bg #1A232D），
 * 浅色基准取自 Arctic Blue（--bg #F5F8FC / --surface #FFFFFF / 强调色 #2C6FB5）。
 */
const PALETTES = {
  orbit: {
    "#E5F4FF": ["#EFF7FF", "#1B2836"], // 背景渐变起点
    "#CFE9FC": ["#D8ECFB", "#111A22"], // 背景渐变终点
    "#3178CA": ["#2A6BB8", "#6FB3EE"], // 轨道 A 起点
    "#64B5EC": ["#4F9FDD", "#8FCBF7"], // 轨道 A 中段
    "#A0DFFD": ["#6FB3E0", "#BFE6FF"], // 轨道 A 终点
    "#A084F5": ["#8E6FE8", "#B9A6FF"], // 轨道 B 起点
    "#B1A9F7": ["#9E93F0", "#C8BDFF"], // 轨道 B 中段
    "#7FB8F6": ["#5E97D8", "#9FCDFB"], // 轨道 B 终点
    "#154583": ["#113A6E", "#E8F2FF"], // 星形起点
    "#3169BA": ["#2A5CA6", "#BFD9F6"], // 星形终点
  },
  layers: {
    "#183B67": ["#E9F3FD", "#1B3556"], // 背景起点
    "#102749": ["#D5E7F8", "#132A48"], // 背景终点
    "#B2D9FD": ["#5C8CBC", "#A8D2F7"], // 六边形线框
    "#6BC9F5": ["#2F6E9E", "#74D0F7"], // 底层起点（浅色下改为最暗，靠明度区分三层）
    "#76A9ED": ["#265C88", "#7FB2F2"], // 底层终点
    "#C8B6FF": ["#6A62BC", "#CFBEFF"], // 中层起点
    "#8D9DEB": ["#5A6FB8", "#94A3F0"], // 中层终点
    "#FAFEFF": ["#4A86C0", "#FBFEFF"], // 顶层起点（浅色下为中间调）
    "#C9E2FF": ["#3F76B8", "#CEE5FF"], // 顶层终点
    "#F8FCFF": ["#4A79B0", "#F8FCFF"], // 节点填充
    "#D4EEFF": ["#FFFFFF", "#D4EEFF"], // 节点描边
  },
  "wave-a": {
    "#1D4674": ["#E9F2FC", "#204B7A"], // 背景起点
    "#112B4F": ["#D4E6F8", "#122E52"], // 背景终点
    "#8CDCFB": ["#2E7BC0", "#9FE2FD"], // 字母左笔画起点
    "#F0FBFF": ["#1D4F86", "#F2FCFF"], // 字母左笔画终点
    "#79C4FA": ["#3E86CE", "#84CBFB"], // 字母右笔画起点
    "#B2A9FF": ["#6F63C0", "#B9B0FF"], // 字母右笔画终点
    "#FCFCFF": ["#2F6FAE", "#FCFCFF"], // 波浪线起点
    "#ABCCFF": ["#5B8FC8", "#B4D3FF"], // 波浪线中段
    "#CDB7FF": ["#7A6BC4", "#D4C2FF"], // 波浪线终点
    "#F9FCFF": ["#1F4E7E", "#F9FCFF"], // 端点圆（两处，同色）
  },
};

const HEX = /#[0-9A-Fa-f]{6}\b/g;

function apply(source, palette, index) {
  const upper = Object.fromEntries(Object.keys(palette).map((k) => [k.toUpperCase(), k]));
  const used = new Set();
  const out = source.replace(HEX, (match) => {
    const key = upper[match.toUpperCase()];
    if (!key) throw new Error(`没有为 ${match} 指定配色`);
    used.add(key);
    return palette[key][index];
  });
  const missing = Object.keys(palette).filter((k) => !used.has(k));
  if (missing.length) throw new Error(`这些色值在原文件里没出现：${missing.join(", ")}`);
  return out;
}

/** 抠掉色值后对比：除了颜色，其它必须一模一样。 */
function assertOnlyColorsDiffer(original, variant, label) {
  const strip = (text) => text.replace(HEX, "#");
  if (strip(original) !== strip(variant)) {
    throw new Error(`${label}：除了色值以外还有差异，拒绝写入`);
  }
}

const names = ["orbit", "layers", "wave-a"];
let written = 0;

for (const name of names) {
  const source = readFileSync(join(DIR, `${name}.svg`), "utf8");
  const palette = PALETTES[name];
  if (!palette) throw new Error(`缺少 ${name} 的配色表`);

  ["light", "dark"].forEach((appearance, index) => {
    const next = apply(source, palette, index);
    assertOnlyColorsDiffer(source, next, `${name}-${appearance}`);
    const out = join(DIR, `${name}-${appearance}.svg`);
    writeFileSync(out, next);
    written += 1;
    console.log(`写入 ${out}`);
  });
}

console.log(`\n${written} 份变体已生成；原始文件未改动，色值以外零差异。`);
