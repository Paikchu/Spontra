import assert from "node:assert/strict";
import test from "node:test";
import { handleStoreRequest, handleTelemetry, memoryRepository, parseTelemetryEvent, summarize, type StoredEvent, type TelemetryNamespace } from "../src/telemetry.ts";
import { privacyBlocks, sendTrack, type TrackDelivery } from "../src/track.ts";

const SID = "11111111-1111-4111-8111-111111111111";
const NOW = Date.UTC(2026, 9, 27, 15, 30, 0);

function event(name: StoredEvent["name"], over: Partial<StoredEvent> = {}): StoredEvent {
  return {
    received: NOW, name, path: "/", lang: "zh-CN", theme: "dark", sid: SID, props: {}, ...over,
  };
}

function delivery(over: Partial<TrackDelivery> = {}): TrackDelivery & { sent: string[] } {
  const sent: string[] = [];
  const storage = new Map<string, string>();
  const env: TrackDelivery & { sent: string[] } = {
    sent,
    beacon: (_url, body) => { sent.push(body); return true; },
    fetch: (_url, body) => { sent.push(`fetch:${body}`); },
    storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    privacy: { doNotTrack: null, globalPrivacyControl: false },
    path: "/companies/META", lang: "zh-CN", theme: "dark", now: NOW,
    uuid: () => SID,
    recent: new Map(),
    ...over,
  };
  return env;
}

test("tracking respects DNT and GPC, keeps a session id, and falls back when beacon refuses", () => {
  assert.equal(privacyBlocks({ doNotTrack: "1", globalPrivacyControl: false }), true);
  assert.equal(privacyBlocks({ doNotTrack: "0", globalPrivacyControl: true }), true);
  assert.equal(privacyBlocks({ doNotTrack: null, globalPrivacyControl: false }), false);
  const blocked = delivery({ privacy: { doNotTrack: "1" } });
  assert.equal(sendTrack(blocked, "page_view", { ticker: "META" }), null);
  assert.deepEqual(blocked.sent, []);

  const env = delivery();
  const body = sendTrack(env, "page_view", { ticker: "META" });
  assert.ok(body);
  const parsed = JSON.parse(body!) as { sid: string; props: { ticker: string }; path: string };
  assert.equal(parsed.sid, SID);
  assert.equal(parsed.props.ticker, "META");
  assert.equal(parsed.path, "/companies/META");
  assert.equal(env.storage?.getItem("bv-sid"), SID);
  assert.equal(sendTrack(env, "page_view", { ticker: "META" }), null);

  const fetched: string[] = [];
  const fallback = delivery({
    beacon: () => { throw new Error("blocked"); },
    fetch: (_url, payload) => { fetched.push(payload); },
    recent: new Map(),
  });
  assert.ok(sendTrack(fallback, "theme_toggle"));
  assert.equal(fetched.length, 1);
  const quiet = delivery({ beacon: () => false, fetch: () => { throw new Error("offline"); }, recent: new Map() });
  assert.doesNotThrow(() => sendTrack(quiet, "lang_toggle"));
});

test("the store refuses oversized, unknown, and malformed events and never keeps an address", () => {
  assert.deepEqual(parseTelemetryEvent({ name: "page_view", path: "/companies/META", lang: "en", theme: "dark", sid: SID, props: { ticker: "META" }, ts: NOW }), {
    name: "page_view", path: "/companies/META", lang: "en", theme: "dark", sid: SID, props: { ticker: "META" },
  });
  assert.equal(parseTelemetryEvent({ name: "not_an_event", path: "/", lang: "en", theme: "dark", sid: SID }), null);
  assert.equal(parseTelemetryEvent({ name: "page_view", path: "/../secret", lang: "en", theme: "dark", sid: SID }), null);
  assert.equal(parseTelemetryEvent({ name: "page_view", path: "/", lang: "fr", theme: "dark", sid: SID }), null);
  assert.equal(parseTelemetryEvent({ name: "page_view", path: "/", lang: "en", theme: "dark", sid: "nope", props: {} }), null);
  const text = JSON.stringify(parseTelemetryEvent({ name: "page_view", path: "/", lang: "en", theme: "dark", sid: SID, props: {} }));
  assert.equal(text.includes("1.2.3.4"), false);
});

test("aggregates sessions, companies, empty searches, rates, and tour completion", () => {
  const rows: StoredEvent[] = [
    event("page_view", { sid: SID, path: "/companies/META", props: { ticker: "META" } }),
    event("page_view", { sid: "22222222-2222-4222-8222-222222222222", path: "/companies/ORCL", props: { ticker: "ORCL" }, received: NOW - 3_600_000 }),
    event("page_view", { sid: SID, path: "/companies/META", props: { ticker: "META" }, received: NOW - 86_400_000 }),
    event("search_submit", { props: { q: "zzzz", results: 0, empty: 1 } }),
    event("search_submit", { props: { q: "zzzz", results: 0, empty: 1 } }),
    event("search_submit", { props: { q: "meta", results: 1, empty: 0 } }),
    event("finding_expand", { path: "/companies/META" }),
    event("error_shown", { props: { code: "NETWORK" } }),
    event("tour_start"),
    event("tour_start", { sid: "22222222-2222-4222-8222-222222222222" }),
    event("tour_done"),
    event("tour_skip", { sid: "22222222-2222-4222-8222-222222222222" }),
  ];
  const summary = summarize(rows, "7d", NOW);
  assert.equal(summary.sessions, 2);
  assert.equal(summary.pageViews, 3);
  assert.deepEqual(summary.topCompanies, [{ ticker: "META", views: 2 }, { ticker: "ORCL", views: 1 }]);
  assert.deepEqual(summary.emptySearches, [{ query: "zzzz", count: 2 }]);
  assert.equal(summary.expandRate, 0.333);
  assert.equal(summary.errorRate, 0.333);
  assert.deepEqual(summary.tour, { start: 2, done: 1, skip: 1, completionRate: 0.5 });
  assert.equal(summary.events.find(item => item.name === "page_view")?.count, 3);
  assert.equal(summary.series.length, 7);
  assert.equal(summarize([], "24h", NOW).pageViews, 0);
  assert.equal(summarize([], "4w", NOW).series.length, 4);
});

function namespace(repo = memoryRepository(), seen: Request[] = []): TelemetryNamespace {
  return {
    idFromName: () => "global",
    get: () => ({ fetch: (request: Request) => { seen.push(request); return handleStoreRequest(repo, request, NOW); } }),
  };
}

function post(body: unknown, ip = "203.0.113.8"): Request {
  return new Request("https://businessview.info/api/business/v1/telemetry", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
  });
}

test("the public route stores events and keeps the aggregate off the public host", async () => {
  const seen: Request[] = [];
  const repo = memoryRepository();
  const env = namespace(repo, seen);
  const payload = { name: "page_view", props: { ticker: "META" }, path: "/companies/META", lang: "en", theme: "light", ts: NOW, sid: SID };
  assert.equal((await handleTelemetry(post(payload), env, NOW)).status, 204);
  const forwarded = seen[0]!;
  assert.equal(forwarded.headers.get("cf-connecting-ip"), null);
  assert.match(forwarded.headers.get("x-telemetry-actor") ?? "", /^[0-9a-f]{24}$/);
  assert.equal((await handleTelemetry(post({ ...payload, name: "nope" }), env, NOW)).status, 400);
  assert.equal((await handleTelemetry(new Request("https://businessview.info/api/business/v1/telemetry", { method: "POST", body: "x".repeat(1025) }), env, NOW)).status, 413);
  const publicRead = await handleTelemetry(new Request("https://businessview.info/api/business/v1/telemetry?range=24h"), env, NOW);
  assert.equal(publicRead.status, 404);
  assert.equal(seen.length, 1);
  assert.equal((await handleTelemetry(new Request("https://spontra-business-map.example.workers.dev/api/business/v1/telemetry?range=24h"), env, NOW)).status, 404);
  const summary = await handleTelemetry(new Request("https://business-map.internal/api/business/v1/telemetry?range=24h"), env, NOW);
  assert.equal(summary.status, 200);
  const body = await summary.json() as { pageViews: number; topCompanies: Array<{ ticker: string }> };
  assert.equal(body.pageViews, 1);
  assert.equal(body.topCompanies[0]?.ticker, "META");
  assert.equal((await handleTelemetry(new Request("https://businessview.info/api/business/v1/telemetry?range=year"), env, NOW)).status, 404);
  assert.equal((await handleTelemetry(new Request("https://business-map.internal/api/business/v1/telemetry?range=year"), env, NOW)).status, 400);
  assert.equal((await handleTelemetry(new Request("https://business-map.internal/api/business/v1/telemetry"), undefined, NOW)).status, 503);
  assert.equal((await handleTelemetry(post(payload), undefined, NOW)).status, 503);

  let blocked = 0;
  for (let i = 0; i < 70; i += 1) {
    const response = await handleTelemetry(post({ ...payload, name: "lang_toggle", path: "/" }, "203.0.113.9"), env, NOW);
    if (response.status === 429) blocked += 1;
  }
  assert.ok(blocked >= 10);
});

test("all ranges retain current events, exclude future events, and 4w ends today UTC", () => {
  const day = 86_400_000;
  const midnight = Math.floor(NOW / day) * day;
  for (const range of ["24h", "7d", "4w"] as const) {
    assert.equal(summarize([event("page_view"), event("page_view", { received: NOW + 1 })], range, NOW).pageViews, 1);
  }
  const start = midnight + day - 28 * day;
  const summary = summarize([event("page_view", { received: start }), event("page_view", { received: start - 1 }), event("page_view")], "4w", NOW);
  assert.equal(summary.pageViews, 2);
  assert.equal(summary.series.reduce((n, bucket) => n + bucket.pageViews, 0), 2);
});

test("summary reads only the selected range", async () => {
  const repo = memoryRepository();
  let since = 0;
  repo.read = value => { since = value; return []; };
  await handleStoreRequest(repo, new Request("https://telemetry.internal/summary?range=24h"), NOW);
  assert.equal(since, Math.floor(NOW / 3_600_000) * 3_600_000 - 23 * 3_600_000);
});

test("tracking sends the first event at time zero and bounds route deduplication memory", () => {
  const env = delivery({ now: 0 });
  assert.ok(sendTrack(env, "page_view"));
  assert.equal(sendTrack(env, "page_view"), null);
  env.now = 1000;
  env.path = "/companies/ORCL";
  assert.ok(sendTrack(env, "page_view"));
  assert.equal(env.recent?.size, 1);
});

test("tracking measures the UTF-8 payload budget for Chinese properties", () => {
  const env = delivery();
  assert.equal(sendTrack(env, "search_submit", Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`p${i}`, "中".repeat(40)]))), null);
  assert.equal(env.sent.length, 0);
});
