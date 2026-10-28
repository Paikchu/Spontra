import { z } from "zod";
import type { CompanyEvent, EventClass, EventImportance, EventsPublication, InsiderTransaction } from "../analysis-contract/events.ts";
import type { Locale } from "./locale.ts";
import { TICKER_PATTERN } from "./financial-data/policy.ts";

/* ---------- Classification ---------- */

export const EVENT_CLASS_LABEL: Record<EventClass, string> = {
  earnings: "Earnings", guidance: "Guidance", executive: "Leadership change", insider: "Insider trade", deal: "M&A", financing: "Financing",
  capital_return: "Buybacks & dividends", vote: "Shareholder vote", legal: "Legal & regulatory", other: "Other",
};
const EVENT_CLASS_LABEL_ZH: Record<EventClass, string> = {
  earnings: "业绩", guidance: "业绩指引", executive: "管理层变动", insider: "内部人交易", deal: "并购交易", financing: "融资",
  capital_return: "回购与分红", vote: "股东投票", legal: "法律与监管", other: "其他",
};

/** An event class as the reader's locale names it; English is EVENT_CLASS_LABEL. */
export const eventClassLabel = (cls: EventClass, locale: Locale = "en") => (locale === "zh-CN" ? EVENT_CLASS_LABEL_ZH : EVENT_CLASS_LABEL)[cls];

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
  // English and Chinese terms: descriptions come from EDGAR or, when absent, from a stored summary headline in either language.
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

/* ---------- Noise rank and document titles ---------- */

/** Descriptions that only name the form, so they are not a title a reader can use. */
const FORM_ONLY = /^(?:form\s+)?(?:8-k|6-k|4)(?:\/a)?$/i;
/** EDGAR's generic primary-document labels. They describe the form, not the filing. */
const GENERIC_DESCRIPTION = /^(?:primary document|ownership document|current report|statement of changes in beneficial ownership(?: of securities)?)$/i;

/** A stored or indexed description that says more than the form name; null when it does not. */
export function filingDocumentTitle(event: { description?: string | null; title?: string | null }): string | null {
  const raw = (event.title ?? "").trim() || (event.description ?? "").trim();
  if (!raw || FORM_ONLY.test(raw) || GENERIC_DESCRIPTION.test(raw) || /^(?:8-K|6-K|FORM)\b/i.test(raw)) return null;
  return raw.slice(0, 300);
}

/**
 * The primary document's Description cell on an EDGAR filing index page.
 * The cell is the form name itself for a routine 6-K ("6-K"); that reads as no title.
 */
export function indexPrimaryDescription(html: string): string | null {
  const row = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match: RegExpExecArray | null;
  while ((match = row.exec(html))) {
    const cells = [...match[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell =>
      cell[1].replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim());
    if (cells.length < 4 || cells[0] !== "1") continue;
    const description = cells[1] ?? "";
    const type = cells[3] ?? "";
    if (!description || FORM_ONLY.test(description) || GENERIC_DESCRIPTION.test(description)) return null;
    if (description.toUpperCase() === type.toUpperCase() || /^(?:8-K|6-K|FORM)\b/i.test(description)) return null;
    return description.slice(0, 300);
  }
  return null;
}

/** An open-market sale the Form 4 marks as made under a 10b5-1 plan. */
export const isPlannedSale = (event: CompanyEvent) =>
  event.class === "insider" && !!event.insider?.sold && event.insider.sold.shares > 0 && event.insider.rule10b51 === true;

/** A director's or officer's open-market purchase. Grants and exercises are not purchases. */
export const isOpenMarketBuy = (event: CompanyEvent) => {
  const insider = event.insider;
  return event.class === "insider" && !!insider?.bought && insider.bought.shares > 0 && (insider.isDirector || insider.isOfficer);
};

/**
 * Where a filing sits in the rail.
 * Key: earnings and guidance, leadership changes, shareholder votes, a current report that has a summary,
 * an insider sale that is not a 10b5-1 plan, and a director's or officer's open-market buy.
 * Routine: 10b5-1 sales, grants and gifts, and a 6-K or 8-K with neither a summary nor a document title.
 * Everything else (an exercise, a current report that has a document title but no summary) is normal.
 */
export function eventImportance(event: CompanyEvent): EventImportance {
  if (event.class === "earnings" || event.class === "guidance" || event.class === "executive" || event.class === "vote") return "key";
  const current = event.form.startsWith("8-K") || event.form.startsWith("6-K");
  if (current && event.summary?.headline) return "key";
  if (isOpenMarketBuy(event)) return "key";
  if (event.class === "insider" && event.insider?.sold && event.insider.sold.shares > 0 && event.insider.rule10b51 !== true) return "key";
  const quiet = event.class === "insider" && !!event.insider && !event.insider.sold && !event.insider.bought && !event.insider.exercised;
  if (isPlannedSale(event) || quiet) return "routine";
  if (current && !event.summary?.headline && !filingDocumentTitle(event)) return "routine";
  return "normal";
}

/** Fills `title` and `importance` from the filing's own fields. Idempotent, and it calls no model. */
export function annotateEvent(event: Omit<CompanyEvent, "title" | "importance"> & { title?: string | null }): CompanyEvent {
  const title = filingDocumentTitle(event);
  const next: CompanyEvent = { ...event, title, importance: "normal" };
  return { ...next, importance: eventImportance(next) };
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
  id: text(40), ticker: z.string().regex(TICKER_PATTERN), form: z.enum(["8-K", "8-K/A", "6-K", "6-K/A", "4", "4/A"]), filedAt: date, eventDate: date,
  items: z.array(z.string().regex(/^\d\.\d\d$/)).max(20),
  class: z.enum(["earnings", "guidance", "executive", "insider", "deal", "financing", "capital_return", "vote", "legal", "other"]),
  description: text(300), title: text(300).nullable().optional(), importance: z.enum(["key", "normal", "routine"]).optional(),
  edgarUrl: https, documentUrl: https,
  exhibits: z.array(z.object({ type: text(20), title: text(200), url: https })).max(30),
  summary: summary.nullable(), insider: insider.nullable(),
});
export const eventsPublicationSchema = z.object({
  schemaVersion: z.literal("events.v1"), ticker: z.string().regex(TICKER_PATTERN), checkedAt: z.string().max(40),
  events: z.array(event).max(400), pendingInsider: z.number().int().nonnegative(),
});

/** Parses a stored or fetched publication for one ticker, stripping unknown fields; a mismatched ticker or an invalid document reads as none. */
export function readEventsPublication(value: unknown, ticker: string): EventsPublication | null {
  const parsed = eventsPublicationSchema.safeParse(value);
  if (!parsed.success || parsed.data.ticker !== ticker) return null;
  const events = parsed.data.events.filter(e => e.ticker === ticker && (e.form.startsWith("4") ? e.class === "insider" : e.class !== "insider"))
    .sort((a, b) => b.filedAt.localeCompare(a.filedAt) || b.eventDate.localeCompare(a.eventDate))
    .map(event => annotateEvent(event));
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

export type InsiderVerdictLabel = "Planned" | "Routine" | "Watch" | "Non-trade";
/** `label` is display text in the requested locale: one of InsiderVerdictLabel in English. */
export type InsiderVerdict = { label: string; rules: string[] };

/** Thresholds the verdict rules use; shown beside the verdict so the reader sees which rule fired. */
export const INSIDER_RULES = { attentionShare: 10, routineShare: 5, clusterSellers: 3, clusterDays: 30 } as const;

const VERDICT_TEXT = {
  en: {
    label: { Planned: "Planned", Routine: "Routine", Watch: "Watch", "Non-trade": "Non-trade" } as Record<InsiderVerdictLabel, string>,
    purchase: "Open-market purchase",
    exercise: "Exercise or conversion, no sale",
    quiet: "Grant, tax withholding or gift; not a trading signal",
    soldAbove: (share: string, threshold: number) => `Sold ${share}% of the pre-trade holding, at or above the ${threshold}% threshold`,
    cluster: (sellers: number, days: number) => `${sellers} insiders sold within ${days} days`,
    firstSale: "First sale in the past 12 months, not marked as a 10b5-1 plan",
    plan: "Filing marks the trade as made under a 10b5-1 plan",
    cadence: (sales: number, days: number) => `${sales} sales in the past 12 months, about ${days} days apart`,
    soldBelow: (share: string, threshold: number) => `Sold ${share}% of the pre-trade holding, below ${threshold}%`,
    holdingUnknown: "Holding after the trade is not disclosed, so the share sold cannot be calculated",
    noCluster: "No cluster of other insider sales in the same window",
  },
  "zh-CN": {
    label: { Planned: "计划内", Routine: "常规", Watch: "关注", "Non-trade": "非交易" } as Record<InsiderVerdictLabel, string>,
    purchase: "公开市场买入",
    exercise: "行权或转换，未卖出",
    quiet: "授予、代扣税或赠与，非交易信号",
    soldAbove: (share: string, threshold: number) => `卖出交易前持股的 ${share}%，达到 ${threshold}% 阈值`,
    cluster: (sellers: number, days: number) => `${days} 天内 ${sellers} 名内部人卖出`,
    firstSale: "近 12 个月首次卖出，未标注 10b5-1 交易计划",
    plan: "文件标注该交易依 10b5-1 交易计划进行",
    cadence: (sales: number, days: number) => `近 12 个月卖出 ${sales} 次，间隔约 ${days} 天`,
    soldBelow: (share: string, threshold: number) => `卖出交易前持股的 ${share}%，低于 ${threshold}%`,
    holdingUnknown: "交易后持股未披露，无法计算卖出比例",
    noCluster: "同期无其他内部人集中卖出",
  },
} satisfies Record<Locale, unknown>;

/**
 * A deterministic reading of one filing against the owner's own history and the other insiders:
 * which rule fired is part of the answer, so the page can show it rather than a bare label.
 */
export function insiderVerdict(t: InsiderTransaction, cadence: InsiderCadence, cluster: ReturnType<typeof insiderCluster>, locale: Locale = "en"): InsiderVerdict {
  const w = VERDICT_TEXT[locale];
  if (!t.sold) return { label: w.label["Non-trade"], rules: t.bought ? [w.purchase] : t.exercised ? [w.exercise] : [w.quiet] };
  const share = soldShareOfHolding(t);
  const rules: string[] = [];
  if (share != null && share >= INSIDER_RULES.attentionShare) rules.push(w.soldAbove(share.toFixed(1), INSIDER_RULES.attentionShare));
  if (cluster.length + 1 >= INSIDER_RULES.clusterSellers) rules.push(w.cluster(cluster.length + 1, INSIDER_RULES.clusterDays));
  if (cadence.sales.length <= 1 && t.rule10b51 !== true) rules.push(w.firstSale);
  if (rules.length) return { label: w.label.Watch, rules };
  if (t.rule10b51 === true || cadence.regular) return { label: w.label.Planned, rules: [t.rule10b51 === true ? w.plan : w.cadence(cadence.sales.length, Math.round(cadence.intervalDays ?? 0))] };
  return { label: w.label.Routine, rules: [share != null ? w.soldBelow(share.toFixed(1), INSIDER_RULES.attentionShare) : w.holdingUnknown, w.noCluster] };
}

/** A Form 4 that reports no sale, purchase or exercise: grants, withholding, gifts. Kept, but folded. */
export const isQuietInsider = (e: CompanyEvent) => e.class === "insider" && !!e.insider && !e.insider.sold && !e.insider.bought && !e.insider.exercised;

/** A stable key for the verdict, for styling and for which filings get an analysis; the verdict's label is display text. */
export type InsiderTone = "attention" | "planned" | "routine" | "none";

/** The verdict's tone, by the same order of rules `insiderVerdict` applies: no sale, then any attention rule, then a plan or steady cadence. */
export function insiderTone(events: CompanyEvent[], event: CompanyEvent): InsiderTone {
  const t = event.insider;
  if (!t?.sold) return "none";
  const cadence = insiderCadence(events, t.ownerCik, event.eventDate);
  const share = soldShareOfHolding(t);
  if ((share != null && share >= INSIDER_RULES.attentionShare) || insiderCluster(events, event.id).length + 1 >= INSIDER_RULES.clusterSellers || (cadence.sales.length <= 1 && t.rule10b51 !== true)) return "attention";
  return t.rule10b51 === true || cadence.regular ? "planned" : "routine";
}

export type HoldingPoint = { id: string; date: string; held: number; sold: number; proceeds: number; bought: number; cost: number; exercised: number; planned: boolean | null };

/** The holding path one owner's filings trace, oldest first: each filing's held-after figure, for the ladder. */
export function holdingPath(events: CompanyEvent[], ownerCik: string, months = 24, until?: string): HoldingPoint[] {
  const end = until ? Date.parse(until) : Infinity, start = (Number.isFinite(end) ? end : Date.now()) - months * 30.4 * DAY_MS;
  return events.filter(e => e.insider?.ownerCik === ownerCik && e.insider.heldAfter != null && Date.parse(e.eventDate) <= end && Date.parse(e.eventDate) >= start)
    .map(e => ({
      id: e.id, date: e.eventDate, held: e.insider!.heldAfter!, sold: e.insider!.sold?.shares ?? 0, proceeds: e.insider!.sold?.proceeds ?? 0,
      bought: e.insider!.bought?.shares ?? 0, cost: e.insider!.bought?.cost ?? 0, exercised: e.insider!.exercised, planned: e.insider!.rule10b51,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Shares outstanding as a filing reports them, dated at the period end. */
export type ShareCount = { date: string; shares: number };

/** The share count in force on a date: the latest reported on or before it, else the earliest reported after it. */
export function outstandingAt(counts: ShareCount[], date: string): ShareCount | null {
  let at: ShareCount | null = null;
  for (const c of counts) if (c.date <= date && (!at || c.date > at.date)) at = c;
  return at ?? counts.reduce<ShareCount | null>((first, c) => !first || c.date < first.date ? c : first, null);
}

/** A filing's direct holding as a percent of shares outstanding, just before its trades and after them. */
export type StakeChange = { before: number | null; after: number | null; /** The share count both are read against. */ outstanding: ShareCount };

/**
 * The owner's stake in the company around one filing: the direct holding before and after its sales and purchases,
 * over the share count in force on the event date. Null when no share count is known or the holding after is not
 * disclosed; a percent is never estimated from a missing figure.
 */
export function stakeChange(t: InsiderTransaction, counts: ShareCount[], date: string): StakeChange | null {
  const outstanding = outstandingAt(counts.filter(c => c.shares > 0 && Number.isFinite(c.shares)), date);
  if (!outstanding || t.heldAfter == null) return null;
  const prior = t.heldAfter + (t.sold?.shares ?? 0) - (t.bought?.shares ?? 0);
  return { before: prior >= 0 ? prior / outstanding.shares * 100 : null, after: t.heldAfter / outstanding.shares * 100, outstanding };
}
