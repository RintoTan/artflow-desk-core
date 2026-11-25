/** 右键菜单的视口收敛。

菜单贴着指针出现，但它在 `position: fixed` 下只能落在可视区域内：靠近右下角时
必须往内收，否则用户点到的位置贴着屏幕边缘，菜单会被裁掉一半。

这段算法单独抽出来是为了能直接测边界——jsdom 里量不出真实尺寸，
把一个「等着浏览器量」的逻辑埋在组件里，等于永远测不到右边界和底部边界。
*/

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };

export const MENU_GAP = 8;

/**
 * 把菜单左上角收敛进视口。
 *
 * 三项都是「先夹到允许范围，再取指针位置」：菜单比视口还大时，允许范围退化成 gap，
 * 此时以左上对齐优先——顶部和左侧永远可见，比两侧都被裁要好。
 */
export function placeContextMenu(
  point: Point,
  size: Size,
  viewport: Size,
  gap: number = MENU_GAP,
): { top: number; left: number } {
  const maxLeft = Math.max(gap, viewport.width - size.width - gap);
  const maxTop = Math.max(gap, viewport.height - size.height - gap);
  return {
    left: Math.min(Math.max(gap, point.x), maxLeft),
    top: Math.min(Math.max(gap, point.y), maxTop),
  };
}
