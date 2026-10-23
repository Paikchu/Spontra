/**
 * Company-page reason codes become stable keys. The page translates the keys and never prints the code.
 * Direct /companies/ZZZZ still exists; the search box does not open it.
 */
const REASON_KEY: Record<string, string> = {
  MISSING_TWO_QUARTERS: "missingQuarters",
  INCOMPARABLE_QUARTERS: "incomparable",
  MISSING_DISCLOSURE: "missingDisclosure",
  INVALID_SOURCE: "invalidSource",
  UNBALANCED_STATEMENT: "unbalanced",
  UNSUPPORTED_INDUSTRY: "unsupported",
  SIGNED_LAYOUT_UNSUPPORTED: "signed",
  INVALID_PAYLOAD: "invalid",
  LATEST_PERIOD_NOT_COLLECTED: "notCollected",
  RESTATEMENT_REVIEW_REQUIRED: "restatement",
  PREPARING: "preparing",
  SOURCE_TEMPORARILY_UNAVAILABLE: "sourceDown",
  DATA_POLICY_DENIED: "unavailable",
};

export function reasonKeys(codes: readonly string[]): string[] {
  const keys = codes.map(code => REASON_KEY[code] ?? "unavailable");
  return keys.length ? [...new Set(keys)] : ["unavailable"];
}
