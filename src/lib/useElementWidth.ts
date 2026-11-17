import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 量一个元素的**内容宽度**（不是窗口宽度）。
 *
 * 图表要不要从单排变两排，取决于图表自己能拿到多少宽度——
 * 侧栏折叠、面板内边距都会改变这个值，而窗口宽度不会。
 *
 * 返回**回调 ref** 而不是 RefObject：图表是条件渲染的（数据回来才出现），
 * `useEffect(…, [])` 会在节点还不存在时跑完就再也不跑，宽度永远停在 0。
 * 回调 ref 在节点真正挂上时立刻量一次，随后交给 ResizeObserver。
 */
export function useElementWidth<T extends HTMLElement>(): [(node: T | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);

  const attach = useCallback((node: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;

    setWidth(node.getBoundingClientRect().width);

    if (typeof ResizeObserver === "undefined") return;
    const next = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width ?? 0;
      // 亚像素抖动不算变化，避免来回重渲染
      setWidth((current) => (Math.abs(current - measured) < 1 ? current : measured));
    });
    next.observe(node);
    observer.current = next;
  }, []);

  useEffect(() => () => observer.current?.disconnect(), []);

  return [attach, width];
}
