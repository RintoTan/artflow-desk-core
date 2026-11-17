import { useSyncExternalStore } from "react";

/**
 * 模态层栈。
 *
 * 应用里可以叠两层模态：图片查看器在最下面，确认框叠在它上面。
 * 只用 z-index 解决"谁盖住谁"，解决不了"Esc 该关谁"——两个组件都监听
 * document 的 keydown，会一起响应。所以用一个栈记录顺序，**只有栈顶**处理 Esc。
 */

let stack: string[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function pushModal(id: string): void {
  stack = stack.filter((item) => item !== id);
  stack.push(id);
  emit();
}

export function popModal(id: string): void {
  const next = stack.filter((item) => item !== id);
  if (next.length === stack.length) return;
  stack = next;
  emit();
}

export function topModal(): string | null {
  return stack.length > 0 ? stack[stack.length - 1] ?? null : null;
}

export function isTopModal(id: string): boolean {
  return topModal() === id;
}

/** 测试用：清空栈，避免用例之间互相影响。 */
export function resetModalStack(): void {
  stack = [];
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 该模态是否是当前栈顶（用于禁用背景交互与判断 Esc 归属）。 */
export function useIsTopModal(id: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isTopModal(id),
    () => false,
  );
}
