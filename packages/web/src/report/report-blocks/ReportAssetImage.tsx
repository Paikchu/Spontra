"use client";

import { useState } from "react";
import { messages } from "@/packages/web/src/i18n";

const m = messages({ unavailable: (alt: string) => `Image unavailable: ${alt}` }, { unavailable: (alt: string) => `图片不可用：${alt}` });

/** Width and height reserve the final space; image failures keep the caption and reading position. */
export function ReportAssetImage({ src, alt, width, height }: { src: string; alt: string; width: number; height: number }) {
  const [failed, setFailed] = useState(false);
  return <div className="report-content-image-frame" style={{ aspectRatio: `${width} / ${height}` }}>
    {failed ? <p className="report-content-image-fallback">{m.unavailable(alt)}</p>
      // The source has already been resolved from the validated persistent asset manifest.
      // eslint-disable-next-line @next/next/no-img-element
      : <img src={src} alt={alt} width={width} height={height} loading="lazy" decoding="async" onError={() => setFailed(true)} />}
  </div>;
}
