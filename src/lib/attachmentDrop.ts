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
