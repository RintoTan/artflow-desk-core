/**
 * 金额一律以「整数分」为准，前端只做展示与输入解析，不做任何财务计算。
 * 汇总、净额、待收这些都由后端派生，界面不去复算——复算迟早会和后端对不上。
 */

/** 分 → 「1,000.00」；未知（null）返回 null，交给调用方决定显示什么。 */
export function formatCents(cents: number | null | undefined): string | null {
  if (cents === null || cents === undefined) return null;
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.trunc(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** 分 → 「¥ 1,000.00」；未知返回「—」，不是「¥ 0.00」。 */
export function formatYuan(cents: number | null | undefined): string {
  const text = formatCents(cents);
  return text === null ? "—" : `¥ ${text}`;
}

/** 分 → 输入框文本（不带货币符号、去掉无意义的 .00）。 */
export function centsToInput(cents: number | null | undefined): string {
  const text = formatCents(cents);
  if (text === null) return "";
  return text.replace(/,/g, "").replace(/\.00$/, "");
}

/**
 * 输入文本 → 分。只接受非负、最多两位小数的十进制；其余一律 null。
 * 不做四舍五入——把「12.345」悄悄变成 12.35 比报错更糟。
 */
export function yuanToCents(raw: string): number | null {
  const text = raw.trim().replace(/,/g, "");
  if (text === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}
