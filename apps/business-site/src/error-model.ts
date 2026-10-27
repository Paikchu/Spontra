/** What the readable error page is for. HTTP failures win over a publication that never became a map. */
export type CompanyFault =
  | { kind: "not-found"; code: "NOT_FOUND" }
  | { kind: "insufficient"; code: string }
  | { kind: "rate-limit"; code: "429" }
  | { kind: "server"; code: string };

export type FeaturedCompany = { ticker: string; name: string; nameZh: string | null };

/**
 * Unknown tickers answer as a preparing publication with no attempt. A company the catalog already
 * lists is never "not covered", even when that publication is the only thing we have so far.
 */
export function companyFault(input: {
  httpStatus: number | null;
  reasons: readonly string[];
  /** null while the covered catalog has not loaded. */
  covered: boolean | null;
  attempted: boolean;
}): CompanyFault {
  const status = input.httpStatus;
  if (status === 429) return { kind: "rate-limit", code: "429" };
  if (status === 404) return { kind: "not-found", code: "NOT_FOUND" };
  if (status === 0 || (status != null && status >= 500)) return { kind: "server", code: status === 0 ? "NETWORK" : String(status) };
  if (status != null && status >= 400) return { kind: "server", code: String(status) };
  if (input.covered === false) return { kind: "not-found", code: "NOT_FOUND" };
  const untouched = !input.attempted && (input.reasons.length === 0 || (input.reasons.length === 1 && input.reasons[0] === "MISSING_TWO_QUARTERS"));
  if (input.covered == null && untouched) return { kind: "not-found", code: "NOT_FOUND" };
  const code = input.reasons.filter(Boolean).join(", ") || "MISSING_TWO_QUARTERS";
  return { kind: "insufficient", code };
}

/** The covered companies the homepage puts first, named as the catalog names them; none until the catalog loads. */
export function featuredCompanies(catalog: readonly FeaturedCompany[], popular: readonly string[], locale: "en" | "zh-CN"): Array<{ ticker: string; name: string }> {
  return popular.flatMap(ticker => {
    const found = catalog.find(company => company.ticker === ticker);
    return found ? [{ ticker, name: locale === "zh-CN" && found.nameZh ? found.nameZh : found.name }] : [];
  });
}

export function isHomePath(path: string): boolean {
  const bare = path.replace(/\/+$/, "") || "/";
  return bare === "/" || bare === "/index.html";
}
