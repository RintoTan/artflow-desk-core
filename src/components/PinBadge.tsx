/**
 * 置顶标记。
 *
 * 刻意做得很轻：置顶是「排在前面」的说明，不是新的订单状态，所以它用中性色、
 * 小尺寸，紧挨着订单编号出现，不与标题争视觉权重。
 *
 * 用 SVG 而不是 emoji：emoji 在不同系统里字形差异大，还会把行高顶开。
 */
export default function PinBadge({ label = "已置顶" }: { label?: string }) {
  return (
    <span className="pin-badge" title={label} aria-label={label} role="img">
      <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" focusable="false">
        <path
          d="M7.6 1.2 10.8 4.4 9.4 5.2 9 7.6 6.9 6.9 4.4 9.4 3.6 8.6 6.1 6.1 5.4 4 7.8 3.6Z"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}
