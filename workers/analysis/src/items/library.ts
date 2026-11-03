import type { FindingPassage } from "../../../../shared/analysis-contract/findings.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { itemAnalysisKey, itemsIndexKey, type ItemsIndex, type StoredItem } from "./read.ts";

/**
 * Layer 2's filing analyses as the layers above read them (docs/spontra-architecture-upgrade.md, U3/U4): each filing's
 * written analysis and the verbatim passages it quoted, already checked against the filing's own text when it was
 * written. A reader above quotes these passages by their ids; it never opens the filing.
 */
export type FilingAnalysisEntry = { id: string; kind: string; form: string; filedAt: string; periodEnd: string; title: string };
export type FilingAnalysisRead = FilingAnalysisEntry & { judgment: string; passages: FindingPassage[] };

const entryOf = (stored: StoredItem): FilingAnalysisEntry => {
  const own = stored.passages.find(p => p.documentId) ?? stored.passages[0];
  return { id: stored.itemId, kind: stored.itemKind, form: own?.form ?? stored.itemKind, filedAt: own?.filedAt ?? stored.periodEnd, periodEnd: stored.periodEnd, title: stored.finding.title };
};

async function stored(db: D1Database, ticker: string, id: string): Promise<StoredItem | null> {
  const value = (await new D1SecRepository(db).getCache<StoredItem>(itemAnalysisKey(ticker, id)).catch(() => null))?.payload;
  return value?.schemaVersion === "item-analysis.v1" && value.ticker === ticker ? value : null;
}

/** The company's written filing analyses, newest report first. */
export async function listFilingAnalyses(db: D1Database, ticker: string, limit = 24): Promise<FilingAnalysisEntry[]> {
  const index = (await new D1SecRepository(db).getCache<ItemsIndex>(itemsIndexKey(ticker)).catch(() => null))?.payload;
  const rows = await Promise.all((index?.items ?? []).filter(i => i.written).map(i => stored(db, ticker, i.id)));
  return rows.filter((r): r is StoredItem => !!r).map(entryOf).sort((a, b) => b.periodEnd.localeCompare(a.periodEnd) || b.filedAt.localeCompare(a.filedAt)).slice(0, limit);
}

/** One filing analysis with the passages it quoted; null when none is written for that filing. */
export async function readFilingAnalysis(db: D1Database, ticker: string, id: string): Promise<FilingAnalysisRead | null> {
  const value = await stored(db, ticker, id);
  return value ? { ...entryOf(value), judgment: value.finding.judgment.text, passages: value.passages } : null;
}
