/**
 * 非模态浮层的层级栈。
 *
 * `modalStack` 管的是会阻断交互的模态（确认框、图片查看器）：它同时决定焦点归属和
 * 「谁该响应 Esc」。右键菜单不阻断交互——页面照旧可见可点——但它同样要独占一次 Esc，
 * 否则一次按键会同时收起菜单和它下面的详情抽屉。
 *
 * 为什么不直接塞进 `modalStack`：那会让整个应用以为「当前有模态打开」，
 * 顺手改掉页面快捷键的可用性、退出请求的排队方式，副作用比收益大得多。
 * 这里只回答一个问题：最上层的浮层是谁。
 */

let stack: string[] = [];

export function pushLayer(id: string): void {
  stack = stack.filter((item) => item !== id);
  stack.push(id);
}

export function popLayer(id: string): void {
  stack = stack.filter((item) => item !== id);
}

export function topLayer(): string | null {
  return stack.length > 0 ? (stack[stack.length - 1] ?? null) : null;
}

export function isTopLayer(id: string): boolean {
  return topLayer() === id;
}

/** 测试用：清空栈，避免用例之间互相影响。 */
export function resetLayerStack(): void {
  stack = [];
}
