import { z } from "zod";
import type { CompanyEvent, EventClass, EventsPublication, InsiderTransaction } from "../analysis-contract/events.ts";

/* ---------- Classification ---------- */

export const EVENT_CLASS_LABEL: Record<EventClass, string> = {
  earnings: "业绩", guidance: "指引", executive: "高管变动", insider: "内部人交易", deal: "并购", financing: "融资",
  capital_return: "回购分红", vote: "股东投票", legal: "法律监管", other: "其他事项",
};

/**
 * The 8-K item codes that decide an event's class, most specific first: a results release that also
 * attaches a press release (9.01) is earnings, an appointment filed with an exhibit is executive.
 */
const ITEM_CLASS: Array<[RegExp, EventClass]> = [
  [/^2\.02$/, "earnings"],
  [/^5\.02$/, "executive"],
  [/^(2\.01|1\.01|2\.05|2\.06)$/, "deal"],
  [/^(2\.03|2\.04|3\.02|3\.03)$/, "financing"],
  [/^5\.07$/, "vote"],
  [/^(1\.05|8\.01)$/, "legal"],
  [/^(7\.01|1\.02|1\.03|3\.01|4\.01|4\.02|5\.01|5\.03|5\.04|5\.05|5\.06|5\.08|6\.0\d|9\.01)$/, "other"],
];

/** Splits EDGAR's item string ("2.02,9.01") into codes. */
export function parseItems(items: string): string[] {
  return [...new Set(items.split(/[,\s;]+/).map(s => s.trim()).filter(s => /^\d\.\d\d$/.test(s)))];
}

/**
 * 8.01 ("Other events") is where buyback authorisations, dividends and litigation land alike, so its
 * class is read from the primary document's description when EDGAR gives one; without it, 8.01 is
 * legal only when the description says so and "other" otherwise.
 */
export function classifyEvent(form: string, items: string[], description = ""): EventClass {
  if (/^4(\/A)?$/.test(form)) return "insider";
  const text = description.toLowerCase();
  const buyback = /buyback|repurchase|dividend|回购|分红|股息/.test(text);
  const legal = /litigation|lawsuit|settlement|investigation|subpoena|cybersecurity|诉讼|和解|调查/.test(text);
  for (const [pattern, cls] of ITEM_CLASS) {
    const hit = items.find(item => pattern.test(item));
    if (!hit) continue;
    if (hit === "8.01") return buyback ? "capital_return" : legal ? "legal" : "other";
    if (hit === "7.01" && /guidance|outlook|指引|展望/.test(text)) return "guidance";
    return cls;
  }
  if (buyback) return "capital_return";
  if (legal) return "legal";
  return "other";
}

/* ---------- Validation ---------- */

const text = (max: number) => z.string().max(max);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const https = z.string().url().max(500).refine(u => u.startsWith("https://"), "https only");
const finite = z.number().finite();

const insiderLine = z.object({
  date, code: z.enum(["S", "P", "M", "F", "A", "G", "D", "C", "J", "X", "W", "I", "Z", "L", "U", "O", "E", "H", "K"]),
  acquiredDisposed: z.enum(["A", "D"]), shares: finite.nonnegative(), price: finite.nonnegative().nullable(), ownedAfter: finite.nullable(),
  ownership: z.enum(["D", "I"]), derivative: z.boolean(),
});
const insider = z.object({
  ownerCik: text(20), ownerName: text(160), title: text(120).nullable(), isDirector: z.boolean(), isOfficer: z.boolean(), isTenPercentOwner: z.boolean(),
  rule10b51: z.boolean().nullable(), planAdoptedOn: date.nullable(), securityTitle: text(120), lines: z.array(insiderLine).max(200),
  sold: z.object({ shares: finite.nonnegative(), proceeds: finite.nonnegative(), averagePrice: finite.nonnegative() }).nullable(),
  bought: z.object({ shares: finite.nonnegative(), cost: finite.nonnegative(), averagePrice: finite.nonnegative() }).nullable(),
  exercised: finite.nonnegative(), heldAfter: finite.nullable(), footnotes: z.array(text(2000)).max(40),
});
const summary = z.object({
  headline: text(400), bullets: z.array(z.object({ label: text(120), detail: text(1200), importance: z.enum(["high", "medium", "low"]) })).max(12),
  analystView: text(1200), eventCategory: z.enum(["earnings_update", "guidance", "m&a", "executive", "legal", "other"]).nullable(), generatedAt: z.string().max(40),
});
const event = z.object({
  id: text(40), ticker: z.string().regex(/^[A-Z][A-Z0-9.-]{0,11}$/), form: z.enum(["8-K", "8-K/A", "6-K", "6-K/A", "4", "4/A"]), filedAt: date, eventDate: date,
  items: z.array(z.string().regex(/^\d\.\d\d$/)).max(20),
  class: z.enum(["earnings", "guidance", "executive", "insider", "deal", "financing", "capital_return", "vote", "legal", "other"]),
  description: text(300), edgarUrl: https, documentUrl: https,
  exhibits: z.array(z.object({ type: text(20), title: text(200), url: https })).max(30),
  summary: summary.nullable(), insider: insider.nullable(),
});
export const eventsPublicationSchema = z.object({
  schemaVersion: z.literal("events.v1"), ticker: z.string().regex(/^[A-Z][A-Z0-9.-]{0,11}$/), checkedAt: z.string().max(40),
  events: z.array(event).max(400), pendingInsider: z.number().int().nonnegative(),
});

/** Parses a stored or fetched publication for one ticker, stripping unknown fields; a mismatched ticker or an invalid document reads as none. */
export function readEventsPublication(value: unknown, ticker: string): EventsPublication | null {
  const parsed = eventsPublicationSchema.safeParse(value);
  if (!parsed.success || parsed.data.ticker !== ticker) return null;
  const events = parsed.data.events.filter(e => e.ticker === ticker && (e.form.startsWith("4") ? e.class === "insider" : e.class !== "insider"))
    .sort((a, b) => b.filedAt.localeCompare(a.filedAt) || b.eventDate.localeCompare(a.eventDate));
  return { ...parsed.data, events };
}

/* ---------- Insider analytics ---------- */

export const DAY_MS = 86_400_000;

/** Share of the owner's pre-trade direct holding this filing's sales represent, in percent; null when the holding after is unknown. */
export function soldShareOfHolding(t: InsiderTransaction): number | null {
  if (!t.sold || t.heldAfter == null) return null;
  const before = t.heldAfter + t.sold.shares;
  return before > 0 ? t.sold.shares / before * 100 : null;
}

export type InsiderCadence = {
  /** Sales by this owner in the trailing window, oldest first. */
  sales: Array<{ id: string; date: string; shares: number; proceeds: number; share: number | null; planned: boolean | null }>;
  /** Mean days between consecutive sales; null with fewer than two. */
  intervalDays: number | null;
  /** True when every interval sits within 40% of the mean and there are at least three sales: a scheduled pattern. */
  regular: boolean;
  totalShares: number;
  totalProceeds: number;
};

/** One owner's sales over the trailing months before (and including) the event, so a single filing reads against its own history. */
export function insiderCadence(events: CompanyEvent[], ownerCik: string, until: string, months = 12): InsiderCadence {
  const end = Date.parse(until), start = end - months * 30.4 * DAY_MS;
  const sales = events.filter(e => e.insider?.ownerCik === ownerCik && e.insider.sold && Date.parse(e.eventDate) <= end && Date.parse(e.eventDate) >= start)
    .map(e => ({ id: e.id, date: e.eventDate, shares: e.insider!.sold!.shares, proceeds: e.insider!.sold!.proceeds, share: soldShareOfHolding(e.insider!), planned: e.insider!.rule10b51 }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const gaps = sales.slice(1).map((s, i) => (Date.parse(s.date) - Date.parse(sales[i].date)) / DAY_MS);
  const intervalDays = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
  const regular = sales.length >= 3 && intervalDays != null && gaps.every(g => Math.abs(g - intervalDays) <= intervalDays * 0.4);
  return { sales, intervalDays, regular, totalShares: sales.reduce((s, x) => s + x.shares, 0), totalProceeds: sales.reduce((s, x) => s + x.proceeds, 0) };
}

/** Other insiders who sold within the window around the event date: a cluster is a stronger signal than one seller. */
export function insiderCluster(events: CompanyEvent[], eventId: string, days = 30): Array<{ id: string; ownerName: string; title: string | null; date: string; proceeds: number }> {
  const self = events.find(e => e.id === eventId)?.insider;
  const at = Date.parse(events.find(e => e.id === eventId)?.eventDate ?? "");
  if (!self || !Number.isFinite(at)) return [];
  const seen = new Set<string>();
  return events.filter(e => e.insider?.sold && e.insider.ownerCik !== self.ownerCik && Math.abs(Date.parse(e.eventDate) - at) <= days * DAY_MS)
    .filter(e => { if (seen.has(e.insider!.ownerCik)) return false; seen.add(e.insider!.ownerCik); return true; })
    .map(e => ({ id: e.id, ownerName: e.insider!.ownerName, title: e.insider!.title, date: e.eventDate, proceeds: e.insider!.sold!.proceeds }));
}

export type InsiderVerdict = { label: "按计划" | "常规" | "需要留意" | "非交易变动"; rules: string[] };

/** Thresholds the verdict rules use; shown beside the verdict so the reader sees which rule fired. */
export const INSIDER_RULES = { attentionShare: 10, routineShare: 5, clusterSellers: 3, clusterDays: 30 } as const;

/**
 * A deterministic reading of one filing against the owner's own history and the other insiders:
 * which rule fired is part of the answer, so the page can show it rather than a bare label.
 */
export function insiderVerdict(t: InsiderTransaction, cadence: InsiderCadence, cluster: ReturnType<typeof insiderCluster>): InsiderVerdict {
  if (!t.sold) return { label: "非交易变动", rules: t.bought ? ["公开市场买入"] : t.exercised ? ["行权或转换，未卖出"] : ["授予、代扣或赠与，不构成交易信号"] };
  const share = soldShareOfHolding(t);
  const rules: string[] = [];
  if (share != null && share >= INSIDER_RULES.attentionShare) rules.push(`卖出占交易前持股 ${share.toFixed(1)}%，达到 ${INSIDER_RULES.attentionShare}% 阈值`);
  if (cluster.length + 1 >= INSIDER_RULES.clusterSellers) rules.push(`${INSIDER_RULES.clusterDays} 天内共 ${cluster.length + 1} 名内部人卖出`);
  if (cadence.sales.length <= 1 && t.rule10b51 !== true) rules.push("近 12 个月首次卖出，且未标注 10b5-1 计划");
  if (rules.length) return { label: "需要留意", rules };
  if (t.rule10b51 === true || cadence.regular) return { label: "按计划", rules: [t.rule10b51 === true ? "申报标注为 10b5-1 计划交易" : `近 12 个月 ${cadence.sales.length} 次卖出，间隔约 ${Math.round(cadence.intervalDays ?? 0)} 天`] };
  return { label: "常规", rules: [share != null ? `卖出占交易前持股 ${share.toFixed(1)}%，低于 ${INSIDER_RULES.attentionShare}%` : "交易后持股未披露，无法计算占比", "同期无其他内部人集中卖出"] };
}

/** The holding path one owner's filings trace, oldest first: each filing's held-after figure, for the ladder. */
export function holdingPath(events: CompanyEvent[], ownerCik: string, months = 24, until?: string): Array<{ id: string; date: string; held: number; sold: number; bought: number; exercised: number; planned: boolean | null }> {
  const end = until ? Date.parse(until) : Infinity, start = (Number.isFinite(end) ? end : Date.now()) - months * 30.4 * DAY_MS;
  return events.filter(e => e.insider?.ownerCik === ownerCik && e.insider.heldAfter != null && Date.parse(e.eventDate) <= end && Date.parse(e.eventDate) >= start)
    .map(e => ({ id: e.id, date: e.eventDate, held: e.insider!.heldAfter!, sold: e.insider!.sold?.shares ?? 0, bought: e.insider!.bought?.shares ?? 0, exercised: e.insider!.exercised, planned: e.insider!.rule10b51 }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
