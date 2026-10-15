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
import { getLocale } from "@/packages/web/src/i18n";
import { findingData, verifiedFindings, type VerifiedFinding } from "./findings-model";

export type CompanyPublication = CompleteFlowPublication & { explainer?: BusinessExplainer | null; guidance?: GuidancePublication | null; tree?: BusinessTree | null };

/** In Chinese the API serves the generated prose translated where the pipeline has translated it; the rest stays English. */
const companyPath = (ticker: string, resource = "") => `/api/business/v1/companies/${encodeURIComponent(ticker)}${resource}${getLocale() === "en" ? "" : `?lang=${getLocale()}`}`;

export async function fetchCompany(ticker: string, signal: AbortSignal): Promise<CompanyPublication> {
  const response = await fetch(companyPath(ticker), { signal });
  if (!response.ok) throw new Error("unavailable");
  return await response.json() as CompanyPublication;
}

/** A supplementary resource answers on its own; anything but "ready" reads as null. */
export async function fetchSupplement<T>(ticker: string, resource: "capital" | "findings" | "fundamentals" | "events" | "filings", signal: AbortSignal): Promise<T | null> {
  const response = await fetch(companyPath(ticker, "/" + resource), { signal });
  if (!response.ok) return null;
  const body = await response.json() as { status?: string } & Record<string, unknown>;
  return body.status === "ready" ? body[resource] as T : null;
}

/** The findings with the passages their quotes rest on and the peers projection, as the site serves them together. */
export type FindingsBundle = { findings: FindingsPublication; passages: FindingPassage[]; peers: PeersPublication | null };
export async function fetchFindings(ticker: string, signal: AbortSignal): Promise<FindingsBundle | null> {
  const response = await fetch(companyPath(ticker, "/findings"), { signal });
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
    fetchSupplement<PublicCapitalStructure>(ticker, "capital", signal).catch(() => null),
    fetchSupplement<FindingFundamentals>(ticker, "fundamentals", signal).catch(() => null),
  ]);
  const flow = publicationFlow(company, ticker);
  if (!flow) return null;
  const verified = verifiedFindings(findings, findingData(flow, company.history ?? null, capital, fundamentals, company.guidance ?? null, bundle?.peers ?? null, bundle?.passages ?? null));
  return verified.length ? { ticker, periodEnd: findings.periodEnd, findings: verified, partial: company.outdated === true } : null;
}
