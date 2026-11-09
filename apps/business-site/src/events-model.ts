import { insiderCompactMoney } from "./insider-money";
import type { CompanyEvent, EventClass } from "@/shared/analysis-contract/events";
import type { InsiderTotals } from "@/shared/analysis-contract/insiders";
import { isOpenMarketInsiderTrade, EVENT_CLASS_LABEL as EVENT_CLASS_LABEL_EN, eventClassLabel, filingDocumentTitle, isQuietInsider } from "@/shared/analysis-runtime/events";
import { compactMoney, compactShares, shortPeriod } from "@/shared/analysis-runtime/locale";
import { getLocale, labels, messages } from "@/packages/web/src/i18n";
import { langOf } from "@/packages/web/src/i18n/SourceLanguage";

const m = messages({
  sale: (n: string) => `Sale ${n}`,
  purchase: (n: string) => `Purchase ${n}`,
  exercise: (n: string) => `Exercise ${n}`,
  holdingChange: "Holding change",
  sold: "sold", bought: "bought", exercised: "exercised",
}, {
  sale: (n: string) => `卖出 ${n}`,
  purchase: (n: string) => `买入 ${n}`,
  exercise: (n: string) => `行权 ${n}`,
  holdingChange: "持股变动",
  sold: "卖出", bought: "买入", exercised: "行权",
});

/** Event classes in the reader's language. */
export const EVENT_CLASS_LABEL = labels(EVENT_CLASS_LABEL_EN,
  Object.fromEntries(Object.keys(EVENT_CLASS_LABEL_EN).map(k => [k, eventClassLabel(k as EventClass, "zh-CN")])) as Record<EventClass, string>);

/** Share-count formatting: 1,234,567 reads as 1.23M shares (123万股) in the rail and the lens. */
export const shares = (v: number): string => compactShares(v, getLocale());

/** US dollars compact: $12.3M, $1.2B (1230万美元, 12亿美元); an unknown amount (a Form 4 line without a price) reads "—". */
const dollars = (v: number | null): string => v == null ? "—" : compactMoney(v, "USD", getLocale());

/** A total of amounts some of which may be unknown: exact when all are known, "≥" the known part when some are, "—" when none are. */
function partialDollars(values: readonly (number | null)[]): string {
  const known = values.filter((v): v is number => v != null);
  const total = dollars(known.reduce((s, v) => s + v, 0));
  return known.length === values.length ? total : known.length ? `≥ ${total}` : "—";
}

/** Person totals retain the priced subtotal when the full amount is unknown. */
export const insiderTotalDollars = (totals: InsiderTotals): string => partialDollars(totals.value != null ? [totals.value]
  : totals.pricedCount > 0 ? [totals.pricedValue, null] : [null]);

/** "2026.08 report" / "2026.08 财报": a quarter's report by its period end. */

export const shortDate = (d: string) => d.slice(5).replace("-", ".");

export { isQuietInsider };

/** A Form 4's figures as the stage title reads them: who, what, and the amount when known. */
function insiderTitleParts(e: CompanyEvent): { name: string; content: string; amount: string | null } | null {
  const t = e.insider;
  if (!t) return null;
  const name = t.ownerName.replace(/\s+/g, " ").trim();
  const direction = isOpenMarketInsiderTrade(e);
  if (direction === "sell" && t.sold) return { name, content: m.sale(shares(t.sold.shares)), amount: t.sold.proceeds != null && t.sold.proceeds > 0 ? insiderCompactMoney(t.sold.proceeds, getLocale()) : null };
  if (direction === "buy" && t.bought) return { name, content: m.purchase(shares(t.bought.shares)), amount: t.bought.cost != null && t.bought.cost > 0 ? insiderCompactMoney(t.bought.cost, getLocale()) : null };
  return { name, content: t.exercised ? m.exercise(shares(t.exercised)) : m.holdingChange, amount: null };
}

/** A Form 4 in the rail: who, and which way; the figures are on the stage. */
export function insiderRailTitle(e: CompanyEvent): string | null {
  const t = e.insider;
  if (!t) return null;
  const direction = isOpenMarketInsiderTrade(e);
  const verb = direction === "sell" ? m.sold : direction === "buy" ? m.bought : t.exercised ? m.exercised : m.holdingChange;
  return `${t.ownerName.replace(/\s+/g, " ").trim()} ${verb}`;
}

/** The one-line title: what happened, from the figures for Form 4 and from the summary (or EDGAR's description) for a current report. */
export function eventTitle(e: CompanyEvent): string {
  const insider = insiderTitleParts(e);
  if (insider) return [insider.name, insider.content, insider.amount].filter(Boolean).join(" · ");
  if (e.summary?.headline) return e.summary.headline;
  const documentTitle = filingDocumentTitle(e);
  if (documentTitle) return documentTitle;
  const items = e.items.filter(i => i !== "9.01");
  if (items.length) return `${EVENT_CLASS_LABEL[e.class]} · ${e.form} · Item ${items.join(", ")}`;
  // A current report with no items and no description used to read "其他 · 6-K". The form is the whole title; routine 6-Ks are grouped.
  if (e.class === "other") return e.form;
  return `${EVENT_CLASS_LABEL[e.class]} · ${e.form}`;
}

/** The language of the event's title when it is generated (translated once Spontra Analysis has) or EDGAR text (English); undefined when it is composed in the reader's language. */
export const eventTitleLang = (e: CompanyEvent): ReturnType<typeof langOf> | undefined =>
  !e.insider && (!!e.summary?.headline || !!filingDocumentTitle(e)) ? langOf(eventTitle(e)) : undefined;
