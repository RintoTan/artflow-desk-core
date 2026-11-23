export type ChipDropMode = "start" | "delivery" | "move";

/**
 * 日历条按下时该进入哪种拖拽。
 *
 * 端点抓手（左右各 14px）优先于按比例判断：抓手压在条的边缘，
 * 而「改期」按钮就紧贴右侧，靠比例阈值容易把右端拖拽判成整条平移。
 */
export function chipDropZone(input: {
  singleDay: boolean;
  clippedLeft: boolean;
  clippedRight: boolean;
  /** 命中的是哪个抓手；没命中为 null */
  handle: "start" | "end" | null;
  /** 指针在条内的相对位置 0–1 */
  ratio: number;
  /** 条宽（px），用于决定边缘比例阈值 */
  width: number;
}): ChipDropMode {
  if (input.singleDay) return "move";
  if (input.handle === "start" && !input.clippedLeft) return "start";
  if (input.handle === "end" && !input.clippedRight) return "delivery";

  const edge = Math.min(0.25, 14 / Math.max(input.width, 1));
  if (input.ratio <= edge && !input.clippedLeft) return "start";
  if (input.ratio >= 1 - edge && !input.clippedRight) return "delivery";
  return "move";
}
