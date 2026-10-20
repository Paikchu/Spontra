import type { CheckupNotes, FindingMaterial, FindingsPublication } from "../../../../shared/analysis-contract/findings.ts";
import { D1SecRepository } from "../sec/d1.ts";

/** Where a company's checkup notes are kept (docs/three-statement-analysis-design.md). */
export const checkupCacheKey = (ticker: string) => `checkup:v1:${ticker}`;
/** The input of the last run that wrote nothing; the same input is not written again until it changes. */
export const emptyCheckupKey = (ticker: string) => `checkup:empty:v1:${ticker}`;

/** The stored record: the notes, the materials their quotes and sources rest on, the input it was written from, and the operator's trace. */
export type CheckupRecord = CheckupNotes & { ticker: string; fingerprint: string; materials: FindingMaterial[]; trace?: Array<{ metricId: string; issues: string[]; turns: unknown[] }> };

/**
 * The notes served with the findings: merged when written for the same report, their materials joining the findings'
 * so the read route re-serves the quoted passages. A record for another report is left out.
 */
export function mergeCheckup(findings: FindingsPublication, record: CheckupRecord | null): FindingsPublication {
  if (!record || record.periodEnd !== findings.periodEnd || !record.notes.length) return findings;
  const materials = new Map((findings.materials ?? []).map(m => [m.id, m]));
  for (const m of record.materials) materials.set(m.id, m);
  return { ...findings, materials: [...materials.values()], checkup: { periodEnd: record.periodEnd, generatedAt: record.generatedAt, model: record.model, notes: record.notes } };
}

export async function readCheckupRecord(db: D1Database, ticker: string): Promise<CheckupRecord | null> {
  const stored = await new D1SecRepository(db).getCache<CheckupRecord>(checkupCacheKey(ticker)).catch(() => null);
  const record = stored?.payload;
  return record && typeof record === "object" && Array.isArray(record.notes) && Array.isArray(record.materials) ? record : null;
}
