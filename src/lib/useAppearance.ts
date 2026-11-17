import { useSyncExternalStore } from "react";

import { currentAppearance, subscribeAppearance } from "./appIcon";
import type { Appearance } from "./appIcon";

/**
 * 当前实际生效的外观（浅色 / 深色）。
 *
 * 直接复用主题模块的订阅：主题预览、放弃草稿、系统外观变化都会经过同一个
 * notify 通道，所以这里不需要、也不应该再挂一个 matchMedia 监听器。
 */
export function useAppearance(): Appearance {
  return useSyncExternalStore(
    subscribeAppearance,
    currentAppearance,
    currentAppearance,
  );
}
