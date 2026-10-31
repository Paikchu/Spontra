import type { CompanyEvent, EventsPublication } from "../../../../shared/analysis-contract/events.ts";
import { form4XmlUrl, normalizeCik, parseForm4 } from "./form4.ts";

/**
 * Finds the Form 4s a stored events publication holds that are about another issuer: before the issuer was parsed, every
 * Form 4 in the company's submission list was kept, including those the company filed as a holder of someone else's
 * stock (Berkshire selling DaVita). A transaction that already names its issuer is judged from it; one read before
 * that is judged by re-reading its document from EDGAR. No model is involved.
 */

export type ForeignInsiderCheck = {
  event: CompanyEvent;
  /** The issuer the document names; null when the document could not be read or parsed (kept, never removed). */
  issuerCik: string | null;
  issuerTradingSymbol: string | null;
  foreign: boolean;
  /** Where the verdict came from. */
  via: "stored" | "document" | "unreadable";
};

/** The raw XML of an event's Form 4: the stored document URL without EDGAR's rendering directory (`xslF345X06/`). */
export function eventForm4Url(event: Pick<CompanyEvent, "documentUrl">): string {
  const cut = event.documentUrl.lastIndexOf("/", event.documentUrl.lastIndexOf("/") - 1);
  return form4XmlUrl(event.documentUrl.slice(0, cut), event.documentUrl.slice(cut + 1));
}

export async function checkInsiderIssuers(publication: EventsPublication, companyCik: string, read: (url: string) => Promise<string | null>): Promise<ForeignInsiderCheck[]> {
  const own = normalizeCik(companyCik);
  const out: ForeignInsiderCheck[] = [];
  for (const event of publication.events) {
    if (!event.insider) continue;
    if (event.insider.issuerCik) {
      out.push({ event, issuerCik: event.insider.issuerCik, issuerTradingSymbol: event.insider.issuerTradingSymbol ?? null, foreign: normalizeCik(event.insider.issuerCik) !== own, via: "stored" });
      continue;
    }
    const xml = await read(eventForm4Url(event));
    const parsed = xml ? parseForm4(xml) : null;
    if (!parsed?.issuerCik) { out.push({ event, issuerCik: null, issuerTradingSymbol: null, foreign: false, via: "unreadable" }); continue; }
    out.push({ event, issuerCik: parsed.issuerCik, issuerTradingSymbol: parsed.issuerTradingSymbol ?? null, foreign: parsed.issuerCik !== own, via: "document" });
  }
  return out;
}

/** The publication without the foreign filings; null when there is nothing to remove. */
export function withoutForeign(publication: EventsPublication, checks: ForeignInsiderCheck[]): EventsPublication | null {
  const drop = new Set(checks.filter(c => c.foreign).map(c => c.event.id));
  if (!drop.size) return null;
  return { ...publication, events: publication.events.filter(e => !drop.has(e.id)) };
}
