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

/** Logo and ticker; with a name, narrow screens show it beside the ticker (wide screens show it on its own line under the row). */
export function CompanyMark({ ticker, name, fullName }: { ticker: string; name?: string | null; fullName?: string | null }) {
  return <div className="company brand">
    <CompanyLogo ticker={ticker} />
    <strong className="company-ticker"><b lang="en">{ticker}</b></strong>
    {name && <span className="brand-company-name" title={fullName ?? name}>{name}</span>}
  </div>;
}
