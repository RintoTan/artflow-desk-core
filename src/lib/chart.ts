/**
 * 月度柱状图的纯计算：刻度、柱高百分比、标签密度、数字缩写。
 *
 * 口径：这里只做"次数"的显示换算，不参与任何统计聚合。
 * 完成/取消/新建的计数语义仍然由后端 `StatsReport` 决定。
 */

/** 刻度：非负整数、不重复、覆盖最大值；值很小时不硬造刻度。 */
export function axisTicks(maxValue: number): number[] {
  const max = Math.max(0, Math.floor(maxValue));
  if (max <= 0) return [0];
  if (max === 1) return [0, 1];

  // 取"好读"的上界：2 → 2；3~4 → 4；5~10 → 10；更大按 1/2/5×10^n 取整
  const niceMax = niceCeil(max);
  const step = niceMax <= 4 ? niceMax / 2 : niceStep(niceMax);
  const ticks: number[] = [];
  for (let value = 0; value <= niceMax; value += step) {
    ticks.push(Math.round(value));
  }
  if (ticks[ticks.length - 1] !== niceMax) ticks.push(niceMax);
  return [...new Set(ticks)];
}

/** 柱子高度的百分比：按刻度上界换算，保证最高的柱子不顶到边框。 */
export function barPercent(value: number, axisMax: number): number {
  if (axisMax <= 0) return 0;
  return Math.min(100, (value / axisMax) * 100);
}

/** 刻度上界，用于换算柱高（与 axisTicks 的最后一个值一致）。 */
export function axisMaxOf(ticks: number[]): number {
  return ticks.length ? ticks[ticks.length - 1]! : 0;
}

/** 是否逐柱显示数值：6 个月以内全标，超过则只标每月最大值。 */
export function labelsEveryBar(monthCount: number): boolean {
  return monthCount <= 6;
}

/** 大数字缩写：1234 → 1.2k，12345 → 12k。次数一般用不到，但轴要经得住。 */
export function compactCount(value: number): string {
  const n = Math.round(value);
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function niceStep(max: number): number {
  const raw = max / 2;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function niceCeil(max: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const normalized = max / magnitude;
  // 3 落进 4 而不是 5：三笔数据用 0/2/4 比 0/5 更贴，柱子也不会显得矮
  const ceil =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 4 ? 4 : normalized <= 5 ? 5 : 10;
  return ceil * magnitude;
}
