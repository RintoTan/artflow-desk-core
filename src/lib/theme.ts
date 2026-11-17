import { themeApi, type ThemeInfo } from "../bridge/commands";

/**
 * 主题的三个概念必须分开，混在一起就会出现"跟随系统变成永远的深色"：
 *
 * 1. **用户选择**（mode）：arctic / dark / system —— 存的就是这个；
 * 2. **实际外观**（resolved）：arctic / dark —— 只在渲染时计算；
 * 3. **自定义强调色**（accent）：#rrggbb 或 null。
 *
 * 预览（preview）是第四层：设置页里改了但还没保存，只影响当前渲染，不落库。
 */
export type ThemeMode = "arctic" | "dark" | "system";
export type ResolvedTheme = "arctic" | "dark";
export type ThemeChoice = { mode: ThemeMode; accent: string | null };

export const THEME_MODES: ThemeMode[] = ["arctic", "dark", "system"];
export const DEFAULT_CHOICE: ThemeChoice = { mode: "arctic", accent: null };

let saved: ThemeChoice = { ...DEFAULT_CHOICE };
let preview: ThemeChoice | null = null;
let systemDark = false;
let loaded = false;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function currentChoice(): ThemeChoice {
  return preview ?? saved;
}

/** 当前是否处于"未保存的预览"状态。 */
export function hasPreview(): boolean {
  return preview !== null;
}

export function savedChoice(): ThemeChoice {
  return saved;
}

export function systemPrefersDark(): boolean {
  return systemDark;
}

export function isThemeLoaded(): boolean {
  return loaded;
}

export function normalizeMode(raw: string | null | undefined): ThemeMode {
  return raw === "dark" || raw === "system" || raw === "arctic" ? raw : "arctic";
}

export function normalizeAccent(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(value) ? value : null;
}

export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === "dark") return "dark";
  if (mode === "system") return prefersDark ? "dark" : "arctic";
  return "arctic";
}

// ---------------------------------------------------------------- 颜色工具

export function hexToRgb(hex: string): [number, number, number] | null {
  const value = normalizeAccent(hex);
  if (!value) return null;
  return [
    parseInt(value.slice(1, 3), 16),
    parseInt(value.slice(3, 5), 16),
    parseInt(value.slice(5, 7), 16),
  ];
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/** WCAG 2.x 对比度，1–21。 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/** 强调色上应该配白字还是深字。 */
export function contrastTextOn(hex: string): "#ffffff" | "#16283c" {
  return contrastRatio(hex, "#ffffff") >= contrastRatio(hex, "#16283c") ? "#ffffff" : "#16283c";
}

/** 把强调色调淡，用作 soft 背景（与主题底色混合）。 */
export function softAccent(hex: string, theme: ResolvedTheme): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return "transparent";
  const base = theme === "dark" ? [24, 30, 38] : [255, 255, 255];
  const mix = (i: number) => Math.round(base[i]! + (rgb[i]! - base[i]!) * (theme === "dark" ? 0.22 : 0.14));
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
}

export type AccentCheck = {
  ratioOnSurface: number;
  ratioOnText: number;
  level: "ok" | "warn";
  message: string | null;
};

/**
 * 只检查两件真正会出问题的事：
 * - 强调色与背景的对比（焦点描边、链接文字是否看得见）；
 * - 强调色与"按钮上的字"的对比（主按钮文字是否读得出来）。
 * 不声称整个应用通过无障碍认证。
 */
export function checkAccent(accent: string, theme: ResolvedTheme): AccentCheck | null {
  const value = normalizeAccent(accent);
  if (!value) return null;
  const surface = theme === "dark" ? "#182028" : "#ffffff";
  const ratioOnSurface = contrastRatio(value, surface);
  const text = contrastTextOn(value);
  const ratioOnText = contrastRatio(value, text);
  if (ratioOnSurface < 3) {
    return {
      ratioOnSurface,
      ratioOnText,
      level: "warn",
      message: `强调色与背景对比度只有 ${ratioOnSurface.toFixed(1)}:1（低于 3:1），焦点描边和链接可能看不清`,
    };
  }
  if (ratioOnText < 4.5) {
    return {
      ratioOnSurface,
      ratioOnText,
      level: "warn",
      message: `强调色上的文字对比度 ${ratioOnText.toFixed(1)}:1（低于 4.5:1），按钮文字可能读不清`,
    };
  }
  return { ratioOnSurface, ratioOnText, level: "ok", message: null };
}

// ---------------------------------------------------------------- 应用

const ACCENT_VARS = ["--accent", "--accent-soft", "--accent-contrast"] as const;

export function applyTheme(
  root: HTMLElement,
  choice: ThemeChoice,
  prefersDark = systemDark,
): ResolvedTheme {
  const resolved = resolveTheme(choice.mode, prefersDark);
  root.setAttribute("data-theme", resolved);
  const accent = normalizeAccent(choice.accent);
  if (accent) {
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-soft", softAccent(accent, resolved));
    root.style.setProperty("--accent-contrast", contrastTextOn(accent));
  } else {
    for (const name of ACCENT_VARS) root.style.removeProperty(name);
  }
  return resolved;
}

// ---------------------------------------------------------------- 与后端同步

function fromInfo(info: ThemeInfo): ThemeChoice {
  return { mode: normalizeMode(info.mode), accent: normalizeAccent(info.accent) };
}

/** 启动时读一次；失败就停在默认主题，不阻塞界面。 */
export async function loadTheme(): Promise<void> {
  try {
    const info = await themeApi.get();
    saved = fromInfo(info);
  } catch {
    saved = { ...DEFAULT_CHOICE };
  }
  loaded = true;
  notify();
}

/** 预览：只改渲染，不落库。 */
export function setPreview(choice: ThemeChoice): void {
  preview = { mode: normalizeMode(choice.mode), accent: normalizeAccent(choice.accent) };
  notify();
}

export function clearPreview(): void {
  preview = null;
  notify();
}

/** 保存：成功才更新已保存值；失败返回错误文本，界面保留预览。 */
export async function persistTheme(choice: ThemeChoice): Promise<string | null> {
  try {
    const info = await themeApi.set(choice.mode, normalizeAccent(choice.accent));
    saved = fromInfo(info);
    preview = null;
    notify();
    return null;
  } catch (e) {
    const message =
      e && typeof e === "object" && "message" in e
        ? String((e as { message: unknown }).message)
        : "主题保存失败";
    return message;
  }
}

/** 监听系统外观。返回清理函数；内部保证只订阅一次。 */
export function watchSystemAppearance(): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  systemDark = media.matches;
  const onChange = (event: MediaQueryListEvent) => {
    systemDark = event.matches;
    notify();
  };
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** 测试用：重置模块状态。 */
export function resetThemeForTests(): void {
  saved = { ...DEFAULT_CHOICE };
  preview = null;
  systemDark = false;
  loaded = false;
  listeners.clear();
}
