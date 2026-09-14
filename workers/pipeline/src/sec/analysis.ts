import type { SecPresentation, SecSourceMaterial } from "../../../../shared/analysis-contract/sec-presentation.ts";
export const SEC_ANALYSIS_SCHEMA_VERSION = "sec-analysis.v3";
export const SEC_ANALYSIS_PROMPT_VERSION = "sec-analysis-prompt.v5-disclosures";
// One round, matching what the Manager Review prompt tells the model it gets. Raising this without
// also rewriting that prompt makes the Manager hoard every repairTask into the first round.
export const MAX_REPAIR_ROUNDS = 1;
export const MAX_REPAIR_NODES_PER_ROUND = 3;

export const SEC_CANONICAL_SERIES_IDS = [
  "revenue",
  "gross_profit",
  "gross_margin",
  "operating_income",
  "operating_margin",
  "net_income",
  "diluted_eps",
  "operating_cash_flow",
  "capex",
  "free_cash_flow",
  "cash",
  "debt",
  "shares",
] as const;

export type SecCanonicalSeriesId = typeof SEC_CANONICAL_SERIES_IDS[number];

export type HistoricalObservation = {
  observationId: string;
  seriesId: SecCanonicalSeriesId;
  metricKey: string;
  value: string;
  unit: string;
  currency?: string;
  basis: "gaap" | "derived";
  periodScope: "quarter" | "annual";
  startDate?: string;
  endDate: string;
  sourceAccession: string;
  sourceFiledAt: string;
  sourceVersion: string;
  qualityStatus: "validated_xbrl";
  xbrlConcept?: string;
  derivationFormula?: string;
};

export type SecHistorySeries = {
  seriesId: SecCanonicalSeriesId;
  quarters: HistoricalObservation[];
  annual: HistoricalObservation[];
};

export type SecHistorySnapshot = {
  registryVersion: string;
  series: SecHistorySeries[];
};

export type CompanyMemoryStatus = "provisional" | "active" | "stale" | "resolved" | "contradicted" | "superseded" | "rejected";

export type CompanyMemoryItem = {
  memoryId: string;
  ticker: string;
  kind: "fact" | "judgment";
  topicKey: string;
  statement: string;
  status: CompanyMemoryStatus;
  materialityScore: number;
  confidence: "high" | "medium" | "low";
  evidenceIds: string[];
  firstSeenPeriod: string;
  lastConfirmedPeriod: string;
  horizon?: string;
  nextTest?: string;
  falsifier?: string;
  duePeriod?: string;
  sourceJobIds?: string[];
};

export type SecAnalysisBrief = {
  reportContinuity?: import("./continuity.ts").ReportContinuity;
  version: "sec-analysis-brief.v2";
  ticker: string;
  filingId: string;
  periodId: string;
  periodScope: "quarter" | "annual";
  currentFacts: AnalysisFact[];
  history: SecHistorySnapshot;
  comparisons: Array<{
    seriesId: SecCanonicalSeriesId;
    comparisonType: "qoq" | "yoy";
    currentValue: string;
    priorValue: string;
    percentageDelta?: string;
    /** Set for ratio-unit series only, as the fraction the ratio moved. See `pointDelta`. */
    percentagePointDelta?: string;
    unit: string;
    currency?: string;
    basis: string;
    currentEndDate: string;
    priorEndDate: string;
  }>;
  companyMemorySummary: string;
  memoryItems: CompanyMemoryItem[];
  allowedMetricKeys: SecCanonicalSeriesId[];
  missingSeriesIds: SecCanonicalSeriesId[];
};

export type SecNodeSpecV2 = {
  id: string;
  title: string;
  question: string;
  sectionIds: string[];
  keywords?: string[];
  historySeriesIds: SecCanonicalSeriesId[];
  memoryIds: string[];
  acceptanceCriteria: string[];
  materiality: "high" | "medium" | "low";
};

export type ManagerQuestionStatus = "answered" | "partial" | "unanswered" | "not_disclosed";

export type ManagerRepairTask = SecNodeSpecV2 & {
  questionId: string;
  targetNodeId: string;
  missingEvidence: string[];
};

export type ManagerReview = {
  status: "complete" | "needs_repair" | "partial";
  questions: Array<{ questionId: string; status: ManagerQuestionStatus; explanation: string }>;
  repairTasks: ManagerRepairTask[];
  unresolvedQuestions: string[];
  coverageScore: number;
  stopReason: "complete" | "max_rounds" | "no_progress" | "analysis_incomplete" | null;
};

export type SecComparisonType = "qoq" | "yoy" | "guidance_revision" | "disclosure_change";

export function buildPeriodIdentity(ticker: string, form: string, reportDate: string): { periodId: string; periodScope: "quarter" | "annual" } {
  const periodScope = form.startsWith("10-K") || form.startsWith("20-F") ? "annual" : "quarter";
  return {
    periodId: `${ticker}:${reportDate}:${periodScope}`,
    periodScope,
  };
}

export type FilingBlock = {
  blockId: string;
  ordinal: number;
  /** Character span in the cleaned filing text, used to map blocks onto outline sections. */
  start: number;
  end: number;
  heading: string;
  headingPath: string;
  elementType: "heading_and_text" | "text" | "table_like";
  preview: string;
  body: string;
  tokenCount: number;
  numericDensity: number;
  tableCount: number;
  contentHash: string;
  /** Where the block came from: the filing body itself or an attached exhibit document. */
  source?: "body" | "exhibit";
  /** SEC submission TYPE of the originating document, e.g. "8-K" or "EX-99.1". */
  exhibitType?: string;
};

export type AnalysisFact = {
  factId?: string;
  metricKey: string;
  value: string;
  unit: string;
  currency?: string;
  periodScope?: string;
  basis: "gaap" | "non_gaap" | "management_kpi" | "derived" | "unknown";
  evidenceIds: string[];
  confidence: "high" | "medium" | "low";
  sourceLabel: "fact_source_reported" | "management_adjusted" | "derived_calculation" | "unknown";
  definitionHash?: string;
};

export type AnalysisClaim = {
  claimId?: string;
  topicKey: string;
  claimType: "driver" | "guidance" | "risk" | "one_off" | "accounting" | "commitment" | "tone";
  statement: string;
  direction: "positive" | "negative" | "mixed" | "neutral" | "unknown";
  horizon: "current" | "next_period" | "longer_term" | "unknown";
  materialityScore: number;
  confidence: "high" | "medium" | "low";
  evidenceIds: string[];
  targetPeriodId?: string;
};

export type MemoryCandidate = AnalysisClaim & {
  memoryType: "guidance" | "risk" | "commitment" | "definition" | "driver" | "one_off";
  firstSeenPeriod?: string;
  expectedResolutionPeriod?: string;
};

export type ComparisonResult = {
  comparisonType: SecComparisonType;
  currentPeriodId: string;
  priorPeriodId: string;
  comparability: "full" | "partial" | "not_comparable";
  metricDeltas: Array<{
    metricKey: string;
    currentValue: string;
    priorValue: string;
    absoluteDelta?: string;
    percentageDelta?: string;
    /** Set for ratio-unit series only, as the fraction the ratio moved. See `pointDelta`. */
    percentagePointDelta?: string;
    reason?: string;
  }>;
  narrativeDeltas: Array<{
    topicKey: string;
    changeType: "introduced" | "reaffirmed" | "strengthened" | "weakened" | "withdrawn" | "resolved" | "not_mentioned";
    currentStatement?: string;
    priorStatement?: string;
    evidenceIds: string[];
    materialityScore: number;
  }>;
};

export type PublishedSecReport = {
  fiscalPeriod?: import("../../../../shared/analysis-contract/report.ts").SecFiscalPeriod | null;
  discovery?: import("../../../../shared/analysis-contract/report.ts").SecDiscovery;
  publication?: { filing: import("./sec.ts").SecFiling; summary: import("./sec.ts").SecFilingSummary };
  presentation?: SecPresentation;
  sourceMaterials?: SecSourceMaterial[];
  ticker: string;
  periodId: string;
  reportVersion: string;
  headline: string;
  keyMetrics: Array<{
    metricKey: string;
    currentValue: string;
    qoq?: string;
    yoy?: string;
    status: "verified" | "derived" | "not_comparable" | "not_disclosed";
    evidenceIds: string[];
  }>;
  changes: {
    qoq: ComparisonResult["narrativeDeltas"];
    yoy: ComparisonResult["narrativeDeltas"];
    guidance: AnalysisClaim[];
    risks: AnalysisClaim[];
  };
  dataQuality: {
    coverage: number;
    verificationStatus: "verified" | "partial" | "failed";
    warnings: string[];
    analysisStatus?: "complete" | "partial";
    unresolvedQuestions?: string[];
    failedNodeIds?: string[];
    stopReason?: ManagerReview["stopReason"];
    managerCoverageScore?: number;
  };
};

export const SEC_CURRENT_PERIOD_TOLERANCE_DAYS = 10;

export function buildSecAnalysisBrief(args: {
  ticker: string;
  filingId: string;
  periodId: string;
  periodScope: "quarter" | "annual";
  reportDate: string;
  history: SecHistorySnapshot;
  memorySummary: string;
  memoryItems: CompanyMemoryItem[];
}): SecAnalysisBrief {
  const currentFacts: AnalysisFact[] = [];
  const comparisons: SecAnalysisBrief["comparisons"] = [];
  const missingSeriesIds: SecCanonicalSeriesId[] = [];
  for (const series of args.history.series) {
    const observations = args.periodScope === "annual" ? series.annual : series.quarters;
    const current = observations.find((item) =>
      item.endDate <= args.reportDate && dateDistanceDays(item.endDate, args.reportDate) <= SEC_CURRENT_PERIOD_TOLERANCE_DAYS);
    if (!current) {
      missingSeriesIds.push(series.seriesId);
      continue;
    }
    currentFacts.push(factFromObservation(current));
    // Basis is deliberately not part of comparability: a quarter recovered by differencing
    // year-to-date facts measures the same thing as one the issuer reported directly, and
    // excluding it silently pushed the comparison several quarters back.
    const earlier = observations.filter((item) => item.endDate < current.endDate
      && item.unit === current.unit
      && (item.currency ?? "") === (current.currency ?? ""));
    const priors = {
      qoq: args.periodScope === "annual"
        ? undefined
        : earlier.find((item) => dateDistanceDays(item.endDate, current.endDate) <= 130),
      yoy: earlier.find((item) => {
        const distance = dateDistanceDays(item.endDate, current.endDate);
        return args.periodScope === "annual" ? distance >= 300 && distance <= 800 : distance >= 300 && distance <= 450;
      }),
    } as const;
    for (const comparisonType of ["qoq", "yoy"] as const) {
      const prior = priors[comparisonType];
      if (!prior) continue;
      const points = pointDelta(current.value, prior.value, current.unit);
      comparisons.push({
        seriesId: series.seriesId,
        comparisonType,
        currentValue: current.value,
        priorValue: prior.value,
        percentageDelta: percentageDelta(current.value, prior.value),
        ...(points === undefined ? {} : { percentagePointDelta: points }),
        unit: current.unit,
        currency: current.currency,
        basis: current.basis,
        currentEndDate: current.endDate,
        priorEndDate: prior.endDate,
      });
    }
  }
  return {
    version: "sec-analysis-brief.v2",
    ticker: args.ticker,
    filingId: args.filingId,
    periodId: args.periodId,
    periodScope: args.periodScope,
    currentFacts,
    history: {
      registryVersion: args.history.registryVersion,
      series: args.history.series.map((series) => ({ ...series, quarters: series.quarters.slice(0, 8), annual: series.annual.slice(0, 5) })),
    },
    comparisons,
    companyMemorySummary: args.memorySummary.slice(0, 2_500),
    memoryItems: args.memoryItems.filter((item) => item.status === "active" || item.status === "provisional" || (item.status === "stale" && item.duePeriod)).slice(0, 20),
    allowedMetricKeys: [...SEC_CANONICAL_SERIES_IDS],
    missingSeriesIds: [...new Set(missingSeriesIds)].sort(),
  };
}

function factFromObservation(observation: HistoricalObservation): AnalysisFact {
  return {
    factId: observation.observationId,
    metricKey: observation.seriesId,
    value: observation.value,
    unit: observation.unit,
    currency: observation.currency,
    periodScope: observation.periodScope,
    basis: observation.basis === "derived" ? "derived" : "gaap",
    evidenceIds: [observation.observationId],
    confidence: "high",
    sourceLabel: observation.basis === "derived" ? "derived_calculation" : "fact_source_reported",
    definitionHash: observation.xbrlConcept ?? observation.derivationFormula,
  };
}

/**
 * How far a ratio moved, in the ratio's own units — percentage points once rendered.
 *
 * A margin is already a percentage, so expressing its change as a percentage of itself compounds
 * two different scales: operating margin going -9.69% to -29.55% reads as -205% relative, which
 * says nothing a reader can use, while the honest answer is 19.9 points worse. The relative form
 * degrades further as the base approaches zero and flips meaning when the base is negative.
 *
 * Only ratio-unit series get one. An amount has no percentage points to move, and keeps the
 * relative delta on its own.
 */
function pointDelta(current: string, prior: string, unit: string): string | undefined {
  if (unit !== "ratio") return undefined;
  const currentNumber = numericValue(current);
  const priorNumber = numericValue(prior);
  if (currentNumber === null || priorNumber === null) return undefined;
  return String(currentNumber - priorNumber);
}

function percentageDelta(current: string, prior: string): string | undefined {
  const currentNumber = numericValue(current);
  const priorNumber = numericValue(prior);
  if (currentNumber === null || priorNumber === null || priorNumber === 0) return undefined;
  return String((currentNumber - priorNumber) / Math.abs(priorNumber));
}

export function normalizeManagerReview(value: unknown, validNodeIds: Set<string>, validSectionIds: Set<string>): ManagerReview {
  const root = asRecord(value);
  if (!root) throw new Error("Manager Review schema is invalid");
  const questions = Array.isArray(root.questions) ? root.questions.flatMap((raw) => {
    const item = asRecord(raw);
    const questionId = String(item?.questionId ?? "").trim();
    if (!validNodeIds.has(questionId)) return [];
    const allowed = ["answered", "partial", "unanswered", "not_disclosed"] as const;
    const status = allowed.includes(item?.status as typeof allowed[number]) ? item?.status as ManagerQuestionStatus : "unanswered";
    return [{ questionId, status, explanation: String(item?.explanation ?? "").slice(0, 500) }];
  }) : [];
  if (new Set(questions.map((question) => question.questionId)).size !== validNodeIds.size) throw new Error("Manager Review does not cover every planned question");
  const repairTasks = Array.isArray(root.repairTasks) ? root.repairTasks.flatMap((raw): ManagerRepairTask[] => {
    const item = asRecord(raw);
    const targetNodeId = String(item?.targetNodeId ?? "").trim();
    const questionId = String(item?.questionId ?? "").trim();
    const sectionIds = Array.isArray(item?.sectionIds) ? item.sectionIds.map(String).filter((id) => validSectionIds.has(id)) : [];
    if (!validNodeIds.has(questionId) || questionId !== targetNodeId || !validNodeIds.has(targetNodeId) || !sectionIds.length) return [];
    const materiality = item?.materiality === "high" || item?.materiality === "low" ? item.materiality : "medium";
    return [{
      id: String(item?.id ?? `repair-${targetNodeId}`).replace(/[^a-z0-9-]/gi, "-").toLowerCase(),
      questionId,
      targetNodeId,
      title: String(item?.title ?? targetNodeId).slice(0, 120),
      question: String(item?.question ?? "").slice(0, 500),
      sectionIds,
      keywords: Array.isArray(item?.keywords) ? item.keywords.map(String).slice(0, 12) : [],
      historySeriesIds: canonicalSeriesIds(item?.historySeriesIds),
      memoryIds: Array.isArray(item?.memoryIds) ? item.memoryIds.map(String).slice(0, 20) : [],
      acceptanceCriteria: Array.isArray(item?.acceptanceCriteria) ? item.acceptanceCriteria.map(String).filter(Boolean).slice(0, 8) : [],
      materiality,
      missingEvidence: Array.isArray(item?.missingEvidence) ? item.missingEvidence.map(String).filter(Boolean).slice(0, 12) : [],
    }];
  }).sort((left, right) => materialityRank(left.materiality) - materialityRank(right.materiality)).slice(0, MAX_REPAIR_NODES_PER_ROUND) : [];
  const requestedStatus = root.status === "complete" || root.status === "partial" ? root.status : "needs_repair";
  const suppliedUnresolved = Array.isArray(root.unresolvedQuestions) ? root.unresolvedQuestions.map(String).filter(Boolean) : [];
  const unresolvedQuestions = [...new Set([
    ...suppliedUnresolved,
    ...questions.filter((question) => question.status === "partial" || question.status === "unanswered").map((question) => question.questionId),
  ])].slice(0, 30);
  const hasUnresolved = questions.some((question) => question.status === "partial" || question.status === "unanswered");
  const status = requestedStatus === "needs_repair" && !repairTasks.length
    ? "partial"
    : requestedStatus === "complete" && hasUnresolved ? "partial" : requestedStatus;
  const allowedStops: Array<NonNullable<ManagerReview["stopReason"]>> = ["complete", "max_rounds", "no_progress", "analysis_incomplete"];
  const stopReason = allowedStops.includes(root.stopReason as NonNullable<ManagerReview["stopReason"]>)
    ? root.stopReason as NonNullable<ManagerReview["stopReason"]>
    : status === "complete" ? "complete" : null;
  return { status, questions, repairTasks, unresolvedQuestions, coverageScore: clamp(Number(root.coverageScore ?? 0), 0, 1), stopReason };
}

function materialityRank(value: SecNodeSpecV2["materiality"]): number {
  return value === "high" ? 0 : value === "medium" ? 1 : 2;
}

export function unresolvedFingerprint(review: ManagerReview): string {
  const unresolved = review.questions
    .filter((question) => question.status === "partial" || question.status === "unanswered")
    .map((question) => `${question.questionId}:${question.status}`)
    .sort();
  return hashString(JSON.stringify(unresolved));
}

export function buildFilingBlocks(text: string, accessionNumber: string): FilingBlock[] {
  const source = String(text ?? "");
  const lines: Array<{ text: string; start: number; end: number }> = [];
  for (const match of source.matchAll(/[^\n]+/g)) {
    const normalized = match[0].replace(/\s+/g, " ").trim();
    if (!normalized || match.index === undefined) continue;
    lines.push({ text: normalized, start: match.index, end: match.index + match[0].length });
  }
  const chunks: Array<{ body: string; start: number; end: number }> = [];
  let current: { body: string; start: number; end: number } | null = null;
  for (const line of lines) {
    if (!current) {
      current = { body: line.text, start: line.start, end: line.end };
      continue;
    }
    const candidate: string = `${current.body}\n${line.text}`;
    if (candidate.length > 2_400 || isStructuralHeading(line.text)) {
      chunks.push(current);
      current = { body: line.text, start: line.start, end: line.end };
    } else {
      current = { body: candidate, start: current.start, end: line.end };
    }
  }
  if (current) chunks.push(current);

  let heading = "Document";
  return chunks.map(({ body, start, end }, index) => {
    const firstLine = body.split("\n")[0] ?? "";
    if (isStructuralHeading(firstLine)) heading = firstLine.slice(0, 160);
    const blockId = `${accessionNumber}:block:${String(index + 1).padStart(4, "0")}:${hashString(body)}`;
    const digits = (body.match(/[0-9]/g) ?? []).length;
    const tableLikeLines = body.split("\n").filter((line) => (line.match(/[0-9]/g) ?? []).length >= 3).length;
    return {
      blockId,
      ordinal: index,
      start,
      end,
      heading,
      headingPath: `${heading} / block ${index + 1}`,
      elementType: tableLikeLines >= 2 ? "table_like" : isStructuralHeading(firstLine) ? "heading_and_text" : "text",
      preview: body.slice(0, 420),
      body,
      tokenCount: Math.ceil(body.length / 4),
      numericDensity: Math.round((digits / Math.max(body.length, 1)) * 1000),
      tableCount: Math.max(0, Math.floor(tableLikeLines / 4)),
      contentHash: hashString(body),
    };
  });
}

export function normalizeAnalysisFacts(value: unknown, validEvidenceIds: Set<string>): AnalysisFact[] {
  const raw = Array.isArray(value) ? value : [];
  return raw.flatMap((item): AnalysisFact[] => {
    const fact = asRecord(item);
    const evidenceIds = evidenceList(fact?.evidenceIds, validEvidenceIds);
    const valueText = String(fact?.value ?? "").trim();
    const rawMetricKey = String(fact?.metricKey ?? "").trim();
    const definition = normalizeMetricDefinition(fact?.definition);
    const definitionKey = metricKeyFromDefinition(definition);
    const metricKey = rawMetricKey === "business_kpi" && definitionKey ? definitionKey : rawMetricKey;
    if (!metricKey || !valueText || !evidenceIds.length) return [];
    const basis = fact?.basis === "gaap" || fact?.basis === "non_gaap" || fact?.basis === "management_kpi" || fact?.basis === "derived" ? fact.basis : "unknown";
    const sourceLabel = fact?.sourceLabel === "fact_source_reported" || fact?.sourceLabel === "management_adjusted" || fact?.sourceLabel === "derived_calculation" ? fact.sourceLabel : "unknown";
    const unit = String(fact?.unit ?? "").slice(0, 30);
    const currency = /^(?:%|percent|percentage|ratio)$/i.test(unit.trim()) ? "" : String(fact?.currency ?? "").slice(0, 8);
    return [{
      metricKey,
      value: valueText.slice(0, 80),
      unit,
      currency,
      periodScope: String(fact?.periodScope ?? "").slice(0, 40),
      basis,
      evidenceIds,
      confidence: confidence(fact?.confidence),
      sourceLabel,
      definitionHash: definition ? hashString(definition) : undefined,
    }];
  }).slice(0, 24);
}

const METRIC_KEY_MAX_CHARACTERS = 48;
const METRIC_KEY_TRAILING_FILLER = new Set([
  "the", "a", "an", "of", "in", "on", "at", "to", "for", "by", "from", "as", "and", "or", "with", "its", "their", "that", "which",
]);

/**
 * Turns a KPI definition into a readable key. Truncating mid-word produced labels like
 * `compute_networking_reportable_segment_operating_income_as_defined_in_the_segment`, so this cuts
 * on a word boundary and drops a dangling preposition. The full definition still lives in
 * definitionHash, which is what actually distinguishes two KPIs.
 */
export function metricKeyFromDefinition(definition: string): string {
  const words = definition.replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  const kept: string[] = [];
  let length = 0;
  for (const word of words) {
    const next = length ? length + 1 + word.length : word.length;
    if (next > METRIC_KEY_MAX_CHARACTERS) break;
    kept.push(word);
    length = next;
  }
  while (kept.length > 1 && METRIC_KEY_TRAILING_FILLER.has(kept[kept.length - 1])) kept.pop();
  return kept.join("_");
}

function normalizeMetricDefinition(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, 240);
}

export function normalizePublishedReport(
  value: unknown,
  fallback: Omit<PublishedSecReport, "headline" | "keyMetrics" | "changes" | "dataQuality">,
  validEvidenceIds: Set<string> = new Set(),
): PublishedSecReport {
  const root = asRecord(value);
  const keyMetrics: PublishedSecReport["keyMetrics"] = Array.isArray(root?.keyMetrics) ? root.keyMetrics.flatMap((raw) => {
    const item = asRecord(raw);
    const metricKey = String(item?.metricKey ?? "").trim();
    const evidenceIds = evidenceList(item?.evidenceIds, validEvidenceIds).slice(0, 10);
    if (!metricKey || !evidenceIds.length) return [];
    const status: PublishedSecReport["keyMetrics"][number]["status"] = item?.status === "derived" || item?.status === "not_comparable" || item?.status === "not_disclosed" ? item.status : "verified";
    return [{ metricKey, currentValue: String(item?.currentValue ?? "").slice(0, 80), qoq: optionalString(item?.qoq), yoy: optionalString(item?.yoy), status, evidenceIds }];
  }) : [];
  const changes = asRecord(root?.changes);
  const normalizeChangeList = (valueToNormalize: unknown): ComparisonResult["narrativeDeltas"] => Array.isArray(valueToNormalize) ? valueToNormalize.flatMap((item) => normalizeNarrativeDelta(item, validEvidenceIds)) : [];
  const qoq = normalizeChangeList(changes?.qoq);
  const yoy = normalizeChangeList(changes?.yoy);
  const guidance = Array.isArray(changes?.guidance) ? changes.guidance.flatMap((item) => normalizeClaim(item, validEvidenceIds)) : [];
  const risks = Array.isArray(changes?.risks) ? changes.risks.flatMap((item) => normalizeClaim(item, validEvidenceIds)) : [];
  const dataQuality = asRecord(root?.dataQuality);
  const coverage = clamp(Number(dataQuality?.coverage ?? 0), 0, 1);
  const verificationStatus = keyMetrics.length && coverage >= 0.9 && keyMetrics.every((metric) => metric.evidenceIds.length) ? "verified" : keyMetrics.length && coverage > 0 ? "partial" : "failed";
  return {
    ...fallback,
    headline: String(root?.headline ?? "").slice(0, 240),
    keyMetrics,
    changes: { qoq, yoy, guidance, risks },
    dataQuality: { coverage, verificationStatus, warnings: Array.isArray(dataQuality?.warnings) ? dataQuality.warnings.map(String).slice(0, 20) : [] },
  };
}

function normalizeNarrativeDelta(value: unknown, validEvidenceIds: Set<string> = new Set()) {
  const item = asRecord(value);
  const topicKey = String(item?.topicKey ?? "").trim();
  if (!topicKey) return [];
  const allowed = ["introduced", "reaffirmed", "strengthened", "weakened", "withdrawn", "resolved", "not_mentioned"] as const;
  const changeType = allowed.includes(item?.changeType as typeof allowed[number]) ? item?.changeType as typeof allowed[number] : "not_mentioned";
  return [{ topicKey, changeType, currentStatement: optionalString(item?.currentStatement), priorStatement: optionalString(item?.priorStatement), evidenceIds: evidenceList(item?.evidenceIds, validEvidenceIds).slice(0, 10), materialityScore: clamp(Number(item?.materialityScore ?? 0), 0, 100) }];
}

function normalizeClaim(value: unknown, validEvidenceIds: Set<string>): AnalysisClaim[] {
  const item = asRecord(value);
  const topicKey = String(item?.topicKey ?? "").trim();
  const statement = String(item?.statement ?? "").trim();
  const evidenceIds = evidenceList(item?.evidenceIds, validEvidenceIds);
  if (!topicKey || !statement || !evidenceIds.length) return [];
  const claimTypes = ["driver", "guidance", "risk", "one_off", "accounting", "commitment", "tone"] as const;
  const directions = ["positive", "negative", "mixed", "neutral", "unknown"] as const;
  const horizons = ["current", "next_period", "longer_term", "unknown"] as const;
  return [{
    topicKey,
    claimType: claimTypes.includes(item?.claimType as typeof claimTypes[number]) ? item?.claimType as typeof claimTypes[number] : "driver",
    statement: statement.slice(0, 600),
    direction: directions.includes(item?.direction as typeof directions[number]) ? item?.direction as typeof directions[number] : "unknown",
    horizon: horizons.includes(item?.horizon as typeof horizons[number]) ? item?.horizon as typeof horizons[number] : "unknown",
    materialityScore: clamp(Number(item?.materialityScore ?? 0), 0, 100),
    confidence: confidence(item?.confidence),
    evidenceIds,
    targetPeriodId: optionalString(item?.targetPeriodId),
  }];
}

function evidenceList(value: unknown, validEvidenceIds: Set<string>): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(String)
    .filter(Boolean)
    .map((id) => validEvidenceIds.has(id) ? id : `ev:${id}`)
    .filter((id) => validEvidenceIds.has(id))
    .slice(0, 10);
}

function isStructuralHeading(line: string): boolean {
  return line.length <= 160 && (/^(part|item)\s+[ivx0-9]/i.test(line) || /^[A-Z][A-Z0-9\s&,/'().:-]{12,}$/.test(line) || /^\d+(?:\.\d+)*\s+\S+/.test(line));
}

function numericValue(value: string): number | null {
  const normalized = String(value).replace(/[$,%\s,]/g, "");
  const result = Number(normalized);
  return Number.isFinite(result) ? result : null;
}

const CANONICAL_SERIES_ALIASES: Record<string, SecCanonicalSeriesId> = {
  revenue: "revenue",
  revenues: "revenue",
  total_revenue: "revenue",
  total_revenues: "revenue",
  net_revenue: "revenue",
  net_sales: "revenue",
  sales: "revenue",
  gross_profit: "gross_profit",
  gross_margin: "gross_margin",
  gross_profit_margin: "gross_margin",
  operating_income: "operating_income",
  operating_profit: "operating_income",
  income_from_operations: "operating_income",
  operating_margin: "operating_margin",
  operating_profit_margin: "operating_margin",
  net_income: "net_income",
  net_earnings: "net_income",
  profit: "net_income",
  eps: "diluted_eps",
  diluted_eps: "diluted_eps",
  earnings_per_share: "diluted_eps",
  diluted_earnings_per_share: "diluted_eps",
  operating_cash_flow: "operating_cash_flow",
  cash_from_operations: "operating_cash_flow",
  net_cash_from_operating_activities: "operating_cash_flow",
  ocf: "operating_cash_flow",
  capex: "capex",
  capital_expenditures: "capex",
  purchases_of_property_and_equipment: "capex",
  free_cash_flow: "free_cash_flow",
  fcf: "free_cash_flow",
  cash: "cash",
  cash_and_equivalents: "cash",
  cash_and_cash_equivalents: "cash",
  debt: "debt",
  total_debt: "debt",
  long_term_debt: "debt",
  shares: "shares",
  shares_outstanding: "shares",
  diluted_shares: "shares",
};

export function canonicalMetricKey(metricKey: string): SecCanonicalSeriesId | null {
  const normalized = String(metricKey ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return CANONICAL_SERIES_ALIASES[normalized] ?? null;
}

function canonicalSeriesId(metricKey: string): SecCanonicalSeriesId | null {
  return canonicalMetricKey(metricKey);
}

function canonicalSeriesIds(value: unknown): SecCanonicalSeriesId[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).map(canonicalSeriesId).filter((item): item is SecCanonicalSeriesId => Boolean(item)))].slice(0, 12);
}

function dateDistanceDays(left: string, right: string): number {
  const difference = new Date(`${right}T00:00:00Z`).getTime() - new Date(`${left}T00:00:00Z`).getTime();
  return Math.round(difference / 86_400_000);
}

function confidence(value: unknown): "high" | "medium" | "low" {
  return value === "high" || value === "low" ? value : "medium";
}

function optionalString(value: unknown): string | undefined {
  const result = String(value ?? "").trim();
  return result ? result.slice(0, 240) : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}

export function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}
