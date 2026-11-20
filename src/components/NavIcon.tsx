import type { CSSProperties } from "react";

/**
 * 「Arctic Line」导航图标集。
 *
 * 统一规范（七个图标逐条遵守，不是各画各的）：
 *   - viewBox 0 0 24 24，内容限制在 3.2–20.8 的安全区内；
 *   - 线宽 1.8，`stroke-linecap/linejoin: round`，`fill: none`，颜色继承 `currentColor`；
 *   - 只用圆角几何：圆、圆角矩形、直线、单段贝塞尔，无填充、无渐变、无装饰；
 *   - 每个图标 3–5 条笔画，保证 20px 显示时不会糊成一片。
 *
 * 语义与造型的对应关系见 docs/UI-NAV-ICON-REFINE-RESULTS.md §1。
 */

export type NavIconName =
  | "dashboard"
  | "orders"
  | "clients"
  | "templates"
  | "stats"
  | "settings"
  | "status"
  | "calendar"
  | "trash";

type IconShape =
  /** 圆角矩形：x y w h r */
  | { kind: "rect"; x: number; y: number; w: number; h: number; r: number }
  | { kind: "circle"; cx: number; cy: number; r: number }
  | { kind: "path"; d: string };

const rect = (x: number, y: number, w: number, h: number, r: number): IconShape => ({
  kind: "rect",
  x,
  y,
  w,
  h,
  r,
});
const circle = (cx: number, cy: number, r: number): IconShape => ({ kind: "circle", cx, cy, r });
const path = (d: string): IconShape => ({ kind: "path", d });

export const NAV_ICON_SHAPES: Record<NavIconName, IconShape[]> = {
  // 多区域布局面板：外框 + 一条竖分隔 + 右栏一条横分隔 = 三个区块
  dashboard: [
    rect(3.2, 3.2, 17.6, 17.6, 3.2),
    path("M9.8 3.4V20.6"),
    path("M10 12H20.6"),
  ],

  // 委托卡片：一张圆角卡片 + 两行"文字"，第二行更短，避免剪贴板式装饰
  orders: [
    rect(3.4, 4.6, 17.2, 14.8, 3),
    path("M7.6 9.9H16.4"),
    path("M7.6 14.6H13.4"),
  ],

  // 客户：两个人，前方一个完整轮廓，右后方一个略小且位置稍高，只保留头与肩
  clients: [
    circle(8.4, 8.3, 2.5),
    path("M4 19.8c0-2.4 2-4.4 4.4-4.4s4.4 2 4.4 4.4"),
    circle(17.1, 9.5, 2),
    path("M14.2 19.8c0-1.9 1.3-3.3 2.9-3.3s2.9 1.4 2.9 3.3"),
  ],

  // 流程：三个节点等距串联，两条短连线，强调"步骤依次经过"
  templates: [
    circle(5.4, 6.4, 2),
    circle(12, 12, 2),
    circle(18.6, 17.6, 2),
    path("M6.8 7.8L10.6 10.6"),
    path("M13.4 13.4L17.2 16.2"),
  ],

  // 历史统计：三根渐高的柱子 + 基线；柱高本身承担"趋势"语义
  stats: [
    path("M3.4 20.4H20.6"),
    rect(4.4, 13.2, 3.8, 6.6, 1.1),
    rect(10.1, 9.6, 3.8, 10.2, 1.1),
    rect(15.8, 6, 3.8, 13.8, 1.1),
  ],

  // 设置：三条横向滑轨 + 各自的竖向把手，位置错开（不再用齿轮）
  settings: [
    path("M3.4 6.6H20.6"),
    path("M15.4 4.4V8.8"),
    path("M3.4 12H20.6"),
    path("M8.6 9.8V14.2"),
    path("M3.4 17.4H20.6"),
    path("M17.2 15.2V19.6"),
  ],

  // 数据环境：数据库柱体，一段顶部椭圆 + 两条侧边 + 一道中缝，无锁具盾牌
  status: [
    { kind: "path", d: "M4 7c0-1.88 3.58-3.4 8-3.4s8 1.52 8 3.4-3.58 3.4-8 3.4-8-1.52-8-3.4z" },
    path("M4 7V17.4"),
    path("M20 7V17.4"),
    path("M4 12.2c0 1.88 3.58 3.4 8 3.4s8-1.52 8-3.4"),
  ],
  // 日历：外框 + 顶部装订线 + 中间横线，四个角留空避免与网格混在一起。
  calendar: [
    rect(4, 5.6, 16, 14.4, 2.4),
    path("M4 10.2H20"),
    path("M8.6 3.6V7.2"),
    path("M15.4 3.6V7.2"),
  ],

  // 回收站：桶身 + 桶盖 + 提手 + 两道竖纹。
  // 不用「垃圾桶翻倒」或「碎纸机」那类造型，避免在 20px 下变成一团。
  trash: [
    rect(6.6, 7.4, 10.8, 12, 1.8),
    path("M4.8 7.4H19.2"),
    path("M9.4 7.2V5.2H14.6V7.2"),
    path("M10.4 10.8V16"),
    path("M13.6 10.8V16"),
  ],
};

type Props = {
  name: NavIconName;
  className?: string;
  style?: CSSProperties;
};

/**
 * 七个导航图标共用的渲染器：几何数据与描边参数集中在 `NAV_ICON_SHAPES`
 * 与下面这一处，避免七个 SVG 各自带一套 stroke 属性慢慢跑偏。
 */
export function NavIcon({ name, className = "nav-icon", style }: Props) {
  const shapes = NAV_ICON_SHAPES[name];
  return (
    <svg
      className={className}
      style={style}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-nav-icon={name}
    >
      {shapes.map((shape, index) => {
        if (shape.kind === "circle") {
          return <circle key={index} cx={shape.cx} cy={shape.cy} r={shape.r} />;
        }
        if (shape.kind === "rect") {
          return (
            <rect
              key={index}
              x={shape.x}
              y={shape.y}
              width={shape.w}
              height={shape.h}
              rx={shape.r}
            />
          );
        }
        return <path key={index} d={shape.d} />;
      })}
    </svg>
  );
}
