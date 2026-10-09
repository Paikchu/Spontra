"use client";

import { useEffect, useState } from "react";
import { cachedCompanyLogo, loadCompanyLogo } from "@/packages/web/src/company-logo-cache";

export function CompanyLogo({ symbol, size = "sm" }: { symbol: string; size?: "sm" | "lg" }) {
  const [image, setImage] = useState<{ symbol: string; src: string } | null>(null);
  const src = image?.symbol === symbol ? image.src : cachedCompanyLogo(symbol);
  useEffect(() => {
    let active = true;
    void loadCompanyLogo(symbol).then((src) => {
      if (active) setImage({ symbol, src });
    }).catch(() => { /* Keep the ticker fallback when the image is unavailable. */ });
    return () => { active = false; };
  }, [symbol]);
  const fallback = symbol.replace(/[^A-Z0-9]/gi, "").slice(0, 2).toUpperCase() || "·";

  return (
    <span className="company-logo" aria-hidden="true" data-failed={!src || undefined} data-size={size}>
      <span className="company-logo-fallback">{fallback}</span>
      {src && (
        // The logo host is ticker-driven, so a native image keeps the resilient onError fallback.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          alt=""
          decoding="async"
          loading={size === "lg" ? "eager" : "lazy"}
          onError={(event) => {
            event.currentTarget.style.display = "none";
            event.currentTarget.parentElement?.setAttribute("data-failed", "true");
          }}
          referrerPolicy="no-referrer"
          src={src}
        />
      )}
    </span>
  );
}
