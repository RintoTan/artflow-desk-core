import layersUrl from "../assets/app-icons/layers.svg";
import orbitUrl from "../assets/app-icons/orbit.svg";
import waveAUrl from "../assets/app-icons/wave-a.svg";
import { iconApi } from "../bridge/commands";

/**
 * 应用图标变体：和主题一样分成"已保存 / 预览"两层。
 *
 * 稳定标识（orbit / layers / wave-a）是落库和比对的唯一依据；
 * 展示名只用于界面，改名不会让已保存的选择失效。
 */

export type IconVariant = "orbit" | "layers" | "wave-a";

/** 顺序即设置页的展示顺序，第一个是默认。 */
export const ICON_VARIANTS: IconVariant[] = ["orbit", "layers", "wave-a"];
export const DEFAULT_ICON_VARIANT: IconVariant = "orbit";

export const ICON_LABEL: Record<IconVariant, string> = {
  orbit: "Orbit",
  layers: "Layers",
  "wave-a": "Wave A",
};

export const ICON_DESCRIPTION: Record<IconVariant, string> = {
  orbit: "双轨道与星形",
  layers: "几何层叠与六边形",
  "wave-a": "字母 A 与流动曲线",
};

const ICON_ASSET: Record<IconVariant, string> = {
  orbit: orbitUrl,
  layers: layersUrl,
  "wave-a": waveAUrl,
};

let saved: IconVariant = DEFAULT_ICON_VARIANT;
let preview: IconVariant | null = null;
let loaded = false;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function subscribeIcon(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 当前应该显示哪一套：有预览用预览，否则用已保存（渲染路径只读这个）。 */
export function currentIcon(): IconVariant {
  return preview ?? saved;
}

export function savedIcon(): IconVariant {
  return saved;
}

export function hasIconPreview(): boolean {
  return preview !== null;
}

export function isIconLoaded(): boolean {
  return loaded;
}

/** 非法 / 空值 / 旧版本没有该键 → orbit。 */
export function normalizeIcon(raw: string | null | undefined): IconVariant {
  return raw === "layers" || raw === "wave-a" || raw === "orbit" ? raw : DEFAULT_ICON_VARIANT;
}

export function iconAsset(variant: IconVariant = currentIcon()): string {
  return ICON_ASSET[variant];
}

/** 预览：只改渲染，不落库。 */
export function setIconPreview(variant: IconVariant): void {
  preview = normalizeIcon(variant);
  notify();
}

export function clearIconPreview(): void {
  preview = null;
  notify();
}

/** 启动时读一次；失败就停在默认图标，不阻塞界面。 */
export async function loadIcon(): Promise<void> {
  try {
    const info = await iconApi.get();
    saved = normalizeIcon(info.variant);
  } catch {
    saved = DEFAULT_ICON_VARIANT;
  }
  loaded = true;
  notify();
}

/** 保存：成功才更新已保存值；失败返回错误文本，界面保留预览。 */
export async function persistIcon(variant: IconVariant): Promise<string | null> {
  try {
    const info = await iconApi.set(normalizeIcon(variant));
    saved = normalizeIcon(info.variant);
    preview = null;
    notify();
    return null;
  } catch (e) {
    const message =
      e && typeof e === "object" && "message" in e
        ? String((e as { message: unknown }).message)
        : "应用图标保存失败";
    return message;
  }
}

/** 测试用：重置模块状态。 */
export function resetIconForTests(): void {
  saved = DEFAULT_ICON_VARIANT;
  preview = null;
  loaded = false;
  listeners.clear();
}
