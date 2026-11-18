/**
 * 拖拽导入的前置过滤。
 *
 * 真正的格式/大小校验仍在 Rust 侧（魔数解码 + 100MB 上限），这里只做一件
 * 事：在发起 IPC 之前把明显不支持的路径挑出来，让用户看到「哪一张、为什么」
 * 而不是整批静默失败。规则必须与后端白名单一致。
 */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp"] as const;

export type RejectedPath = { name: string; reason: string };

export function partitionImagePaths(paths: string[]): {
  accepted: string[];
  rejected: RejectedPath[];
} {
  const accepted: string[] = [];
  const rejected: RejectedPath[] = [];

  for (const path of paths) {
    const name = path.split(/[\\/]/).pop() ?? path;
    const dot = name.lastIndexOf(".");
    if (dot <= 0 || dot === name.length - 1) {
      rejected.push({ name, reason: "没有扩展名，无法判断格式" });
      continue;
    }
    const ext = name.slice(dot + 1).toLowerCase();
    if (!(IMAGE_EXTENSIONS as readonly string[]).includes(ext)) {
      rejected.push({ name, reason: `不支持 .${ext}，只接受 PNG / JPEG / WebP` });
      continue;
    }
    accepted.push(path);
  }

  return { accepted, rejected };
}

/** Tauri 2 给的 position 是物理像素（webview 左上角原点），CSS 坐标要除以 DPR。 */
export type PhysicalPoint = { x: number; y: number };
export type ScreenPoint = { x: number; y: number };
export type Rect = { left: number; top: number; right: number; bottom: number };

export function physicalToCss(
  position: PhysicalPoint | null | undefined,
  devicePixelRatio: number,
): ScreenPoint | null {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return null;
  const scale =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return { x: position.x / scale, y: position.y / scale };
}

export function isInsideRect(point: ScreenPoint | null, rect: Rect | null, pad = 0): boolean {
  if (!point || !rect) return false;
  return (
    point.x >= rect.left - pad &&
    point.x <= rect.right + pad &&
    point.y >= rect.top - pad &&
    point.y <= rect.bottom + pad
  );
}

export type DropReason =
  | "no-paths"
  | "duplicate"
  | "order-changed"
  | "missing-position"
  | "outside";

export type DropDecision =
  | { import: true; paths: string[] }
  | { import: false; reason: DropReason };

/**
 * 是否该把这次 drop 当成"给当前订单加参考图"。
 *
 * 唯一合法目标是参考图片面板的矩形；坐标缺失、落点在面板外、拖拽期间换了订单、
 * 800ms 内的重复事件，一律不导入。任何情况下都不做"猜一个订单"的兜底。
 */
export function decideDrop(input: {
  position: PhysicalPoint | null | undefined;
  devicePixelRatio: number;
  rect: Rect | null;
  paths: string[];
  dragOrderId: string | null;
  activeOrderId: string | null;
  now: number;
  lastDropAt: number;
  dedupeMs?: number;
}): DropDecision {
  const { paths, rect, dragOrderId, activeOrderId, now, lastDropAt } = input;
  if (paths.length === 0) return { import: false, reason: "no-paths" };
  if (lastDropAt > 0 && now - lastDropAt < (input.dedupeMs ?? 800)) {
    return { import: false, reason: "duplicate" };
  }
  if (dragOrderId !== null && activeOrderId !== null && dragOrderId !== activeOrderId) {
    return { import: false, reason: "order-changed" };
  }
  const point = physicalToCss(input.position, input.devicePixelRatio);
  if (!point) return { import: false, reason: "missing-position" };
  if (!isInsideRect(point, rect)) return { import: false, reason: "outside" };
  return { import: true, paths };
}
