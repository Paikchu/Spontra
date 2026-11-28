import type { FindingsPublication } from "../../../../shared/analysis-contract/findings.ts";
import type { MapRevisions } from "../../../../shared/analysis-contract/revisions.ts";
import type { FindingData, VerifiedFinding } from "../../../../shared/analysis-runtime/findings.ts";
import { requireDb } from "../core.ts";
import { readPeriodExtract } from "../extract/period-extract.ts";
import type { Ledger } from "../extract/ledger.ts";
import { seriesCatalogue, type CatalogueRow } from "./catalogue.ts";
import type { AnalysisEnv } from "../operations.ts";
import { readRevisions } from "../pipeline/revisions.ts";

/**
 * What a stage turn reads, from layer 2's per-period extract (no SEC fetch, no model call): the
 * company's data, the ledger of every figure the report states, and the resource revisions the page must hold to draw the same thing.
 * Null when the company has no published report.
 */
export type StageData = {
  ticker: string;
  periodEnd: string;
  data: FindingData;
  ledger: Ledger;
  catalogue: CatalogueRow[];
  publication: FindingsPublication | null;
  findings: VerifiedFinding[];
  basis: MapRevisions;
};

export async function loadStageData(env: AnalysisEnv, ticker: string, _options: { findings?: boolean } = {}): Promise<StageData | null> {
  const db = requireDb(env);
  const [input, basis] = await Promise.all([
    readPeriodExtract(db, ticker),
    readRevisions(db, ticker).catch(() => ({})),
  ]);
  if (!input) return null;
  const data: FindingData = { ...input.data, passages: [] };
  const periodEnd = input.ledger.periodEnd;
  return { ticker, periodEnd, data, ledger: input.ledger, catalogue: seriesCatalogue(input.ledger, data, periodEnd), publication: null, findings: [], basis };
}
