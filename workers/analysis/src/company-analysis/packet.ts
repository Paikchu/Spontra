import type { CompanyMemoryItem } from "../sec/analysis.ts";
import { D1FundamentalsRepository, type FundamentalCurrentObservation } from "../fundamentals/fundamentals-d1.ts";
import { normalizeTrackedTicker } from "../sec/config.ts";
import { buildCompanyFeaturePack, type CompanyFeaturePack } from "./feature-engine.ts";
import type { CompanyAnalysisD1Database } from "./repository.ts";

export type CompanyAnalysisPacketStage = "current_quarter" | "cross_period";

export type CompanyAnalysisPacket = {
  ticker: string;
  periodId: string;
  reportDate: string;
  targetPeriodEnd: string | null;
  memoryVersion: number;
  fundamentalsDataVersion: string | null;
  ready: boolean;
  reason: string | null;
  features: CompanyFeaturePack | null;
  currentMemory: CompanyMemoryItem[];
  historicalMemory: CompanyMemoryItem[];
  priorConclusion: { analysisId: string; headline: string; generatedAt: string } | null;
};

type MemoryRow = {
  memoryId: string;
  ticker: string;
  kind: "fact" | "judgment";
  topicKey: string;
  statement: string;
  status: CompanyMemoryItem["status"];
  materialityScore: number;
  confidence: CompanyMemoryItem["confidence"];
  evidenceIds: string;
  firstSeenPeriod: string;
  lastConfirmedPeriod: string;
  horizon: string | null;
  nextTest: string | null;
  falsifier: string | null;
  duePeriod: string | null;
  sourceJobIds: string;
};

export async function buildCompanyAnalysisPacket(input: {
  database: CompanyAnalysisD1Database;
  rawTicker: string;
  periodId: string;
  memoryVersion: number;
  stage: CompanyAnalysisPacketStage;
}): Promise<CompanyAnalysisPacket> {
  const ticker = normalizeTrackedTicker(input.rawTicker);
  if (!ticker || !input.periodId || !Number.isInteger(input.memoryVersion)) {
    throw new Error("Company analysis packet identity is invalid.");
  }
  const thread = await input.database.prepare(`
    SELECT version FROM sec_company_memory_threads WHERE ticker = ? LIMIT 1
  `).bind(ticker).first<{ version: number }>();
  if (!thread || thread.version !== input.memoryVersion) {
    throw new Error("Company Memory version changed before packet freeze.");
  }
  const period = await input.database.prepare(`
    SELECT end_date AS reportDate FROM sec_periods WHERE period_id = ? AND ticker = ? LIMIT 1
  `).bind(input.periodId, ticker).first<{ reportDate: string }>();
  if (!period?.reportDate) throw new Error("Company analysis period is unavailable.");

  const fundamentals = await new D1FundamentalsRepository(input.database).getLastGoodSnapshot(ticker);
  const quarterly = fundamentals?.observations.filter((item) => item.periodType === "3M") ?? [];
  const targetPeriodEnd = resolveTargetPeriodEnd(quarterly, period.reportDate);
  const observations = targetPeriodEnd ? lastTwelveQuarters(quarterly, targetPeriodEnd) : [];
  const features = targetPeriodEnd ? buildCompanyFeaturePack({
    source: "yahoo_finance",
    ticker,
    targetPeriodEnd,
    observations,
  }) : null;

  const rows = await input.database.prepare(`
    SELECT memory_id AS memoryId, ticker, kind, topic_key AS topicKey, statement,
      status, materiality_score AS materialityScore, confidence,
      evidence_ids AS evidenceIds, first_seen_period AS firstSeenPeriod,
      last_confirmed_period AS lastConfirmedPeriod, horizon,
      next_test AS nextTest, falsifier, due_period AS duePeriod,
      source_job_ids AS sourceJobIds
    FROM sec_memory_items
    WHERE ticker = ? AND status NOT IN ('rejected', 'superseded')
    ORDER BY materiality_score DESC, updated_at DESC
    LIMIT 80
  `).bind(ticker).all<MemoryRow>();
  const memories = rows.results.map(memoryFromRow);
  const currentMemory = memories.filter((item) => item.lastConfirmedPeriod === input.periodId);
  const historicalMemory = input.stage === "cross_period"
    ? memories.filter((item) => item.lastConfirmedPeriod !== input.periodId)
    : [];
  const prior = input.stage === "cross_period" ? await input.database.prepare(`
    SELECT analysis_id AS analysisId, overview_json AS overviewJson, generated_at AS generatedAt
    FROM company_analysis_runs
    WHERE ticker = ? AND status = 'ready' AND period_id <> ?
    ORDER BY generated_at DESC LIMIT 1
  `).bind(ticker, input.periodId).first<{ analysisId: string; overviewJson: string; generatedAt: string }>() : null;
  const priorOverview = parseRecord(prior?.overviewJson);
  const priorConclusion = prior && typeof priorOverview?.headline === "string"
    ? { analysisId: prior.analysisId, headline: priorOverview.headline, generatedAt: prior.generatedAt }
    : null;
  return {
    ticker,
    periodId: input.periodId,
    reportDate: period.reportDate,
    targetPeriodEnd,
    memoryVersion: input.memoryVersion,
    fundamentalsDataVersion: fundamentals?.payloadHash ?? null,
    ready: Boolean(features),
    reason: features ? null : "yahoo_target_period_missing",
    features,
    currentMemory,
    historicalMemory,
    priorConclusion,
  };
}

export function resolveTargetPeriodEnd(observations: FundamentalCurrentObservation[], reportDate: string): string | null {
  const reportTime = Date.parse(`${reportDate}T00:00:00Z`);
  if (!Number.isFinite(reportTime)) return null;
  const maximumDrift = 7 * 24 * 60 * 60 * 1_000;
  const candidates = observations
    .filter((item) => item.metricKey === "total_revenue" && item.periodType === "3M")
    .map((item) => ({
      periodEnd: item.periodEnd,
      drift: Math.abs(Date.parse(`${item.periodEnd}T00:00:00Z`) - reportTime),
    }))
    .filter((item) => Number.isFinite(item.drift) && item.drift <= maximumDrift)
    .sort((left, right) => left.drift - right.drift || right.periodEnd.localeCompare(left.periodEnd));
  return candidates[0]?.periodEnd ?? null;
}

function lastTwelveQuarters(observations: FundamentalCurrentObservation[], targetPeriodEnd: string): FundamentalCurrentObservation[] {
  const periods = [...new Set(observations.map((item) => item.periodEnd))]
    .filter((periodEnd) => periodEnd <= targetPeriodEnd)
    .sort()
    .slice(-12);
  const allowed = new Set(periods);
  return observations.filter((item) => allowed.has(item.periodEnd));
}

function memoryFromRow(row: MemoryRow): CompanyMemoryItem {
  return {
    memoryId: row.memoryId,
    ticker: row.ticker,
    kind: row.kind,
    topicKey: row.topicKey,
    statement: row.statement,
    status: row.status,
    materialityScore: row.materialityScore,
    confidence: row.confidence,
    evidenceIds: parseStrings(row.evidenceIds),
    firstSeenPeriod: row.firstSeenPeriod,
    lastConfirmedPeriod: row.lastConfirmedPeriod,
    horizon: row.horizon ?? undefined,
    nextTest: row.nextTest ?? undefined,
    falsifier: row.falsifier ?? undefined,
    duePeriod: row.duePeriod ?? undefined,
    sourceJobIds: parseStrings(row.sourceJobIds),
  };
}

function parseStrings(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseRecord(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
