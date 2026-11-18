import { describe, expect, it } from "vitest";

import { COMMON_ZONES, offsetFor, resolveZone, searchZones, zoneLabel } from "./timezones";

const JAN = new Date("2026-01-15T00:00:00Z");
const JUL = new Date("2026-07-15T00:00:00Z");

describe("时区候选表", () => {
  it("中文、城市、IANA 都能搜到同一条", () => {
    expect(searchZones("上海")[0]?.iana).toBe("Asia/Shanghai");
    expect(searchZones("tokyo")[0]?.iana).toBe("Asia/Tokyo");
    expect(searchZones("Los Angeles")[0]?.iana).toBe("America/Los_Angeles");
    expect(searchZones("Asia/Shanghai")[0]?.iana).toBe("Asia/Shanghai");
    expect(searchZones("   ")).toHaveLength(COMMON_ZONES.length);
  });

  it("没有匹配时返回空数组，交给界面提示", () => {
    expect(searchZones("Atlantis")).toEqual([]);
  });

  it("显示名带中文名、城市与当前偏移", () => {
    expect(zoneLabel("Asia/Shanghai", JAN)).toBe("中国标准时间 · 上海 · UTC+08:00");
    expect(zoneLabel("Asia/Tokyo", JAN)).toContain("东京");
    expect(zoneLabel("America/Los_Angeles", JAN)).toBe("美国太平洋时间 · 洛杉矶 · UTC-08:00");
  });

  it("夏令时按时刻计算，不写死偏移", () => {
    expect(offsetFor("America/Los_Angeles", JAN)).toBe("UTC-08:00");
    expect(offsetFor("America/Los_Angeles", JUL)).toBe("UTC-07:00");
    expect(offsetFor("Europe/London", JUL)).toBe("UTC+01:00");
  });

  it("UTC 与不认识的名字", () => {
    expect(offsetFor("UTC", JAN)).toBe("UTC+00:00");
    expect(zoneLabel("Mars/Olympus", JAN)).toBe("Mars/Olympus");
  });

  it("只有合法 IANA 才允许保存", () => {
    expect(resolveZone("Asia/Shanghai")).toBe("Asia/Shanghai");
    expect(resolveZone("asia/shanghai")).toBe("Asia/Shanghai");
    expect(resolveZone("Europe/Berlin")).toBe("Europe/Berlin");
    expect(resolveZone("Not/AZone")).toBeNull();
    expect(resolveZone("")).toBeNull();
  });
});
