import { canonicalTicker } from "../../../../shared/analysis-runtime/financial-data/policy.ts";

const TRACKED_TICKER_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/;

export class SecTrackedTickerConfigError extends Error {
  readonly invalidEntries: string[];

  constructor(invalidEntries: string[]) {
    super(`SEC_TRACKED_TICKERS contains invalid ticker(s): ${invalidEntries.join(", ")}`);
    this.invalidEntries = invalidEntries;
    this.name = "SecTrackedTickerConfigError";
  }
}

export function parseTrackedTickers(value: string | undefined | null): string[] {
  const entries = String(value ?? "")
    .split(/[,\n]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const normalized = entries.map((entry) => entry.toUpperCase());
  const invalidEntries = normalized.filter((ticker) => !TRACKED_TICKER_PATTERN.test(ticker));
  if (invalidEntries.length) throw new SecTrackedTickerConfigError([...new Set(invalidEntries)]);
  return [...new Set(normalized)].sort();
}

export function isTrackedTicker(value: string, trackedTickers: string[]): boolean {
  const ticker = normalizeTrackedTicker(value);
  return Boolean(ticker) && trackedTickers.includes(ticker);
}

export function normalizeTrackedTicker(value: string | null | undefined): string {
  const ticker = canonicalTicker(String(value ?? ""));
  return TRACKED_TICKER_PATTERN.test(ticker) ? ticker : "";
}

export function encodePageCursor(value: { filingDate: string; accessionNumber: string }): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

export function decodePageCursor(value: string | null): { filingDate: string; accessionNumber: string } | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlToBytes(value))) as Record<string, unknown>;
    if (typeof decoded.filingDate !== "string" || typeof decoded.accessionNumber !== "string") return null;
    return { filingDate: decoded.filingDate, accessionNumber: decoded.accessionNumber };
  } catch {
    return null;
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
