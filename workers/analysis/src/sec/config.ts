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
