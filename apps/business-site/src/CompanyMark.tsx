import { useState } from "react";

/** Same public logo host as the main app; CSP allows only this image origin. The ticker monogram stays when it fails. */
const logoUrl = (ticker: string) => `https://images.financialmodelingprep.com/symbol/${encodeURIComponent(ticker)}.png`;

export function CompanyLogo({ ticker, small }: { ticker: string; small?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  const loaded = failed !== ticker;
  return <span className={small ? "company-logo company-logo--sm" : "company-logo"} data-failed={!loaded || undefined} aria-hidden="true">
    <span className="company-logo-fallback">{ticker.replace(/[^A-Z0-9]/g, "").slice(0, 2) || "·"}</span>
    {/* Vite app, not Next: a native image keeps the onError monogram fallback. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {loaded && <img key={ticker} src={logoUrl(ticker)} alt="" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(ticker)} />}
  </span>;
}

export function CompanyMark({ ticker }: { ticker: string }) {
  return <div className="company">
    <CompanyLogo ticker={ticker} />
    <strong className="company-ticker">{ticker}</strong>
  </div>;
}
