import { afterEach, describe, expect, it, vi } from "vitest";

import {
  activeGuard,
  hasUnsavedDraft,
  registerUnsavedGuard,
  resetUnsavedGuards,
} from "./unsavedRegistry";

afterEach(() => {
  resetUnsavedGuards();
});

describe("未保存草稿登记表", () => {
  it("只有 dirty 的登记项参与保护", () => {
    registerUnsavedGuard({
      id: "clean",
      isDirty: () => false,
      save: async () => null,
      discard: () => {},
    });
    expect(hasUnsavedDraft()).toBe(false);

    registerUnsavedGuard({
      id: "dirty",
      isDirty: () => true,
      save: async () => null,
      discard: () => {},
    });
    expect(hasUnsavedDraft()).toBe(true);
    expect(activeGuard()?.id).toBe("dirty");
  });

  it("内层（后登记）的草稿优先，注销后回落到外层", () => {
    registerUnsavedGuard({
      id: "page",
      isDirty: () => true,
      save: async () => null,
      discard: () => {},
    });
    const unregisterInner = registerUnsavedGuard({
      id: "create-panel",
      isDirty: () => true,
      save: async () => null,
      discard: () => {},
    });

    expect(activeGuard()?.id).toBe("create-panel");
    unregisterInner();
    expect(activeGuard()?.id).toBe("page");
  });

  it("注销后不再被保护", () => {
    const unregister = registerUnsavedGuard({
      id: "only",
      isDirty: () => true,
      save: async () => null,
      discard: () => {},
    });
    unregister();
    expect(hasUnsavedDraft()).toBe(false);
  });

  it("读取的是最新一次判断，而不是注册时的快照", () => {
    let dirty = false;
    registerUnsavedGuard({
      id: "live",
      isDirty: () => dirty,
      save: async () => null,
      discard: () => {},
    });
    expect(hasUnsavedDraft()).toBe(false);
    dirty = true;
    expect(hasUnsavedDraft()).toBe(true);
  });

  it("save 的返回值原样透传（失败原因不吞掉）", async () => {
    const save = vi.fn(async () => "revision 冲突");
    registerUnsavedGuard({
      id: "failing",
      isDirty: () => true,
      save,
      discard: () => {},
    });
    await expect(activeGuard()?.save()).resolves.toBe("revision 冲突");
  });
});
