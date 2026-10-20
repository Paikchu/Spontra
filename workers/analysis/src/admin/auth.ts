const SESSION_SECONDS = 8 * 60 * 60;
const encoder = new TextEncoder();

async function key(secret: string) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function equal(a: string, b: string): Promise<boolean> {
  const signingKey = await key(b);
  return crypto.subtle.verify("HMAC", signingKey, await crypto.subtle.sign("HMAC", signingKey, encoder.encode(b)), encoder.encode(a));
}
export async function matchesAdminKey(supplied: string, expected: string | undefined): Promise<boolean> {
  return Boolean(expected && supplied && supplied.length <= 4096 && await equal(supplied, expected));
}
export async function createAdminSession(secret: string, now = Date.now()): Promise<string> {
  const payload = `report-admin.v1.${Math.floor(now / 1000) + SESSION_SECONDS}.${crypto.randomUUID()}`;
  const signature = await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(payload));
  return `${payload}.${Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2, "0")).join("")}`;
}
export async function authenticateAdmin(request: Request, secret: string | undefined, now = Date.now()): Promise<boolean> {
  if (!secret) return false;
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const match = /^(report-admin\.v1\.(\d{10})\.[a-f0-9-]{36})\.([a-f0-9]{64})$/.exec(token);
  if (!match) return false;
  const expiry = Number(match[2]);
  if (expiry <= now / 1000 || expiry > now / 1000 + SESSION_SECONDS + 5) return false;
  const bytes = Uint8Array.from(match[3]!.match(/../g)!, b => parseInt(b, 16));
  return crypto.subtle.verify("HMAC", await key(secret), bytes, encoder.encode(match[1]!));
}
