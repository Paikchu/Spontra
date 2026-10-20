import securities from "./securities.json" with { type: "json" };
export function findSecurity(ticker: string) { return securities.find(item => item.symbol === ticker.trim().toUpperCase()) ?? null; }
/** A company's name without its listing's share-class wording: "Alphabet Inc. - Class A Common Stock" reads "Alphabet Inc.". */
export function companyName(ticker: string): string | null {
  const name = findSecurity(ticker)?.name;
  if (!name) return null;
  return name.replace(/\s+-\s+.*$/, "").replace(/\s+(?:New\s+)?(?:Class\s+[A-Z]\s+)?(?:Common Stock|Ordinary Shares|American Depositary Shares?|Depositary Shares?)\b.*$/i, "").trim() || name;
}
