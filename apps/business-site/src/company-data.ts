import { selectFlow } from "@/packages/web/src/model/business-flow-model";
import type { CompleteFlowPublication } from "@/shared/analysis-contract/complete-business-flow";
import type { PublicBusinessFlow } from "@/shared/analysis-contract/business-flow";
import type { BusinessExplainer } from "@/shared/analysis-contract/business-explainer";
import type { BusinessTree } from "@/shared/analysis-contract/business-tree";
import type { GuidancePublication } from "@/shared/analysis-contract/guidance";
import type { PublicCapitalStructure } from "@/shared/analysis-contract/capital-structure";
import type { FindingPassage, FindingsPublication } from "@/shared/analysis-contract/findings";
import type { PeersPublication } from "@/shared/analysis-contract/peers";
import type { FindingFundamentals } from "@/shared/analysis-runtime/findings";
import type { MapRevisions } from "@/shared/analysis-contract/revisions";
import { getLocale } from "@/packages/web/src/i18n";
import { findingData, verifiedFindings, type VerifiedFinding } from "./findings-model";
import { assessStatements } from "@/shared/analysis-runtime/statement-analysis";
import type { Flag } from "@/shared/analysis-contract/statement-analysis";

export type CompanyPublication = CompleteFlowPublication & { explainer?: BusinessExplainer | null; guidance?: GuidancePublication | null; tree?: BusinessTree | null };

/**
 * In Chinese the API serves the generated prose translated where the pipeline has translated it; the rest stays English.
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

export async function fetchCompany(ticker: string, signal: AbortSignal, rev?: string): Promise<CompanyPublication> {
  const response = await fetch(companyPath(ticker, "", rev), { signal });
  if (!response.ok) throw new Error("unavailable");
  return await response.json() as CompanyPublication;
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

/** The drawable flow: the published pair plus the archived report quarters, or null while the statement is incomplete. */
export function publicationFlow(data: CompanyPublication, ticker: string): PublicBusinessFlow | null {
  if (data.status !== "ready" || !data.flow) return null;
  const quarters = [...new Map([...(data.reports?.quarters ?? []), ...data.flow.quarters].map(q => [q.periodEnd, q])).values()];
  return selectFlow({ ...data.flow, quarters }, null, ticker);
}

/** `partial`: verified against a fallback snapshot (no history), so findings may be missing that a fresh read would show. */
export type CompanyDigest = { ticker: string; periodEnd: string; findings: VerifiedFinding[]; partial: boolean; /** The three-statement checkup's flags at the newest quarter. */ flags: Flag[] };

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
  const data = findingData(flow, company.history ?? null, capital, fundamentals, company.guidance ?? null, bundle?.peers ?? null, bundle?.passages ?? null);
  const verified = verifiedFindings(findings, data);
  const newest = [...flow.quarters].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
  const flags = newest ? assessStatements(data, newest.periodEnd, getLocale()).flags : [];
  return verified.length ? { ticker, periodEnd: findings.periodEnd, findings: verified, partial: company.outdated === true, flags } : null;
}
