import { companyRequest } from "./company-request";
import { selectFlow } from "@/packages/web/src/model/business-flow-model";
import type { CompleteFlowPublication } from "@/shared/analysis-contract/complete-business-flow";
import type { PublicBusinessFlow } from "@/shared/analysis-contract/business-flow";
import type { BusinessExplainer } from "@/shared/analysis-contract/business-explainer";
import type { BusinessTree } from "@/shared/analysis-contract/business-tree";
import type { PublicCapitalStructure } from "@/shared/analysis-contract/capital-structure";
import type { FindingPassage, FindingsPublication } from "@/shared/analysis-contract/findings";
import type { ItemAnalysis } from "@/shared/analysis-contract/item-analysis";
import type { PeersPublication } from "@/shared/analysis-contract/peers";
import type { EventsPublication } from "@/shared/analysis-contract/events";
import type { InsiderTransactionsPage, InsidersPublication } from "@/shared/analysis-contract/insiders";
import type { ValuationResponse } from "@/shared/analysis-contract/valuation";
import { getLocale } from "@/packages/web/src/i18n";
import { rememberIssuer } from "@/shared/analysis-runtime/fiscal-label";
import { companyPath as pathForLocale } from "./company-opening";

export { fetchRevisions } from "./company-opening";

export type CompanyPublication = CompleteFlowPublication & { explainer?: BusinessExplainer | null; tree?: BusinessTree | null };

/**
 * In Chinese the API serves the generated prose translated where Spontra Analysis has translated it; the rest stays English.
 * `rev` asks for the resource at its publication revision, so no cache answers with a copy older than it.
 */
const companyPath = (ticker: string, resource = "", rev?: string) => pathForLocale(ticker, getLocale(), resource, rev);

/** A company read that answered with an HTTP status. `status` 0 is a network failure, which never got one. */
export class CompanyHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(String(status));
    this.name = "CompanyHttpError";
    this.status = status;
  }
}

export async function fetchCompany(ticker: string, signal: AbortSignal, rev?: string, openingResponse?: Promise<Response>): Promise<CompanyPublication> {
  let response: Response;
  try {
    response = await companyRequest(companyPath(ticker, "", rev), signal, openingResponse);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new CompanyHttpError(0);
  }
  if (!response.ok) throw new CompanyHttpError(response.status);
  const publication = await response.json() as CompanyPublication;
  // Every period label on the page reads the issuer's fiscal calendar from here.
  if (publication.issuer) rememberIssuer(ticker, publication.issuer);
  return publication;
}

/**
 * The events publication, or null while it is still preparing. `error` is a failed request: the page keeps every other
 * section and offers a retry. A preparing company is not an error.
 */
export async function fetchEvents(ticker: string, signal: AbortSignal, rev?: string, openingResponse?: Promise<Response>): Promise<{ events: EventsPublication | null; error: boolean }> {
  try {
    const response = await companyRequest(companyPath(ticker, "/events", rev), signal, openingResponse);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (!response.ok) return { events: null, error: true };
    const body = await response.json() as { status?: string; events?: EventsPublication | null };
    return { events: body.status === "ready" && body.events ? body.events : null, error: false };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { events: null, error: true };
  }
}

/**
 * A supplementary resource answers on its own; anything but "ready" reads as null, except fundamentals that are
 * unavailable for a stated reason, which the page shows.
 */
export async function fetchSupplement<T>(ticker: string, resource: "findings" | "fundamentals" | "events" | "filings", signal: AbortSignal, rev?: string, openingResponse?: Promise<Response>): Promise<T | null> {
  const response = await companyRequest(companyPath(ticker, "/" + resource, rev), signal, openingResponse);
  if (!response.ok) throw new CompanyHttpError(response.status);
  const body = await response.json() as { status?: string } & Record<string, unknown>;
  if (resource === "fundamentals" && body.status === "unavailable" && (body.fundamentals as { unavailable?: unknown } | null)?.unavailable) return body.fundamentals as T;
  return body.status === "ready" ? body[resource] as T : null;
}

export async function fetchCapital(ticker: string, signal: AbortSignal, rev?: string, openingResponse?: Promise<Response>): Promise<PublicCapitalStructure | null> {
  const response = await companyRequest(companyPath(ticker, "/capital", rev), signal, openingResponse);
  if (!response.ok) throw new CompanyHttpError(response.status);
  const body = await response.json() as { status?: string; capital?: PublicCapitalStructure | null };
  return body.status === "ready" && body.capital ? body.capital : null;
}

/** The findings with the passages their quotes rest on and the peers projection, as the site serves them together. */
export type FindingsBundle = { findings: FindingsPublication; passages: FindingPassage[]; peers: PeersPublication | null };
export async function fetchFindings(ticker: string, signal: AbortSignal, rev?: string, openingResponse?: Promise<Response>): Promise<FindingsBundle | null> {
  const response = await companyRequest(companyPath(ticker, "/findings", rev), signal, openingResponse);
  if (!response.ok) throw new CompanyHttpError(response.status);
  const body = await response.json() as { status?: string; findings?: FindingsPublication | null; passages?: FindingPassage[]; peers?: PeersPublication | null };
  return body.status === "ready" && body.findings ? { findings: body.findings, passages: body.passages ?? [], peers: body.peers ?? null } : null;
}

/** The valuation assessment in every state it answers with (hidden, preparing, ready, insufficient, failed); null only when the read failed. */
export async function fetchValuation(ticker: string, signal: AbortSignal, rev?: string, openingResponse?: Promise<Response>): Promise<ValuationResponse | null> {
  const response = await companyRequest(companyPath(ticker, "/valuation", rev), signal, openingResponse);
  if (!response.ok) throw new CompanyHttpError(response.status);
  const body = await response.json() as Partial<ValuationResponse>;
  return body.schemaVersion === "valuation-response.v1" && typeof body.availability === "string" ? body as ValuationResponse : null;
}
/** One stored version of the valuation report, by its id. */

/** One filing rail row's analysis, or null when the row has none and the filing digest stands for it. */
export async function fetchItemAnalysis(ticker: string, id: string, signal: AbortSignal): Promise<ItemAnalysis | null> {
  const response = await fetch(companyPath(ticker, `/items/${encodeURIComponent(id)}`), { signal });
  if (!response.ok) return null;
  const body = await response.json() as { status?: string; analysis?: ItemAnalysis | null };
  return body.status === "ready" && body.analysis ? body.analysis : null;
}

/** Insider trades by person, or null while the backend has none for the company (the page groups the rail's own filings instead). */
export async function fetchInsiders(ticker: string, signal: AbortSignal): Promise<InsidersPublication | null> {
  const response = await fetch(companyPath(ticker, "/insiders"), { signal });
  if (!response.ok) return null;
  const body = await response.json() as { status?: string; insiders?: InsidersPublication | null };
  return body.status === "ready" && body.insiders ? body.insiders : null;
}

/** One page of a person's Form 4 lines, newest first; `cursor` continues from the previous page. Null when the read failed. */
export async function fetchInsiderHistory(ticker: string, personKey: string, cursor: string | null, signal: AbortSignal): Promise<InsiderTransactionsPage | null> {
  // The figures are the filings' own, so the page is read without a locale; only the cursor keys it.
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const response = await fetch(`/api/business/v1/companies/${encodeURIComponent(ticker)}/insiders/${encodeURIComponent(personKey)}/transactions${query}`, { signal });
  if (!response.ok) return null;
  const body = await response.json() as { status?: string; transactions?: InsiderTransactionsPage | null };
  return body.status === "ready" && body.transactions ? body.transactions : null;
}

/** The drawable flow: the published pair plus the archived report quarters, or null while the statement is incomplete. */
export function publicationFlow(data: CompanyPublication, ticker: string): PublicBusinessFlow | null {
  if (data.status !== "ready" || !data.flow) return null;
  const quarters = [...new Map([...(data.reports?.quarters ?? []), ...data.flow.quarters].map(q => [q.periodEnd, q])).values()];
  return selectFlow({ ...data.flow, quarters }, null, ticker);
}
