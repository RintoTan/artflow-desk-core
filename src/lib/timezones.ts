/**
 * 工作时区选择用的常用时区表。
 *
 * 只负责"给人看的名字 + 搜索"，真正保存的仍是 IANA 名称；
 * 合法性最终由后端（chrono-tz）裁决，这里不替它做主。
 */
export type ZoneInfo = { iana: string; zh: string; city: string };

export const COMMON_ZONES: ZoneInfo[] = [
  { iana: "Asia/Shanghai", zh: "中国标准时间", city: "上海" },
  { iana: "Asia/Hong_Kong", zh: "香港时间", city: "香港" },
  { iana: "Asia/Taipei", zh: "台湾标准时间", city: "台北" },
  { iana: "Asia/Tokyo", zh: "日本标准时间", city: "东京" },
  { iana: "Asia/Seoul", zh: "韩国标准时间", city: "首尔" },
  { iana: "Asia/Singapore", zh: "新加坡标准时间", city: "新加坡" },
  { iana: "Asia/Bangkok", zh: "中南半岛时间", city: "曼谷" },
  { iana: "Asia/Jakarta", zh: "印度尼西亚西部时间", city: "雅加达" },
  { iana: "Asia/Kolkata", zh: "印度标准时间", city: "新德里" },
  { iana: "Asia/Dubai", zh: "海湾标准时间", city: "迪拜" },
  { iana: "Europe/London", zh: "英国时间", city: "伦敦" },
  { iana: "Europe/Paris", zh: "中欧时间", city: "巴黎" },
  { iana: "Europe/Berlin", zh: "中欧时间", city: "柏林" },
  { iana: "Europe/Madrid", zh: "中欧时间", city: "马德里" },
  { iana: "Europe/Moscow", zh: "莫斯科标准时间", city: "莫斯科" },
  { iana: "America/New_York", zh: "美国东部时间", city: "纽约" },
  { iana: "America/Chicago", zh: "美国中部时间", city: "芝加哥" },
  { iana: "America/Denver", zh: "美国山地时间", city: "丹佛" },
  { iana: "America/Los_Angeles", zh: "美国太平洋时间", city: "洛杉矶" },
  { iana: "America/Vancouver", zh: "加拿大太平洋时间", city: "温哥华" },
  { iana: "America/Sao_Paulo", zh: "巴西利亚时间", city: "圣保罗" },
  { iana: "Australia/Sydney", zh: "澳大利亚东部时间", city: "悉尼" },
  { iana: "Australia/Perth", zh: "澳大利亚西部时间", city: "珀斯" },
  { iana: "Pacific/Auckland", zh: "新西兰时间", city: "奥克兰" },
  { iana: "UTC", zh: "协调世界时", city: "UTC" },
];

/** 偏移量按给定时刻计算，夏令时由 Intl 负责，不写死。 */
export function offsetFor(iana: string, at: Date = new Date()): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: iana,
      timeZoneName: "longOffset",
    }).formatToParts(at);
    const raw = parts.find((part) => part.type === "timeZoneName")?.value ?? "";
    // longOffset 给的是 "GMT+08:00"；UTC 会是 "GMT"
    if (raw === "GMT") return "UTC+00:00";
    const match = /GMT([+-])(\d{2}):(\d{2})/.exec(raw);
    if (!match) return null;
    return `UTC${match[1]}${match[2]}:${match[3]}`;
  } catch {
    return null;
  }
}

/** 「中国标准时间 · 上海 · UTC+08:00」；表里没有的 IANA 只回显名字。 */
export function zoneLabel(iana: string, at: Date = new Date()): string {
  const zone = COMMON_ZONES.find((item) => item.iana === iana);
  const offset = offsetFor(iana, at);
  if (!zone) return offset ? `${iana} · ${offset}` : iana;
  return `${zone.zh} · ${zone.city}${offset ? ` · ${offset}` : ""}`;
}

/** 中文名、城市、IANA 都能搜；空查询返回全部候选。 */
export function searchZones(query: string, zones: ZoneInfo[] = COMMON_ZONES): ZoneInfo[] {
  const norm = (text: string) => text.toLowerCase().replace(/[_-]/g, " ").replace(/\s+/g, " ").trim();
  const q = norm(query);
  if (q === "") return zones;
  return zones.filter((zone) =>
    [zone.zh, zone.city, zone.iana].some((field) => norm(field).includes(q)),
  );
}

/** 输入是否是可保存的时区：先查表，再交给 Intl 验证任意合法 IANA。 */
export function resolveZone(input: string): string | null {
  const value = input.trim();
  if (value === "") return null;
  const hit = COMMON_ZONES.find((zone) => zone.iana.toLowerCase() === value.toLowerCase());
  if (hit) return hit.iana;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}
