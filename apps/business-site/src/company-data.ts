import { selectFlow } from "@/packages/web/src/model/business-flow-model";
import type { CompleteFlowPublication } from "@/shared/analysis-contract/complete-business-flow";
import type { PublicBusinessFlow } from "@/shared/analysis-contract/business-flow";
import type { BusinessExplainer } from "@/shared/analysis-contract/business-explainer";
import type { BusinessTree } from "@/shared/analysis-contract/business-tree";
import type { GuidancePublication } from "@/shared/analysis-contract/guidance";
import type { PublicCapitalStructure } from "@/shared/analysis-contract/capital-structure";
import type { FindingPassage, FindingsPublication } from "@/shared/analysis-contract/findings";
import type { ItemAnalysis } from "@/shared/analysis-contract/item-analysis";
import type { PeersPublication } from "@/shared/analysis-contract/peers";
import type { EventsPublication } from "@/shared/analysis-contract/events";
import type { MapRevisions } from "@/shared/analysis-contract/revisions";
import { getLocale } from "@/packages/web/src/i18n";
import { rememberIssuer } from "@/shared/analysis-runtime/fiscal-label";

export type CompanyPublication = CompleteFlowPublication & { explainer?: BusinessExplainer | null; guidance?: GuidancePublication | null; tree?: BusinessTree | null };

/**
 * In Chinese the API serves the generated prose translated where Spontra Analysis has translated it; the rest stays English.
 * `rev` asks for the resource at its publication revision, so no cache answers with a copy older than it.
 */
const companyPath = (ticker: string, resource = "", rev?: string) => {
  const query = new URLSearchParams();
  if (getLocale() !== "en") query.set("lang", getLocale());
  if (rev) query.set("rev", rev);
  const search = query.toString();
  return `/api/business/v1/companies/${encodeURIComponent(ticker)}${resource}${search ? `?${search}` : ""}`;
};

/** The revision of each resource the page reads; null when the answer is unavailable. */
export async function fetchRevisions(ticker: string, signal: AbortSignal): Promise<MapRevisions | null> {
  const response = await fetch(`/api/business/v1/companies/${encodeURIComponent(ticker)}/revision`, { signal, cache: "no-store" });
  if (!response.ok) return null;
  const body = await response.json() as { revisions?: MapRevisions };
  return body.revisions && typeof body.revisions === "object" ? body.revisions : null;
}

/** A company read that answered with an HTTP status. `status` 0 is a network failure, which never got one. */
export class CompanyHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(String(status));
    this.name = "CompanyHttpError";
    this.status = status;
  }
}

export async function fetchCompany(ticker: string, signal: AbortSignal, rev?: string): Promise<CompanyPublication> {
  let response: Response;
  try {
    response = await fetch(companyPath(ticker, "", rev), { signal });
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
export async function fetchEvents(ticker: string, signal: AbortSignal, rev?: string): Promise<{ events: EventsPublication | null; error: boolean }> {
  try {
    const response = await fetch(companyPath(ticker, "/events", rev), { signal });
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (!response.ok) return { events: null, error: true };
    const body = await response.json() as { status?: string; events?: EventsPublication | null };
    return { events: body.status === "ready" && body.events ? body.events : null, error: false };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { events: null, error: true };
  }
}

/** A supplementary resource answers on its own; anything but "ready" reads as null. */
export async function fetchSupplement<T>(ticker: string, resource: "findings" | "fundamentals" | "events" | "filings", signal: AbortSignal, rev?: string): Promise<T | null> {
  const response = await fetch(companyPath(ticker, "/" + resource, rev), { signal });
  if (!response.ok) return null;
  const body = await response.json() as { status?: string } & Record<string, unknown>;
  return body.status === "ready" ? body[resource] as T : null;
}

/** The capital structure with the company's comparable peers, as the site serves them together. */
export async function fetchCapital(ticker: string, signal: AbortSignal, rev?: string): Promise<{ capital: PublicCapitalStructure; peers: PeersPublication | null } | null> {
  const response = await fetch(companyPath(ticker, "/capital", rev), { signal });
  if (!response.ok) return null;
  const body = await response.json() as { status?: string; capital?: PublicCapitalStructure | null; peers?: PeersPublication | null };
  return body.status === "ready" && body.capital ? { capital: body.capital, peers: body.peers ?? null } : null;
}

/** The findings with the passages their quotes rest on and the peers projection, as the site serves them together. */
export type FindingsBundle = { findings: FindingsPublication; passages: FindingPassage[]; peers: PeersPublication | null };
export async function fetchFindings(ticker: string, signal: AbortSignal, rev?: string): Promise<FindingsBundle | null> {
  const response = await fetch(companyPath(ticker, "/findings", rev), { signal });
  if (!response.ok) return null;
  const body = await response.json() as { status?: string; findings?: FindingsPublication | null; passages?: FindingPassage[]; peers?: PeersPublication | null };
  return body.status === "ready" && body.findings ? { findings: body.findings, passages: body.passages ?? [], peers: body.peers ?? null } : null;
}

/** One filing rail row's analysis, or null when the row has none and the filing digest stands for it. */
export async function fetchItemAnalysis(ticker: string, id: string, signal: AbortSignal): Promise<ItemAnalysis | null> {
  const response = await fetch(companyPath(ticker, `/items/${encodeURIComponent(id)}`), { signal });
  if (!response.ok) return null;
  const body = await response.json() as { status?: string; analysis?: ItemAnalysis | null };
  return body.status === "ready" && body.analysis ? body.analysis : null;
}

/** The drawable flow: the published pair plus the archived report quarters, or null while the statement is incomplete. */
export function publicationFlow(data: CompanyPublication, ticker: string): PublicBusinessFlow | null {
  if (data.status !== "ready" || !data.flow) return null;
  const quarters = [...new Map([...(data.reports?.quarters ?? []), ...data.flow.quarters].map(q => [q.periodEnd, q])).values()];
  return selectFlow({ ...data.flow, quarters }, null, ticker);
}
