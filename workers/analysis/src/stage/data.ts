import type { FindingsPublication } from "../../../../shared/analysis-contract/findings.ts";
import type { MapRevisions } from "../../../../shared/analysis-contract/revisions.ts";
import { verifyFindings, type FindingData, type VerifiedFinding } from "../../../../shared/analysis-runtime/findings.ts";
import { requireDb } from "../core.ts";
import { findingPassages, readServedFindings } from "../findings/read.ts";
import { findingsInput } from "../findings/workflow.ts";
import type { Ledger } from "../findings/ledger.ts";
import { lensCatalogue, type LensCatalogueRow } from "../lens/agent.ts";
import type { AnalysisEnv } from "../operations.ts";
import { readRevisions } from "../pipeline/revisions.ts";

/**
 * What a stage turn reads, from the stored projections the findings writer reads (no SEC fetch, no model call): the
 * company's data, the ledger of every figure the report states, the served findings verified against that data, and
 * the resource revisions the page must hold to draw the same thing. Null when the company has no published report.
 */
export type StageData = {
  ticker: string;
  periodEnd: string;
  data: FindingData;
  ledger: Ledger;
  catalogue: LensCatalogueRow[];
  publication: FindingsPublication | null;
  findings: VerifiedFinding[];
  basis: MapRevisions;
};

export async function loadStageData(env: AnalysisEnv, ticker: string): Promise<StageData | null> {
  const db = requireDb(env);
  const [input, publication, basis] = await Promise.all([findingsInput(env, ticker), readServedFindings(db, ticker).catch(() => null), readRevisions(db, ticker).catch(() => ({}))]);
  if (!input) return null;
  const passages = publication ? await findingPassages(db, ticker, publication).catch(() => []) : [];
  const data: FindingData = { ...input.data, passages };
  const periodEnd = input.ledger.periodEnd;
  const findings = publication ? verifyFindings(publication, data).verified : [];
  return { ticker, periodEnd, data, ledger: input.ledger, catalogue: lensCatalogue(input.ledger, data, periodEnd), publication, findings, basis };
}
