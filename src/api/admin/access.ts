/**
 * The AdminGateway binding mints an admin session for every forwarded call, so the public edge must prove who is calling.
 * Cloudflare Access signs each request it lets through (`Cf-Access-Jwt-Assertion`, RS256); the Worker re-checks that token
 * so a request that reaches the Worker without passing Access (e.g. an uncovered hostname) cannot drive the admin API.
 */
export type AccessEnv = { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string };
export type AccessConfig = { teamDomain: string; aud: string };
export type AccessVerdict = "ok" | "unauthorized" | "unavailable";

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const KEYS_TTL_MS = 10 * 60_000;
// An unknown kid may be a fresh rotation; refetch, but not more often than this.
const KEYS_REFRESH_MS = 60_000;
const SKEW_S = 60;
const keyCache = new Map<string, { at: number; keys: Map<string, CryptoKey> }>();

/** Both values set means Access is configured; either missing keeps the admin open until it is. */
export function accessConfig(env: AccessEnv): AccessConfig | null {
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.ACCESS_AUD?.trim();
  return teamDomain && aud ? { teamDomain, aud } : null;
}

function base64url(part: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(part) || part.length % 4 === 1) throw new Error("not base64url");
  const binary = atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

const decodeJson = (part: string): unknown => JSON.parse(new TextDecoder().decode(base64url(part)));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

async function loadKeys(certsUrl: string, fetcher: typeof fetch): Promise<Map<string, CryptoKey>> {
  const response = await fetcher(certsUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Access certs returned ${response.status}`);
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.keys)) throw new Error("Access certs carry no keys");
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys) {
    if (!isRecord(jwk) || jwk.kty !== "RSA" || typeof jwk.kid !== "string" || typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
    keys.set(jwk.kid, await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, RS256, false, ["verify"]));
  }
  return keys;
}

async function keyFor(certsUrl: string, kid: string, fetcher: typeof fetch): Promise<CryptoKey | undefined> {
  const cached = keyCache.get(certsUrl);
  const age = cached ? Date.now() - cached.at : Infinity;
  if (cached && age < KEYS_TTL_MS && (cached.keys.has(kid) || age < KEYS_REFRESH_MS)) return cached.keys.get(kid);
  const keys = await loadKeys(certsUrl, fetcher);
  keyCache.set(certsUrl, { at: Date.now(), keys });
  return keys.get(kid);
}

/** Never fails open: a missing or invalid token is unauthorized, an unreachable key set is unavailable. */
export async function verifyAccess(request: Request, config: AccessConfig, fetcher: typeof fetch): Promise<AccessVerdict> {
  const domain = config.teamDomain.includes("://") ? config.teamDomain : `https://${config.teamDomain}`;
  if (!URL.canParse(domain)) {
    console.error(JSON.stringify({ event: "admin-access-misconfigured", teamDomain: config.teamDomain }));
    return "unavailable";
  }
  const issuer = new URL(domain).origin;
  const token = request.headers.get("cf-access-jwt-assertion");
  const parts = token?.split(".") ?? [];
  if (parts.length !== 3) return "unauthorized";
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  let header: unknown, payload: unknown, signature: Uint8Array<ArrayBuffer>;
  try {
    header = decodeJson(encodedHeader);
    payload = decodeJson(encodedPayload);
    signature = base64url(encodedSignature);
  } catch {
    return "unauthorized";
  }
  if (!isRecord(header) || header.alg !== "RS256" || typeof header.kid !== "string" || !isRecord(payload)) return "unauthorized";
  const now = Date.now() / 1000;
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== issuer || !audiences.includes(config.aud)) return "unauthorized";
  if (typeof payload.exp !== "number" || payload.exp <= now - SKEW_S) return "unauthorized";
  if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf > now + SKEW_S)) return "unauthorized";
  let key: CryptoKey | undefined;
  try {
    key = await keyFor(`${issuer}/cdn-cgi/access/certs`, header.kid, fetcher);
  } catch (error) {
    console.error(JSON.stringify({ event: "admin-access-certs-failed", message: error instanceof Error ? error.message : String(error) }));
    return "unavailable";
  }
  if (!key) return "unauthorized";
  const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  return await crypto.subtle.verify(RS256, key, signature, signed) ? "ok" : "unauthorized";
}
