/**
 * 委托类型：高频预设 + 自由输入。
 *
 * 预设只做「一点就有」的快捷方式，不是封闭枚举——画师会接清单之外的委托，
 * 所以字段本身仍然是自由文本，预设值也不进数据库约束。
 */
export const COMMISSION_TYPES = [
  "插画",
  "组合页",
  "服设",
  "设定卡",
  "表情包",
  "头像",
  "摸鱼",
] as const;

/** 标题的拼接符。客户名和类型之间留一个轻分隔，避免连成一个词。 */
export const TITLE_SEPARATOR = " · ";

/**
 * 按「客户名称 + 委托类型」生成标题。
 *
 * 缺任何一半都返回 null：只有类型没有客户时生成「· 插画」之类的东西没有意义，
 * 这时候应该让用户自己写标题，而不是替他填一个半截的。
 */
export function suggestOrderTitle(clientName: string, commissionType: string): string | null {
  const name = clientName.trim();
  const type = commissionType.trim();
  if (name === "" || type === "") return null;
  return `${name}${TITLE_SEPARATOR}${type}`;
}
