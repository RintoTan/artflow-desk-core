import { describe, expect, it } from "vitest";

import type { ClientView } from "../bridge/commands";
import fixture from "./__fixtures__/qa-clients-53.json";
import { filterAndSortClients } from "./clientsView";

// 53 客户夹具直接从 QA 库导出（QA 客户 + 一条旧种子客户），
// 用真实的数量分布验证搜索 / 标签交集 / 排序口径。
const clients = fixture as ClientView[];
const names = (list: ClientView[]) => list.map((c) => c.displayName);

describe("50+ 客户规模：搜索", () => {
  it("总数 53", () => {
    expect(clients).toHaveLength(53);
    expect(filterAndSortClients(clients)).toHaveLength(53);
  });

  it("按名称搜索的命中数与答案卡一致", () => {
    expect(filterAndSortClients(clients, { query: "QA 客户 1" })).toHaveLength(10);
    expect(filterAndSortClients(clients, { query: "QA 客户 2" })).toHaveLength(10);
    expect(names(filterAndSortClients(clients, { query: "QA 客户 01" }))).toEqual([
      "QA 客户 01",
    ]);
  });

  it("零填充编号不会被前一位数字误命中", () => {
    const hit = filterAndSortClients(clients, { query: "QA 客户 1" });
    expect(hit.some((c) => c.displayName === "QA 客户 01")).toBe(false);
  });

  it("清空搜索恢复全部，查无此人返回空", () => {
    expect(filterAndSortClients(clients, { query: "" })).toHaveLength(53);
    expect(filterAndSortClients(clients, { query: "查无此人" })).toHaveLength(0);
  });
});

describe("50+ 客户规模：标签交集", () => {
  it("各标签命中数与答案卡一致", () => {
    expect(filterAndSortClients(clients, { tagId: "tag-1" })).toHaveLength(3);
    expect(filterAndSortClients(clients, { tagId: "tag-4" })).toHaveLength(2);
  });

  it("标签与搜索取交集", () => {
    expect(
      filterAndSortClients(clients, { tagId: "tag-1", query: "周" }),
    ).toHaveLength(0);
    expect(
      filterAndSortClients(clients, { tagId: "tag-1", query: "QA 客户" }),
    ).toHaveLength(3);
  });
});

describe("50+ 客户规模：排序", () => {
  it("订单数量排序：前三条各 6 单，且降序", () => {
    const list = filterAndSortClients(clients, { sort: "orders" });
    expect(list.slice(0, 3).map((c) => c.orderCount)).toEqual([6, 6, 6]);
    for (let i = 1; i < list.length; i += 1) {
      expect(list[i - 1]!.orderCount).toBeGreaterThanOrEqual(list[i]!.orderCount);
    }
  });

  it("最近委托排序：有时间的在前，没时间的垫底", () => {
    const list = filterAndSortClients(clients, { sort: "recent" });
    const withTime = list.filter((c) => c.lastOrderAt !== null);
    const without = list.filter((c) => c.lastOrderAt === null);
    expect(list.slice(0, withTime.length)).toEqual(withTime);
    expect(list.slice(withTime.length)).toEqual(without);
    expect(without.length).toBe(9);
  });

  it("默认顺序与后端返回一致（按名称升序），切回不跳动", () => {
    const def = filterAndSortClients(clients);
    expect(names(def).slice(0, 3)).toEqual(["QA 客户 01", "QA 客户 02", "QA 客户 03"]);
    expect(names(filterAndSortClients(clients))).toEqual(names(def));
  });
});
