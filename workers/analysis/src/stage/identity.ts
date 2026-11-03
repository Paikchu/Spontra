/**
 * Anonymous reader ids (docs/stage-agent-design.md §3.1). The server signs them, so a script cannot mint ids of its
 * own and spend a fresh allowance with each one; issuing one is itself limited per address. The signing key is derived
 * from the admin secret under its own label, so no new secret has to be provisioned.
 */
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");

async function signingKey(secret: string): Promise<CryptoKey> {
  const derived = await crypto.subtle.digest("SHA-256", encoder.encode(`spontra-stage-anon.v1\n${secret}`));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export const TOKEN = /^a1\.([0-9a-z]{6,10})\.([0-9a-f]{32})\.([0-9a-f]{32})$/;

/** A new reader id and its token. */
export async function issueReader(secret: string, now = Date.now()): Promise<{ token: string; userId: string }> {
  const id = hex(crypto.getRandomValues(new Uint8Array(16)));
  const payload = `a1.${Math.floor(now / 1000).toString(36)}.${id}`;
  const signature = hex(await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(payload))).slice(0, 32);
  return { token: `${payload}.${signature}`, userId: `anon:${id}` };
}

/** The reader a token names, or null when it is not one this server signed. */
export async function readerOf(secret: string | undefined, token: string | null): Promise<string | null> {
  if (!secret || !token) return null;
  const match = TOKEN.exec(token.trim());
  if (!match) return null;
  const payload = `a1.${match[1]}.${match[2]}`;
  const expected = hex(await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(payload))).slice(0, 32);
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= expected.charCodeAt(i) ^ match[3]!.charCodeAt(i);
  return diff === 0 ? `anon:${match[2]}` : null;
}
