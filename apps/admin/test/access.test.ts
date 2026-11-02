import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAdminRequest, type AdminEnv } from "../worker/index.ts";

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const AUD = "aud-tag-1";
const pair = await crypto.subtle.generateKey({ ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"]);
const other = await crypto.subtle.generateKey({ ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"]);
const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const encodeJson = (value: unknown) => encode(new TextEncoder().encode(JSON.stringify(value)));

async function sign(claims: Record<string, unknown>, key = pair.privateKey, kid = "k1") {
  const unsigned = `${encodeJson({ alg: "RS256", kid, typ: "JWT" })}.${encodeJson(claims)}`;
  return `${unsigned}.${encode(new Uint8Array(await crypto.subtle.sign(RS256, key, new TextEncoder().encode(unsigned))))}`;
}

/** Each test owns a team domain so the module-level key cache never leaks between tests. */
function setup(team: string, certs: () => Promise<Response> = async () => Response.json({ keys: [{ ...jwk, kid: "k1", alg: "RS256", use: "sig" }] })) {
  const teamDomain = `${team}.cloudflareaccess.com`;
  const certsSeen: string[] = [];
  const proxied: string[] = [];
  const env: AdminEnv = {
    ASSETS: { fetch: async () => new Response("asset") },
    SPONTRA_ANALYSIS: { fetch: async (url: RequestInfo | URL) => { proxied.push(new URL(String(url)).pathname); return Response.json({ ok: true }); } },
    ACCESS_TEAM_DOMAIN: teamDomain,
    ACCESS_AUD: AUD,
  };
  const fetcher = (async (input: RequestInfo | URL) => { certsSeen.push(String(input)); return certs(); }) as typeof fetch;
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: `https://${teamDomain}`, aud: [AUD], exp: now + 600, nbf: now - 10, iat: now - 10, email: "admin@example.com" };
  const call = (token?: string, path = "ai/models") => handleAdminRequest(new Request(`https://admin.example/api/admin/${path}`, { headers: token ? { "cf-access-jwt-assertion": token } : {} }), env, fetcher);
  return { env, fetcher, certsSeen, proxied, claims, call };
}

test("without Access configured the admin API passes through and says so", async () => {
  const proxied: string[] = [];
  const env: AdminEnv = {
    ASSETS: { fetch: async () => new Response("asset") },
    SPONTRA_ANALYSIS: { fetch: async (url: RequestInfo | URL) => { proxied.push(new URL(String(url)).pathname); return Response.json({ ok: true }); } },
    ACCESS_TEAM_DOMAIN: "only-team.cloudflareaccess.com",
  };
  const fetcher = (async () => { throw new Error("certs must stay unread"); }) as typeof fetch;
  const response = await handleAdminRequest(new Request("https://admin.example/api/admin/ai/models"), env, fetcher);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-admin-auth"), "unconfigured");
  assert.deepEqual(proxied, ["/admin/ai/models"]);
  assert.equal((await handleAdminRequest(new Request("https://admin.example/"), env, fetcher)).headers.get("x-admin-auth"), null);
});

test("with Access configured a request without a token is refused before proxying", async () => {
  const { call, proxied, certsSeen } = setup("no-token");
  for (const path of ["ai/models", "analytics"]) {
    const response = await call(undefined, path);
    assert.equal(response.status, 401, path);
    assert.deepEqual(await response.json(), { error: "需要登录" });
    assert.equal(response.headers.get("x-admin-auth"), null);
  }
  assert.equal((await call("not.a.jwt")).status, 401);
  assert.deepEqual(proxied, []);
  assert.deepEqual(certsSeen, []);
});

test("a valid Access token is proxied and the signing keys are cached", async () => {
  const { call, proxied, certsSeen, claims } = setup("valid");
  const token = await sign(claims);
  assert.equal((await call(token)).status, 200);
  assert.equal((await call(await sign({ ...claims, aud: AUD }))).status, 200);
  assert.deepEqual(proxied, ["/admin/ai/models", "/admin/ai/models"]);
  assert.deepEqual(certsSeen, ["https://valid.cloudflareaccess.com/cdn-cgi/access/certs"]);
});

test("a token with the wrong audience, issuer, expiry, signature or key is refused", async () => {
  const { call, proxied, claims } = setup("invalid");
  const now = Math.floor(Date.now() / 1000);
  const tokens = {
    aud: await sign({ ...claims, aud: ["someone-else"] }),
    iss: await sign({ ...claims, iss: "https://evil.cloudflareaccess.com" }),
    expired: await sign({ ...claims, exp: now - 3600 }),
    noExpiry: await sign({ ...claims, exp: undefined }),
    notYet: await sign({ ...claims, nbf: now + 3600 }),
    signature: await sign(claims, other.privateKey),
    unknownKid: await sign(claims, pair.privateKey, "k2"),
  };
  for (const [name, token] of Object.entries(tokens)) assert.equal((await call(token)).status, 401, name);
  const [header, payload] = (await sign(claims)).split(".");
  assert.equal((await call(`${header}.${payload}.`)).status, 401, "empty signature");
  assert.deepEqual(proxied, []);
});

test("an unreachable key set is unavailable, never open", async () => {
  for (const [team, certs] of [
    ["certs-down", async () => new Response("bad gateway", { status: 502 })],
    ["certs-throw", async () => { throw new TypeError("network"); }],
    ["certs-garbage", async () => Response.json({ nope: true })],
  ] as const) {
    const { call, proxied, claims } = setup(team, certs);
    const response = await call(await sign(claims));
    assert.equal(response.status, 503, team);
    assert.deepEqual(await response.json(), { error: "登录服务不可用" });
    assert.deepEqual(proxied, []);
  }
});
