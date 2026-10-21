/**
 * The stage's daily allowances (docs/stage-agent-design.md §3.3), counted per UTC day: one per reader id, one per
 * hashed address, and global caps in `feature_budget`. A unit is one model call, one conversation, one identity.
 */
export const STAGE_LIMITS = {
  "stage-identities": { reader: null, address: 10, global: null },
  "stage-conversations": { reader: 5, address: 20, global: 200 },
  "stage-says": { reader: 20, address: 60, global: null },
  "stage-calls": { reader: 120, address: 400, global: 300 },
  "stage-reports": { reader: 1, address: 3, global: 10 },
  "stage-report-calls": { reader: 20, address: 60, global: 200 },
} as const;
export type StageFeature = keyof typeof STAGE_LIMITS;

const day = (now: number) => new Date(now).toISOString().slice(0, 10);

async function reserveRow(db: D1Database, table: "user_budget" | "feature_budget", key: string | null, feature: string, cap: number, units: number, now: number): Promise<boolean> {
  const row = table === "user_budget"
    ? await db.prepare("INSERT INTO user_budget (day,user_id,feature,units) VALUES (?,?,?,?) ON CONFLICT(day,user_id,feature) DO UPDATE SET units=units+excluded.units WHERE units+excluded.units<=? RETURNING units").bind(day(now), key, feature, units, cap).first<{ units: number }>()
    : await db.prepare("INSERT INTO feature_budget (day,feature,units) VALUES (?,?,?) ON CONFLICT(day,feature) DO UPDATE SET units=units+excluded.units WHERE units+excluded.units<=? RETURNING units").bind(day(now), feature, units, cap).first<{ units: number }>();
  return row != null && row.units <= cap;
}

async function refundRow(db: D1Database, table: "user_budget" | "feature_budget", key: string | null, feature: string, units: number, now: number): Promise<void> {
  if (units <= 0) return;
  if (table === "user_budget") await db.prepare("UPDATE user_budget SET units=max(0,units-?) WHERE day=? AND user_id=? AND feature=?").bind(units, day(now), key, feature).run();
  else await db.prepare("UPDATE feature_budget SET units=max(0,units-?) WHERE day=? AND feature=?").bind(units, day(now), feature).run();
}

export type Spender = { reader: string | null; address: string | null };
export type Reservation = { ok: true; units: number } | { ok: false; which: "reader" | "address" | "global" };

/**
 * Takes `units` from every allowance that applies, or none: an allowance that would go over its cap gives back what
 * the earlier ones took. A reader id or address the request does not carry is skipped.
 */
export async function reserve(db: D1Database, feature: StageFeature, who: Spender, units = 1, now = Date.now()): Promise<Reservation> {
  const limits = STAGE_LIMITS[feature];
  const taken: Array<() => Promise<void>> = [];
  const steps: Array<["reader" | "address" | "global", () => Promise<boolean>, () => Promise<void>]> = [];
  if (limits.reader != null && who.reader) steps.push(["reader", () => reserveRow(db, "user_budget", who.reader, feature, limits.reader!, units, now), () => refundRow(db, "user_budget", who.reader, feature, units, now)]);
  if (limits.address != null && who.address) steps.push(["address", () => reserveRow(db, "user_budget", who.address, feature, limits.address!, units, now), () => refundRow(db, "user_budget", who.address, feature, units, now)]);
  if (limits.global != null) steps.push(["global", () => reserveRow(db, "feature_budget", null, feature, limits.global!, units, now), () => refundRow(db, "feature_budget", null, feature, units, now)]);
  for (const [which, take, give] of steps) {
    if (!await take()) { for (const back of taken.reverse()) await back().catch(() => {}); return { ok: false, which }; }
    taken.push(give);
  }
  return { ok: true, units };
}

/** Gives back units reserved but not spent (a turn that ended early). */
export async function refund(db: D1Database, feature: StageFeature, who: Spender, units: number, now = Date.now()): Promise<void> {
  const limits = STAGE_LIMITS[feature];
  if (units <= 0) return;
  if (limits.reader != null && who.reader) await refundRow(db, "user_budget", who.reader, feature, units, now).catch(() => {});
  if (limits.address != null && who.address) await refundRow(db, "user_budget", who.address, feature, units, now).catch(() => {});
  if (limits.global != null) await refundRow(db, "feature_budget", null, feature, units, now).catch(() => {});
}
