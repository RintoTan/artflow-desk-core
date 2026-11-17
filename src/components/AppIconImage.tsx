import { useEffect, useState } from "react";

import { iconAsset, type Appearance, type IconVariant } from "../lib/appIcon";

type Props = {
  variant: IconVariant;
  appearance: Appearance;
  className?: string;
  size: number;
  /** 装饰性图标（旁边已有文字）时传空字符串 */
  alt?: string;
};

/**
 * 应用图标 <img>。
 *
 * 资源加载失败（文件缺失、打包漏了）时回退到**同一外观**下的 Orbit，
 * 而不是什么都不显示，也不回退到另一套配色——否则深色界面上会突然出现
 * 一块浅色底。
 */
export function AppIconImage({ variant, appearance, className, size, alt = "" }: Props) {
  const [failed, setFailed] = useState(false);

  // 换图标或换主题后重新给一次机会
  useEffect(() => setFailed(false), [variant, appearance]);

  const src = failed ? iconAsset("orbit", appearance) : iconAsset(variant, appearance);

  return (
    <img
      className={className}
      src={src}
      width={size}
      height={size}
      alt={alt}
      aria-hidden={alt === "" ? "true" : undefined}
      data-icon-variant={variant}
      data-icon-appearance={appearance}
      data-icon-fallback={failed ? "orbit" : undefined}
      onError={() => setFailed(true)}
      draggable={false}
    />
  );
}
