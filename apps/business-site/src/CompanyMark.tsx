import { useState } from "react";

/** Same public logo host as the main app; CSP allows only this image origin. The ticker monogram stays when it fails. */
const logoUrl = (ticker: string) => `https://images.financialmodelingprep.com/symbol/${encodeURIComponent(ticker)}.png`;

export function CompanyMark({ ticker, detail }: { ticker: string; detail?: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  const loaded = failed !== ticker;
  return <div className="company">
    <span className="company-logo" data-failed={!loaded || undefined} aria-hidden="true">
      <span className="company-logo-fallback">{ticker.replace(/[^A-Z0-9]/g, "").slice(0, 2) || "·"}</span>
      {/* Vite app, not Next: a native image keeps the onError monogram fallback. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {loaded && <img key={ticker} src={logoUrl(ticker)} alt="" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(ticker)} />}
    </span>
    <span className="company-text">
      <strong className="company-ticker">{ticker}</strong>
      {detail && <span className="company-detail">{detail}</span>}
    </span>
  </div>;
}
