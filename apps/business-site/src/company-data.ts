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
import type { FindingFundamentals } from "@/shared/analysis-runtime/findings";
import type { MapRevisions } from "@/shared/analysis-contract/revisions";
import type { ValuationEvidence, ValuationPublication, ValuationResponse } from "@/shared/analysis-contract/valuation";
import { getLocale } from "@/packages/web/src/i18n";
import { findingData, verifiedFindings, type VerifiedFinding } from "./findings-model";

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
  return await response.json() as CompanyPublication;
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

/** The valuation assessment in every state it answers with (hidden, preparing, ready, insufficient, failed); null only when the read failed. */
export async function fetchValuation(ticker: string, signal: AbortSignal, rev?: string): Promise<ValuationResponse | null> {
  const response = await fetch(companyPath(ticker, "/valuation", rev), { signal });
  if (!response.ok) return null;
  const body = await response.json() as Partial<ValuationResponse>;
  return body.schemaVersion === "valuation-response.v1" && typeof body.availability === "string" ? body as ValuationResponse : null;
}
/** One stored version of the valuation report, by its id. */
export async function fetchValuationVersion(ticker: string, versionId: string, signal: AbortSignal): Promise<ValuationPublication | null> {
  const response = await fetch(companyPath(ticker, `/valuation/versions/${encodeURIComponent(versionId)}`), { signal });
  if (!response.ok) return null;
  const body = await response.json() as { report?: ValuationPublication | null };
  return body.report ?? null;
}
/** The snapshot of one source a version cites, as it was read when the report was written. */
export async function fetchValuationEvidence(ticker: string, versionId: string, evidenceId: string, signal: AbortSignal): Promise<ValuationEvidence | null> {
  const response = await fetch(companyPath(ticker, `/valuation/versions/${encodeURIComponent(versionId)}/evidence/${encodeURIComponent(evidenceId)}`), { signal });
  if (!response.ok) return null;
  const body = await response.json() as { evidence?: ValuationEvidence | null };
  return body.evidence ?? null;
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

/** `partial`: verified against a fallback snapshot (no history), so findings may be missing that a fresh read would show. */
export type CompanyDigest = { ticker: string; periodEnd: string; findings: VerifiedFinding[]; partial: boolean };

/**
 * A company's findings as its page would show them: verified against the same flow, history, capital,
 * fundamentals and guidance, so the home page never lists a finding the company page withholds.
 * The statement is only read once the company has published findings.
 */
export async function loadDigest(ticker: string, signal: AbortSignal): Promise<CompanyDigest | null> {
  const bundle = await fetchFindings(ticker, signal);
  const findings = bundle?.findings ?? null;
  if (!findings?.findings.length) return null;
  const [company, capital, fundamentals] = await Promise.all([
    fetchCompany(ticker, signal),
    fetchCapital(ticker, signal).then(r => r?.capital ?? null).catch(() => null),
    fetchSupplement<FindingFundamentals>(ticker, "fundamentals", signal).catch(() => null),
  ]);
  const flow = publicationFlow(company, ticker);
  if (!flow) return null;
  const verified = verifiedFindings(findings, findingData(flow, company.history ?? null, capital, fundamentals, company.guidance ?? null, bundle?.peers ?? null, bundle?.passages ?? null));
  return verified.length ? { ticker, periodEnd: findings.periodEnd, findings: verified, partial: company.outdated === true } : null;
}
