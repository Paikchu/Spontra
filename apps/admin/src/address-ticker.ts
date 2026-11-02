/** The company a page was opened for, from its address (`?ticker=nvda` → `NVDA`); empty when it names none. */
export function addressTicker(search: string): string {
  return (new URLSearchParams(search).get("ticker") ?? "").trim().toUpperCase();
}
