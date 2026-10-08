import { selectFlow } from "@/lib/earning-report/web/business-flow-model";
import type { CompleteFlowPublication } from "@/shared/analysis-contract/complete-business-flow";
import type { PublicBusinessFlow } from "@/shared/analysis-contract/business-flow";
import type { BusinessExplainer } from "@/shared/analysis-contract/business-explainer";
import type { GuidancePublication } from "@/shared/analysis-contract/guidance";
import type { PublicCapitalStructure } from "@/shared/analysis-contract/capital-structure";
import type { FindingsPublication } from "@/shared/analysis-contract/findings";
import type { FindingFundamentals } from "@/shared/analysis-runtime/findings";
import { findingData, verifiedFindings, type VerifiedFinding } from "./findings-model";

export type CompanyPublication = CompleteFlowPublication & { explainer?: BusinessExplainer | null; guidance?: GuidancePublication | null };

const companyPath = (ticker: string, resource = "") => `/api/business/v1/companies/${encodeURIComponent(ticker)}${resource}`;

export async function fetchCompany(ticker: string, signal: AbortSignal): Promise<CompanyPublication> {
  const response = await fetch(companyPath(ticker), { signal });
  if (!response.ok) throw new Error("unavailable");
  return await response.json() as CompanyPublication;
}

/** A supplementary resource answers on its own; anything but "ready" reads as null. */
export async function fetchSupplement<T>(ticker: string, resource: "capital" | "findings" | "fundamentals", signal: AbortSignal): Promise<T | null> {
  const response = await fetch(companyPath(ticker, "/" + resource), { signal });
  if (!response.ok) return null;
  const body = await response.json() as { status?: string } & Record<string, unknown>;
  return body.status === "ready" ? body[resource] as T : null;
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
  const findings = await fetchSupplement<FindingsPublication>(ticker, "findings", signal);
  if (!findings?.findings.length) return null;
  const [company, capital, fundamentals] = await Promise.all([
    fetchCompany(ticker, signal),
    fetchSupplement<PublicCapitalStructure>(ticker, "capital", signal).catch(() => null),
    fetchSupplement<FindingFundamentals>(ticker, "fundamentals", signal).catch(() => null),
  ]);
  const flow = publicationFlow(company, ticker);
  if (!flow) return null;
  const verified = verifiedFindings(findings, findingData(flow, company.history ?? null, capital, fundamentals, company.guidance ?? null));
  return verified.length ? { ticker, periodEnd: findings.periodEnd, findings: verified, partial: company.outdated === true } : null;
}
