import type { BusinessFlowQuarter } from "@/shared/analysis-contract/business-flow";
import type { CompanyEvent, EventClass, EventsPublication } from "@/shared/analysis-contract/events";
import { DAY_MS, EVENT_CLASS_LABEL, holdingPath, insiderCadence, insiderCluster, insiderVerdict, soldShareOfHolding, type InsiderVerdict } from "@/shared/analysis-runtime/events";

export { EVENT_CLASS_LABEL };

/** Share-count formatting: 1,234,567 reads as 123.5 万股 in the rail and the lens. */
export function shares(v: number): string {
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)} 亿股`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(v >= 1e6 ? 0 : 1)} 万股`;
  return `${Math.round(v).toLocaleString("en-US")} 股`;
}

/** US dollars compact: $12.3M, $1.2B. */
export function dollars(v: number): string {
  const a = Math.abs(v), sign = v < 0 ? "−" : "";
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(0)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

export const shortDate = (d: string) => d.slice(5).replace("-", ".");

/** A Form 4 that reports no sale, purchase or exercise: grants, withholding, gifts. Kept, but folded. */
export const isQuietInsider = (e: CompanyEvent) => e.class === "insider" && !!e.insider && !e.insider.sold && !e.insider.bought && !e.insider.exercised;

/** The rail's one-line title: what happened, from the figures for Form 4 and from the summary (or EDGAR's description) for a current report. */
export function eventTitle(e: CompanyEvent): string {
  const t = e.insider;
  if (t) {
    const who = t.ownerName.replace(/\s+/g, " ");
    if (t.sold) return `${who} 卖出 ${shares(t.sold.shares)}`;
    if (t.bought) return `${who} 买入 ${shares(t.bought.shares)}`;
    if (t.exercised) return `${who} 行权 ${shares(t.exercised)}`;
    return `${who} 持股变动`;
  }
  if (e.summary?.headline) return e.summary.headline;
  if (e.description && !/^(8-K|6-K|FORM)\b/i.test(e.description)) return e.description;
  return `${EVENT_CLASS_LABEL[e.class]} · ${e.form}${e.items.length ? ` · Item ${e.items.filter(i => i !== "9.01").join(", ") || e.items.join(", ")}` : ""}`;
}

export type RailEvents = {
  /** Since the newest report was filed (or the last 90 days when that leaves too few), newest first. */
  recent: CompanyEvent[];
  /** Everything older inside the publication's window, newest first. */
  earlier: CompanyEvent[];
  /** Form 4 filings with nothing traded, counted rather than listed. */
  quiet: number;
  /** The date the recent section starts at. */
  since: string;
};

/** Splits the publication for the rail: events after the newest report's filing date are "this period", the rest fold under 更早. */
export function railEvents(publication: EventsPublication | null, quarters: BusinessFlowQuarter[], now = new Date()): RailEvents | null {
  if (!publication?.events.length) return null;
  const newest = [...quarters].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
  const reported = newest?.reportedAt ?? null;
  const ninety = new Date(now.getTime() - 90 * DAY_MS).toISOString().slice(0, 10);
  const since = reported && reported < now.toISOString().slice(0, 10) ? reported : ninety;
  const loud = publication.events.filter(e => !isQuietInsider(e)).sort((a, b) => b.filedAt.localeCompare(a.filedAt) || b.eventDate.localeCompare(a.eventDate));
  let recent = loud.filter(e => e.filedAt >= since);
  let cut = since;
  if (recent.length < 3) { recent = loud.filter(e => e.filedAt >= ninety); cut = ninety < since ? ninety : since; }
  if (recent.length < 3) { recent = loud.slice(0, 5); cut = recent[recent.length - 1]?.filedAt ?? cut; }
  const ids = new Set(recent.map(e => e.id));
  return { recent, earlier: loud.filter(e => !ids.has(e.id)), quiet: publication.events.length - loud.length, since: cut };
}

export type TimelinePoint = {
  id: string;
  date: string;
  kind: "report" | "event";
  /** Report points carry the quarter period end they open; event points carry the class. */
  periodEnd?: string;
  cls?: EventClass;
  title: string;
  /** Marker size: a report, a current report, a traded Form 4, a quiet Form 4. */
  weight: 3 | 2 | 1 | 0;
};

/** Everything on the time axis: report filings from the flow quarters, and every event. Oldest first. */
export function timelinePoints(quarters: BusinessFlowQuarter[], publication: EventsPublication | null, months = 24, now = new Date()): TimelinePoint[] {
  const floor = new Date(now.getTime() - months * 30.4 * DAY_MS).toISOString().slice(0, 10);
  const points: TimelinePoint[] = [];
  for (const q of quarters) {
    const date = q.reportedAt ?? q.periodEnd;
    if (date >= floor) points.push({ id: "report:" + q.id, date, kind: "report", periodEnd: q.periodEnd, title: `${q.periodEnd.slice(0, 7).replace("-", ".")} 财报`, weight: 3 });
  }
  for (const e of publication?.events ?? []) {
    if (e.filedAt < floor) continue;
    points.push({ id: e.id, date: e.filedAt, kind: "event", cls: e.class, title: eventTitle(e), weight: e.class === "insider" ? (isQuietInsider(e) ? 0 : 1) : 2 });
  }
  return points.sort((a, b) => a.date.localeCompare(b.date) || b.weight - a.weight);
}

/* ---------- Insider lens ---------- */

export type InsiderLensModel = {
  verdict: InsiderVerdict;
  share: number | null;
  cadence: ReturnType<typeof insiderCadence>;
  cluster: ReturnType<typeof insiderCluster>;
  path: ReturnType<typeof holdingPath>;
};

export function insiderLens(publication: EventsPublication, event: CompanyEvent): InsiderLensModel | null {
  const t = event.insider;
  if (!t) return null;
  const cadence = insiderCadence(publication.events, t.ownerCik, event.eventDate);
  const cluster = insiderCluster(publication.events, event.id);
  return { verdict: insiderVerdict(t, cadence, cluster), share: soldShareOfHolding(t), cadence, cluster, path: holdingPath(publication.events, t.ownerCik, 24, event.eventDate) };
}

export const CLASS_TONE: Record<EventClass, string> = {
  earnings: "var(--flow-profit)", guidance: "var(--biz-1)", executive: "var(--biz-3)", insider: "var(--flow-expense)", deal: "var(--biz-2)", financing: "var(--biz-4)",
  capital_return: "var(--up)", vote: "var(--muted-foreground)", legal: "var(--loss)", other: "var(--muted-foreground)",
};
