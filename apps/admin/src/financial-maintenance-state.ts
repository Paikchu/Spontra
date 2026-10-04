const PREFIX = "spontra:financial-maintenance:";
const memory = new Map<string, string>();
export type RequestIdStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function normalizeCompanyTicker(value: string): string {
  const ticker = value.trim().toUpperCase();
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) ? ticker : "";
}

/** Only an opaque operation UUID is persisted. No credential, company data or response body. */
export function pendingRequestId(key: string, storage?: RequestIdStore, create = () => crypto.randomUUID()): string {
  let saved: string | null | undefined;
  try { saved = storage?.getItem(PREFIX + key); } catch { /* Restricted browser storage. */ }
  saved ||= memory.get(key);
  if (saved && /^[a-f0-9-]{36}$/.test(saved)) return saved;
  const id = create();
  memory.set(key, id);
  try { storage?.setItem(PREFIX + key, id); } catch { /* Memory still prevents a duplicate in this page. */ }
  return id;
}

export function completeRequestId(key: string, storage?: RequestIdStore): void {
  memory.delete(key);
  try { storage?.removeItem(PREFIX + key); } catch { /* Storage can be disabled. */ }
}

export function safeEvidenceUrl(value?: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** Use the decimal string, preserving disclosed precision and never coercing null to zero. */
export function displayFinancialValue(value: string | null): string {
  if (value === null) return "未提取";
  return value.replace(/^(-?\d+)(\.\d+)?$/, (_, integer: string, fraction: string | undefined) => integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction ?? ""));
}
