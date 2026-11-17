import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * 跨页面的「未保存草稿」登记表。
 *
 * 为什么需要它：窗口关闭（macOS 红色按钮 / Cmd+Q）发生在页面之外，
 * 外壳必须能在不重写每页 dirty 逻辑的前提下，问一句"现在有草稿吗、能存吗"。
 * 所以页面把自己已有的 dirty 判断、保存函数、放弃动作登记进来，
 * **不新增第二套 dirty 状态**。
 *
 * 规则：最后登记且仍然 dirty 的那一个生效（内层表单优先于外层页面）。
 */
export type UnsavedGuard = {
  id: string;
  /** 给用户看的名字（出现在关窗确认与错误里） */
  label: string;
  isDirty: () => boolean;
  /** 保存当前草稿。返回 null 表示成功；返回字符串表示失败原因（窗口必须保持打开）。 */
  save: () => Promise<string | null>;
  /** 丢弃内存中的草稿（不调用保存，也不写库）。 */
  discard: () => void;
};

type Entry = { order: number; guard: UnsavedGuard };

let entries: Entry[] = [];
let nextOrder = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function registerUnsavedGuard(guard: UnsavedGuard): () => void {
  const entry: Entry = { order: nextOrder++, guard };
  entries = [...entries, entry];
  emit();
  return () => {
    const next = entries.filter((item) => item !== entry);
    if (next.length === entries.length) return;
    entries = next;
    emit();
  };
}

/**
 * 全部仍有草稿的 guard，**内层优先**（后登记的先返回）。
 *
 * 关闭窗口时必须逐个处理：只保存"最后一个"会让外层页面的草稿被内层表单遮住后静默丢掉。
 */
export function dirtyGuards(): UnsavedGuard[] {
  const out: UnsavedGuard[] = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry && entry.guard.isDirty()) out.push(entry.guard);
  }
  return out;
}

/** 当前需要保护的那一个（最后登记且 dirty）。 */
export function activeGuard(): UnsavedGuard | null {
  return dirtyGuards()[0] ?? null;
}

export function hasUnsavedDraft(): boolean {
  return activeGuard() !== null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 给外壳用：草稿存在与否变化时触发重渲染。 */
export function useHasUnsavedDraft(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => hasUnsavedDraft(),
    () => false,
  );
}

/** 测试用：清空登记表，避免用例互相影响。 */
export function resetUnsavedGuards(): void {
  entries = [];
  nextOrder = 1;
  emit();
}

/**
 * 页面内注册一个 guard。回调通过 ref 读取，所以每次渲染换函数不会反复注册/注销。
 */
export function useUnsavedGuard(guard: {
  id: string;
  label: string;
  dirty: boolean;
  save: () => Promise<string | null>;
  discard: () => void;
}): void {
  const dirtyRef = useRef(guard.dirty);
  const saveRef = useRef(guard.save);
  const discardRef = useRef(guard.discard);
  const idRef = useRef(guard.id);
  const labelRef = useRef(guard.label);

  dirtyRef.current = guard.dirty;
  saveRef.current = guard.save;
  discardRef.current = guard.discard;
  idRef.current = guard.id;
  labelRef.current = guard.label;

  useEffect(() => {
    const unregister = registerUnsavedGuard({
      id: idRef.current,
      label: labelRef.current,
      isDirty: () => dirtyRef.current,
      save: () => saveRef.current(),
      discard: () => discardRef.current(),
    });
    return unregister;
  }, [guard.id]);

  // dirty 变化要通知订阅者（外壳据此显示"有未保存修改"）。
  useEffect(() => {
    emit();
  }, [guard.dirty]);
}
