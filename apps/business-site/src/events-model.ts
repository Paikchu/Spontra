import type { BusinessFlowQuarter } from "@/shared/analysis-contract/business-flow";
import type { CompanyEvent, EventClass, EventsPublication } from "@/shared/analysis-contract/events";
import { DAY_MS, EVENT_CLASS_LABEL as EVENT_CLASS_LABEL_EN, eventClassLabel, holdingPath, INSIDER_RULES, insiderCadence, insiderCluster, insiderVerdict, soldShareOfHolding, type InsiderVerdict } from "@/shared/analysis-runtime/events";
import { compactMoney, compactShares, shortPeriod } from "@/shared/analysis-runtime/locale";
import { getLocale, labels, messages } from "@/packages/web/src/i18n";

const m = messages({
  sale: (who: string, n: string) => `${who} · Sale ${n}`,
  purchase: (who: string, n: string) => `${who} · Purchase ${n}`,
  exercise: (who: string, n: string) => `${who} · Exercise ${n}`,
  holdingChange: (who: string) => `${who} · Holding change`,
  report: (period: string) => `${period} report`,
}, {
  sale: (who: string, n: string) => `${who} · 卖出 ${n}`,
  purchase: (who: string, n: string) => `${who} · 买入 ${n}`,
  exercise: (who: string, n: string) => `${who} · 行权 ${n}`,
  holdingChange: (who: string) => `${who} · 持股变动`,
  report: (period: string) => `${period} 财报`,
});

/** Event classes in the reader's language. */
export const EVENT_CLASS_LABEL = labels(EVENT_CLASS_LABEL_EN,
  Object.fromEntries(Object.keys(EVENT_CLASS_LABEL_EN).map(k => [k, eventClassLabel(k as EventClass, "zh-CN")])) as Record<EventClass, string>);

/** Share-count formatting: 1,234,567 reads as 1.23M shares (123万股) in the rail and the lens. */
export const shares = (v: number): string => compactShares(v, getLocale());

/** US dollars compact: $12.3M, $1.2B (1230万美元, 12亿美元). */
export const dollars = (v: number): string => compactMoney(v, "USD", getLocale());

/** "2026.08 report" / "2026.08 财报": a quarter's report by its period end. */
export const periodReport = (periodEnd: string) => m.report(shortPeriod(periodEnd));

export const shortDate = (d: string) => d.slice(5).replace("-", ".");

/** A Form 4 that reports no sale, purchase or exercise: grants, withholding, gifts. Kept, but folded. */
export const isQuietInsider = (e: CompanyEvent) => e.class === "insider" && !!e.insider && !e.insider.sold && !e.insider.bought && !e.insider.exercised;

/** The rail's one-line title: what happened, from the figures for Form 4 and from the summary (or EDGAR's description) for a current report. */
export function eventTitle(e: CompanyEvent): string {
  const t = e.insider;
  if (t) {
    const who = t.ownerName.replace(/\s+/g, " ");
    if (t.sold) return m.sale(who, shares(t.sold.shares));
    if (t.bought) return m.purchase(who, shares(t.bought.shares));
    if (t.exercised) return m.exercise(who, shares(t.exercised));
    return m.holdingChange(who);
  }
  if (e.summary?.headline) return e.summary.headline;
  if (e.description && !/^(8-K|6-K|FORM)\b/i.test(e.description)) return e.description;
  return `${EVENT_CLASS_LABEL[e.class]} · ${e.form}${e.items.length ? ` · Item ${e.items.filter(i => i !== "9.01").join(", ") || e.items.join(", ")}` : ""}`;
}

/** "en" when the event's title is generated or EDGAR text (left in English), undefined when it is composed in the reader's language. */
export const eventTitleLang = (e: CompanyEvent): "en" | undefined =>
  !e.insider && (!!e.summary?.headline || (!!e.description && !/^(8-K|6-K|FORM)\b/i.test(e.description))) ? "en" : undefined;

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
    if (date >= floor) points.push({ id: "report:" + q.id, date, kind: "report", periodEnd: q.periodEnd, title: periodReport(q.periodEnd), weight: 3 });
  }
  for (const e of publication?.events ?? []) {
    if (e.filedAt < floor) continue;
    points.push({ id: e.id, date: e.filedAt, kind: "event", cls: e.class, title: eventTitle(e), weight: e.class === "insider" ? (isQuietInsider(e) ? 0 : 1) : 2 });
  }
  return points.sort((a, b) => a.date.localeCompare(b.date) || b.weight - a.weight);
}

/* ---------- Insider lens ---------- */

/** A stable key for the verdict, for styling; the verdict's label is display text and may change wording. */
export type InsiderTone = "attention" | "planned" | "routine" | "none";
export type InsiderLensModel = {
  verdict: InsiderVerdict;
  tone: InsiderTone;
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
  const share = soldShareOfHolding(t);
  // The same order of rules insiderVerdict applies: no sale, then any attention rule, then a plan or steady cadence.
  const tone: InsiderTone = !t.sold ? "none"
    : (share != null && share >= INSIDER_RULES.attentionShare) || cluster.length + 1 >= INSIDER_RULES.clusterSellers || (cadence.sales.length <= 1 && t.rule10b51 !== true) ? "attention"
    : t.rule10b51 === true || cadence.regular ? "planned" : "routine";
  return { verdict: insiderVerdict(t, cadence, cluster, getLocale()), tone, share, cadence, cluster, path: holdingPath(publication.events, t.ownerCik, 24, event.eventDate) };
}

export const CLASS_TONE: Record<EventClass, string> = {
  earnings: "var(--flow-profit)", guidance: "var(--biz-1)", executive: "var(--biz-3)", insider: "var(--flow-expense)", deal: "var(--biz-2)", financing: "var(--biz-4)",
  capital_return: "var(--up)", vote: "var(--muted-foreground)", legal: "var(--loss)", other: "var(--muted-foreground)",
};
