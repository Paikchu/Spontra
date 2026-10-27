import { TRACK_NAMES, type TrackName } from "./track.ts";

export const TELEMETRY_RANGES = ["24h", "7d", "4w"] as const;
export type TelemetryRange = (typeof TELEMETRY_RANGES)[number];

const SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PATH = /^\/[A-Za-z0-9._~/-]{0,180}$/;
const TICKER = /^[A-Z][A-Z0-9.-]{0,11}$/;
const TOKEN = /^[\w.-]{1,32}$/;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const RETAIN_MS = 35 * DAY;
export const TELEMETRY_RATE_LIMIT = 60;

export type TelemetryProps = Record<string, string | number>;

export type StoredEvent = {
  received: number;
  name: TrackName;
  path: string;
  lang: "en" | "zh-CN";
  theme: "light" | "dark";
  sid: string;
  props: TelemetryProps;
};

export type TelemetrySummary = {
  schemaVersion: "telemetry-summary.v1";
  range: TelemetryRange;
  generatedAt: string;
  sessions: number;
  pageViews: number;
  series: Array<{ label: string; sessions: number; pageViews: number }>;
  topCompanies: Array<{ ticker: string; views: number }>;
  emptySearches: Array<{ query: string; count: number }>;
  events: Array<{ name: TrackName; count: number }>;
  expandRate: number | null;
  errorRate: number | null;
  tour: { start: number; done: number; skip: number; completionRate: number | null };
};

export type TelemetryRepository = {
  allow(actor: string, minute: number, limit: number): boolean;
  add(row: StoredEvent): void;
  read(since: number): StoredEvent[];
  prune(oldestEvent: number, oldestMinute: number): void;
};

type SqlValue = string | number;
type SqlCursor = { toArray(): Array<Record<string, SqlValue | null>> };
export type TelemetrySql = { exec(query: string, ...bindings: SqlValue[]): SqlCursor };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function propsOf(value: unknown): TelemetryProps | null {
  if (value == null) return {};
  const row = record(value);
  if (!row) return null;
  const out: TelemetryProps = {};
  for (const [key, item] of Object.entries(row)) {
    if (Object.keys(out).length >= 6) break;
    if (!TOKEN.test(key)) continue;
    if (typeof item === "string") out[key] = item.slice(0, 40);
    else if (typeof item === "number" && Number.isFinite(item)) out[key] = item;
  }
  if (typeof out.ticker === "string" && !TICKER.test(out.ticker)) return null;
  if (typeof out.q === "string") out.q = out.q.trim().slice(0, 40);
  return out;
}

/** A client event the store can keep. Anything else is refused. The raw IP is never part of this. */
export function parseTelemetryEvent(value: unknown): Omit<StoredEvent, "received"> | null {
  const row = record(value);
  if (!row) return null;
  const name = row.name;
  if (typeof name !== "string" || !(TRACK_NAMES as readonly string[]).includes(name)) return null;
  const path = row.path;
  if (typeof path !== "string" || !PATH.test(path) || path.includes("..")) return null;
  const sid = row.sid;
  if (typeof sid !== "string" || !SID.test(sid)) return null;
  const lang = row.lang === "zh-CN" ? "zh-CN" : row.lang === "en" ? "en" : null;
  const theme = row.theme === "light" ? "light" : row.theme === "dark" ? "dark" : null;
  if (!lang || !theme) return null;
  if (row.ts != null && (typeof row.ts !== "number" || !Number.isFinite(row.ts))) return null;
  const props = propsOf(row.props);
  if (!props) return null;
  return { name: name as TrackName, path, lang, theme, sid, props };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function buckets(range: TelemetryRange, now: number): Array<{ start: number; end: number; label: string }> {
  const size = range === "24h" ? HOUR : range === "7d" ? DAY : 7 * DAY;
  const count = range === "24h" ? 24 : range === "7d" ? 7 : 4;
  const end = Math.floor(now / size) * size + size;
  return Array.from({ length: count }, (_, index) => {
    const start = end - (count - index) * size;
    const date = new Date(start);
    const label = range === "24h" ? `${pad(date.getUTCHours())}:00` : `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    return { start, end: start + size, label };
  });
}

function tickerOf(event: StoredEvent): string | null {
  if (typeof event.props.ticker === "string" && TICKER.test(event.props.ticker)) return event.props.ticker;
  const match = event.path.match(/^\/companies\/([A-Z][A-Z0-9.-]{0,11})\/?$/);
  return match ? match[1]! : null;
}

function rate(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 1000;
}

export function summarize(rows: readonly StoredEvent[], range: TelemetryRange, now: number): TelemetrySummary {
  const window = buckets(range, now);
  const from = window[0]?.start ?? now;
  const events = rows.filter(row => row.received >= from && row.received < (window.at(-1)?.end ?? now + 1));
  const sessions = new Set(events.map(row => row.sid));
  const counts = new Map<TrackName, number>(TRACK_NAMES.map(name => [name, 0]));
  const companies = new Map<string, number>();
  const searches = new Map<string, number>();
  const series = window.map(bucket => ({ label: bucket.label, sessions: new Set<string>(), pageViews: 0 }));
  let companyViews = 0;
  for (const event of events) {
    counts.set(event.name, (counts.get(event.name) ?? 0) + 1);
    const bucket = series[window.findIndex(item => event.received >= item.start && event.received < item.end)];
    if (bucket) bucket.sessions.add(event.sid);
    if (event.name === "page_view") {
      if (bucket) bucket.pageViews += 1;
      const ticker = tickerOf(event);
      if (ticker) companies.set(ticker, (companies.get(ticker) ?? 0) + 1);
      if (event.path.startsWith("/companies/")) companyViews += 1;
    }
    if (event.name === "search_submit") {
      const empty = event.props.empty === 1 || event.props.results === 0;
      const query = typeof event.props.q === "string" ? event.props.q.trim() : "";
      if (empty && query) searches.set(query, (searches.get(query) ?? 0) + 1);
    }
  }
  const top = (map: Map<string, number>, limit: number) => [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
  const pageViews = counts.get("page_view") ?? 0;
  const tourStart = counts.get("tour_start") ?? 0;
  return {
    schemaVersion: "telemetry-summary.v1",
    range,
    generatedAt: new Date(now).toISOString(),
    sessions: sessions.size,
    pageViews,
    series: series.map(item => ({ label: item.label, sessions: item.sessions.size, pageViews: item.pageViews })),
    topCompanies: top(companies, 5).map(([ticker, views]) => ({ ticker, views })),
    emptySearches: top(searches, 10).map(([query, count]) => ({ query, count })),
    events: TRACK_NAMES.map(name => ({ name, count: counts.get(name) ?? 0 })),
    expandRate: rate(counts.get("finding_expand") ?? 0, companyViews),
    errorRate: rate(counts.get("error_shown") ?? 0, pageViews),
    tour: {
      start: tourStart,
      done: counts.get("tour_done") ?? 0,
      skip: counts.get("tour_skip") ?? 0,
      completionRate: rate(counts.get("tour_done") ?? 0, tourStart),
    },
  };
}

export function memoryRepository(): TelemetryRepository {
  const events: StoredEvent[] = [];
  const hits = new Map<string, number>();
  return {
    allow(actor, minute, limit) {
      const key = `${actor}:${minute}`;
      const next = (hits.get(key) ?? 0) + 1;
      hits.set(key, next);
      return next <= limit;
    },
    add(row) { events.push({ ...row, props: { ...row.props } }); },
    read(since) { return events.filter(row => row.received >= since).map(row => ({ ...row, props: { ...row.props } })); },
    prune(oldestEvent, oldestMinute) {
      for (let i = events.length - 1; i >= 0; i -= 1) if (events[i]!.received < oldestEvent) events.splice(i, 1);
      for (const key of hits.keys()) {
        const minute = Number(key.slice(key.lastIndexOf(":") + 1));
        if (minute < oldestMinute) hits.delete(key);
      }
    },
  };
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    received INTEGER NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    lang TEXT NOT NULL,
    theme TEXT NOT NULL,
    sid TEXT NOT NULL,
    props TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS events_received ON events (received)",
  `CREATE TABLE IF NOT EXISTS rate_hits (
    actor TEXT NOT NULL,
    minute INTEGER NOT NULL,
    n INTEGER NOT NULL,
    PRIMARY KEY (actor, minute)
  )`,
];

export function sqlRepository(sql: TelemetrySql): TelemetryRepository {
  for (const statement of SCHEMA) sql.exec(statement);
  return {
    allow(actor, minute, limit) {
      const row = sql.exec(
        "INSERT INTO rate_hits (actor, minute, n) VALUES (?, ?, 1) ON CONFLICT(actor, minute) DO UPDATE SET n = n + 1 RETURNING n",
        actor, minute,
      ).toArray()[0];
      return Number(row?.n ?? limit + 1) <= limit;
    },
    add(row) {
      sql.exec(
        "INSERT INTO events (received, name, path, lang, theme, sid, props) VALUES (?, ?, ?, ?, ?, ?, ?)",
        row.received, row.name, row.path, row.lang, row.theme, row.sid, JSON.stringify(row.props),
      );
    },
    read(since) {
      return sql.exec("SELECT received, name, path, lang, theme, sid, props FROM events WHERE received >= ? ORDER BY received", since).toArray().flatMap(row => {
        const parsed = parseTelemetryEvent({
          name: row.name, path: row.path, lang: row.lang, theme: row.theme, sid: row.sid,
          props: JSON.parse(String(row.props ?? "{}")),
        });
        return parsed ? [{ ...parsed, received: Number(row.received) }] : [];
      });
    },
    prune(oldestEvent, oldestMinute) {
      sql.exec("DELETE FROM events WHERE received < ?", oldestEvent);
      sql.exec("DELETE FROM rate_hits WHERE minute < ?", oldestMinute);
    },
  };
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** Store request. The actor is a hash supplied by the edge, never a raw address. */
export async function handleStoreRequest(repo: TelemetryRepository, request: Request, now: number): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET") {
    const range = url.searchParams.get("range") ?? "7d";
    if (!TELEMETRY_RANGES.includes(range as TelemetryRange)) return json({ error: "invalid" }, 400);
    const rows = repo.read(now - 35 * DAY);
    return json(summarize(rows, range as TelemetryRange, now), 200);
  }
  if (request.method !== "POST") return json({ error: "method" }, 405);
  const raw = await request.arrayBuffer();
  if (raw.byteLength > 1024) return json({ error: "too large" }, 413);
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return json({ error: "invalid" }, 400); }
  const event = parseTelemetryEvent(body);
  if (!event) return json({ error: "invalid" }, 400);
  const actor = request.headers.get("x-telemetry-actor") ?? "anonymous";
  if (!/^[\w.-]{1,64}$/.test(actor)) return json({ error: "invalid" }, 400);
  const minute = Math.floor(now / 60_000);
  repo.prune(now - RETAIN_MS, minute - 2);
  if (!repo.allow(actor, minute, TELEMETRY_RATE_LIMIT)) return json({ error: "rate" }, 429);
  repo.add({ ...event, received: now });
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

async function actorHash(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`spontra-telemetry\n${ip}`));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

export type TelemetryNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
};

/** Public telemetry route. POST stores one event; GET returns the aggregate. No raw IP is forwarded. */
export async function handleTelemetry(request: Request, namespace: TelemetryNamespace | undefined, now = Date.now()): Promise<Response> {
  if (!namespace) return json({ error: "unavailable" }, 503);
  const url = new URL(request.url);
  if (request.method === "GET") {
    const range = url.searchParams.get("range") ?? "7d";
    if (!TELEMETRY_RANGES.includes(range as TelemetryRange)) return json({ error: "invalid" }, 400);
    const stub = namespace.get(namespace.idFromName("global"));
    return stub.fetch(new Request(`https://telemetry.internal/summary?range=${range}`, { method: "GET" }));
  }
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const raw = await request.arrayBuffer();
  if (raw.byteLength > 1024) return json({ error: "too large" }, 413);
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(raw)); } catch { return json({ error: "invalid" }, 400); }
  const event = parseTelemetryEvent(parsed);
  if (!event) return json({ error: "invalid" }, 400);
  const actor = await actorHash(request.headers.get("cf-connecting-ip") ?? "anonymous");
  const stub = namespace.get(namespace.idFromName("global"));
  const forwarded = new Request("https://telemetry.internal/event", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telemetry-actor": actor },
    body: JSON.stringify({ ...event, ts: typeof (parsed as { ts?: unknown }).ts === "number" ? (parsed as { ts: number }).ts : now }),
  });
  return stub.fetch(forwarded);
}
