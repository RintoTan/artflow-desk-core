import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

import type { OrderCover } from "../bridge/commands";

type Props = {
  cover?: OrderCover;
  /** 替代文本。列表里标题就在旁边，默认留空当装饰图，不重复朗读。 */
  alt?: string;
};

/**
 * 列表里的一张小封面。
 *
 * 三级回退：缩略图 → 原图 → 统一占位块。图片加载失败（文件被删、格式坏了）
 * 也退到占位块——列表里出现一个碎图标比没有图更难看。
 */
export default function OrderThumb({ cover, alt = "" }: Props) {
  const path = cover ? (cover.thumbPath ?? cover.originalPath) : null;
  const [failed, setFailed] = useState(false);

  // 换订单之后要允许重试，否则一次失败会永久粘住
  useEffect(() => setFailed(false), [path]);

  if (!path || failed) {
    return <span className="order-thumb order-thumb-empty" aria-hidden="true" />;
  }
  return (
    <span className="order-thumb">
      <img src={convertFileSrc(path)} alt={alt} loading="lazy" onError={() => setFailed(true)} />
    </span>
  );
}
