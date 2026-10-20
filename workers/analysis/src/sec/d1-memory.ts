import type { CompanyMemoryItem } from "./analysis.ts";
import { buildCompanyMemorySummary, consolidateMemoryCandidates, type MemoryCandidateV2 } from "./memory.ts";
import { parseJson, type D1Like, type D1ResultStatement } from "./d1-support.ts";

export type SecMemoryJobClaim = {
  jobId: string;
  ticker: string;
  filingId: string;
  periodId: string;
  sourceR2Key: string;
  ownerToken: string;
  leaseUntil: string;
};

export type SecMemoryExtractionPayload = {
  candidates: MemoryCandidateV2[];
};

export type SecMemoryCommitResult = {
  noOp: boolean;
  itemCount: number;
  memoryVersion: number;
};

export class SecMemoryRepository {
  private readonly database: D1Like;

  constructor(database: D1Like) { this.database = database; }

  async claimMemoryJob(jobId: string | null, ownerToken: string, now: Date, leaseMilliseconds = 5 * 60_000, allowedTickers?: string[]): Promise<SecMemoryJobClaim | null> {
    if (!this.database.batch) throw new Error("D1 batch is required for memory lease claims");
    if (allowedTickers && !allowedTickers.length) return null;
    const tickerClause = allowedTickers ? ` AND ticker IN (${allowedTickers.map(() => "?").join(",")})` : "";
    const tickerValues = allowedTickers ?? [];
    const candidate = jobId
      ? await this.database.prepare(`
        SELECT job_id AS jobId, ticker, filing_id AS filingId, period_id AS periodId, source_r2_key AS sourceR2Key, status
        FROM sec_memory_jobs WHERE job_id = ?${tickerClause}
      `).bind(jobId, ...tickerValues).first<{ jobId: string; ticker: string; filingId: string; periodId: string; sourceR2Key: string; status: string }>()
      : await this.database.prepare(`
        SELECT job_id AS jobId, ticker, filing_id AS filingId, period_id AS periodId, source_r2_key AS sourceR2Key, status
        FROM sec_memory_jobs
        WHERE (status = 'pending' OR (status = 'running' AND lease_until < ?))${tickerClause}
        ORDER BY created_at ASC LIMIT 1
      `).bind(now.toISOString(), ...tickerValues).first<{ jobId: string; ticker: string; filingId: string; periodId: string; sourceR2Key: string; status: string }>();
    if (!candidate || candidate.status === "complete") return null;
    const leaseUntil = new Date(now.getTime() + leaseMilliseconds).toISOString();
    await this.database.batch([
      this.database.prepare(`
        INSERT INTO sec_company_memory_threads (ticker, summary, version, lease_owner, lease_until, updated_at)
        VALUES (?, '', 0, ?, ?, ?)
        ON CONFLICT(ticker) DO UPDATE SET lease_owner = excluded.lease_owner, lease_until = excluded.lease_until, updated_at = excluded.updated_at
        WHERE sec_company_memory_threads.lease_until IS NULL OR sec_company_memory_threads.lease_until < ? OR sec_company_memory_threads.lease_owner = ?
      `).bind(candidate.ticker, ownerToken, leaseUntil, now.toISOString(), now.toISOString(), ownerToken),
      this.database.prepare(`
        UPDATE sec_memory_jobs
        SET status = 'running', owner_token = ?, lease_until = ?, attempt = attempt + 1, updated_at = ?
        WHERE job_id = ?
          AND (status = 'pending' OR lease_until < ? OR owner_token = ?)
          AND EXISTS (
            SELECT 1 FROM sec_company_memory_threads
            WHERE ticker = ? AND lease_owner = ? AND lease_until = ?
          )
      `).bind(ownerToken, leaseUntil, now.toISOString(), candidate.jobId, now.toISOString(), ownerToken, candidate.ticker, ownerToken, leaseUntil),
    ]);
    const claimed = await this.database.prepare(`
      SELECT j.job_id AS jobId, j.ticker, j.filing_id AS filingId, j.period_id AS periodId,
        j.source_r2_key AS sourceR2Key, j.owner_token AS ownerToken, j.lease_until AS leaseUntil
      FROM sec_memory_jobs j
      JOIN sec_company_memory_threads t ON t.ticker = j.ticker
      WHERE j.job_id = ? AND j.owner_token = ? AND t.lease_owner = ?
    `).bind(candidate.jobId, ownerToken, ownerToken).first<SecMemoryJobClaim>();
    return claimed ?? null;
  }

  async commitMemoryJob(claim: SecMemoryJobClaim, extraction: SecMemoryExtractionPayload): Promise<SecMemoryCommitResult> {
    if (!this.database.batch) throw new Error("D1 batch is required for memory commit");
    const ownership = await this.database.prepare(`
      SELECT j.status, j.owner_token AS ownerToken, t.lease_owner AS threadOwner,
        t.version AS memoryVersion
      FROM sec_memory_jobs j
      JOIN sec_company_memory_threads t ON t.ticker = j.ticker
      WHERE j.job_id = ?
    `).bind(claim.jobId).first<{
      status: string;
      ownerToken: string | null;
      threadOwner: string | null;
      memoryVersion: number;
    }>();
    if (ownership?.status === "complete") return {
      noOp: true,
      itemCount: 0,
      memoryVersion: ownership.memoryVersion,
    };
    if (!ownership || ownership.ownerToken !== claim.ownerToken || ownership.threadOwner !== claim.ownerToken) throw new Error("Memory lease ownership changed");
    const rows = await this.database.prepare(`
      SELECT memory_id AS memoryId, ticker, kind, topic_key AS topicKey, statement, status,
        materiality_score AS materialityScore, confidence, evidence_ids AS evidenceIds,
        first_seen_period AS firstSeenPeriod, last_confirmed_period AS lastConfirmedPeriod,
        horizon, next_test AS nextTest, falsifier, due_period AS duePeriod, source_job_ids AS sourceJobIds
      FROM sec_memory_items WHERE ticker = ?
    `).bind(claim.ticker).all<{
      memoryId: string; ticker: string; kind: "fact" | "judgment"; topicKey: string; statement: string; status: CompanyMemoryItem["status"];
      materialityScore: number; confidence: CompanyMemoryItem["confidence"]; evidenceIds: string; firstSeenPeriod: string; lastConfirmedPeriod: string;
      horizon: string | null; nextTest: string | null; falsifier: string | null; duePeriod: string | null; sourceJobIds: string;
    }>();
    const currentItems: CompanyMemoryItem[] = rows.results.map((row) => ({
      ...row,
      evidenceIds: parseJson<string[]>(row.evidenceIds) ?? [],
      sourceJobIds: parseJson<string[]>(row.sourceJobIds) ?? [],
      horizon: row.horizon ?? undefined,
      nextTest: row.nextTest ?? undefined,
      falsifier: row.falsifier ?? undefined,
      duePeriod: row.duePeriod ?? undefined,
    }));
    const consolidated = consolidateMemoryCandidates({ ticker: claim.ticker, periodId: claim.periodId, items: currentItems }, extraction.candidates, claim.jobId);
    const now = new Date().toISOString();
    const ownershipGuard = `
      SELECT 1
      FROM sec_memory_jobs j
      JOIN sec_company_memory_threads t ON t.ticker = j.ticker
      WHERE j.job_id = ? AND j.status = 'running' AND j.owner_token = ? AND t.lease_owner = ?
    `;
    const statements: D1ResultStatement[] = [];
    for (const item of consolidated.items) statements.push(this.database.prepare(`
      INSERT INTO sec_memory_items (
        memory_id, ticker, module_key, topic_key, memory_type, statement, normalized_value,
        first_seen_period, last_confirmed_period, expected_resolution_period, status,
        materiality_score, confidence, evidence_ids, kind, horizon, next_test, falsifier,
        due_period, source_job_ids, normalized_key, version, updated_at
      ) SELECT ?, ?, 'cross_module', ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?
      WHERE EXISTS (${ownershipGuard})
      ON CONFLICT(memory_id) DO UPDATE SET
        statement = excluded.statement, last_confirmed_period = excluded.last_confirmed_period,
        status = excluded.status, materiality_score = excluded.materiality_score,
        confidence = excluded.confidence, evidence_ids = excluded.evidence_ids,
        kind = excluded.kind, horizon = excluded.horizon, next_test = excluded.next_test,
        falsifier = excluded.falsifier, due_period = excluded.due_period,
        source_job_ids = excluded.source_job_ids, normalized_key = excluded.normalized_key,
        version = sec_memory_items.version + 1, updated_at = excluded.updated_at
      WHERE EXISTS (${ownershipGuard})
    `).bind(
      item.memoryId, item.ticker, item.topicKey, item.kind, item.statement,
      item.firstSeenPeriod, item.lastConfirmedPeriod, item.horizon ?? null, item.status,
      item.materialityScore, item.confidence, JSON.stringify(item.evidenceIds), item.kind,
      item.horizon ?? null, item.nextTest ?? null, item.falsifier ?? null, item.duePeriod ?? null,
      JSON.stringify(item.sourceJobIds ?? []), `${item.kind}:${item.topicKey.toLowerCase()}`, now,
      claim.jobId, claim.ownerToken, claim.ownerToken,
      claim.jobId, claim.ownerToken, claim.ownerToken,
    ));
    const summary = buildCompanyMemorySummary(consolidated.items);
    statements.push(this.database.prepare(`
      UPDATE sec_company_memory_threads
      SET summary = ?, version = version + 1, lease_owner = NULL, lease_until = NULL, updated_at = ?
      WHERE ticker = ? AND lease_owner = ?
    `).bind(summary, now, claim.ticker, claim.ownerToken));
    statements.push(this.database.prepare(`
      UPDATE sec_memory_jobs
      SET status = 'complete', completed_at = ?, updated_at = ?, lease_until = NULL, error = NULL
      WHERE job_id = ? AND owner_token = ?
        AND EXISTS (SELECT 1 FROM sec_company_memory_threads WHERE ticker = ? AND lease_owner IS NULL)
    `).bind(now, now, claim.jobId, claim.ownerToken, claim.ticker));
    await this.database.batch(statements);
    const completion = await this.database.prepare(`
      SELECT j.status, j.owner_token AS ownerToken, t.version AS memoryVersion
      FROM sec_memory_jobs j
      JOIN sec_company_memory_threads t ON t.ticker = j.ticker
      WHERE j.job_id = ?
    `).bind(claim.jobId).first<{
      status: string;
      ownerToken: string | null;
      memoryVersion: number;
    }>();
    if (completion?.status !== "complete") throw new Error("Memory lease ownership changed before commit");
    return {
      noOp: consolidated.noOp,
      itemCount: consolidated.items.length,
      memoryVersion: completion.memoryVersion,
    };
  }

}
