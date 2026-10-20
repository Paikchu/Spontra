import { hashString, type CompanyMemoryItem, type CompanyMemoryStatus } from "./analysis.ts";

export type MemoryCandidateV2 = {
  candidateId: string;
  /** Set when the candidate continues an existing memory; the only reliable way to keep a thread. */
  memoryId?: string;
  kind: "fact" | "judgment";
  topicKey: string;
  statement: string;
  evidenceIds: string[];
  materialityScore: number;
  confidence: "high" | "medium" | "low";
  horizon?: string;
  nextTest?: string;
  falsifier?: string;
  disposition: "provisional" | "active" | "stale" | "resolved" | "contradicted" | "superseded" | "rejected";
};

export type MemoryConsolidationState = {
  ticker: string;
  periodId: string;
  items: CompanyMemoryItem[];
};

export type MemoryEventV2 = {
  eventId: string;
  memoryId: string;
  jobId: string;
  eventType: CompanyMemoryStatus | "introduced" | "reaffirmed";
  currentStatement: string;
  priorStatement?: string;
  evidenceIds: string[];
};

/**
 * `knownMemoryIds` is the set of ids the extractor was shown as priorMemory. An id outside it is
 * invented, and honouring it would attach this period's statement to nothing; the candidate still
 * survives as a new memory rather than being thrown away.
 */
export function normalizeMemoryExtraction(value: unknown, validEvidenceIds: Set<string>, knownMemoryIds?: Set<string>): { candidates: MemoryCandidateV2[] } {
  const root = record(value);
  const candidates = Array.isArray(root?.candidates) ? root.candidates.flatMap((raw): MemoryCandidateV2[] => {
    const item = record(raw);
    const kind = item?.kind === "judgment" ? "judgment" : "fact";
    const claimedMemoryId = String(item?.memoryId ?? "").trim();
    const memoryId = claimedMemoryId && (!knownMemoryIds || knownMemoryIds.has(claimedMemoryId)) ? claimedMemoryId : undefined;
    const topicKey = String(item?.topicKey ?? "").trim();
    const statement = String(item?.statement ?? "").trim();
    const evidenceIds = Array.isArray(item?.evidenceIds) ? item.evidenceIds.map(String).filter((id) => validEvidenceIds.has(id)).slice(0, 12) : [];
    const horizon = optional(item?.horizon);
    const nextTest = optional(item?.nextTest);
    const falsifier = optional(item?.falsifier);
    if (!topicKey || !statement || !evidenceIds.length || (kind === "judgment" && (!horizon || !nextTest || !falsifier))) return [];
    const allowed = ["provisional", "active", "stale", "resolved", "contradicted", "superseded", "rejected"] as const;
    const disposition = allowed.includes(item?.disposition as typeof allowed[number]) ? item?.disposition as MemoryCandidateV2["disposition"] : "provisional";
    return [{
      candidateId: String(item?.candidateId ?? `candidate:${hashString(`${kind}:${topicKey}:${statement}`)}`),
      ...(memoryId ? { memoryId } : {}),
      kind,
      topicKey: topicKey.slice(0, 160),
      statement: statement.slice(0, 800),
      evidenceIds,
      materialityScore: Math.max(0, Math.min(100, Number(item?.materialityScore ?? 0))),
      confidence: item?.confidence === "high" || item?.confidence === "low" ? item.confidence : "medium",
      horizon,
      nextTest,
      falsifier,
      disposition,
    }];
  }) : [];
  return { candidates: candidates.slice(0, 40) };
}

export function consolidateMemoryCandidates(
  state: MemoryConsolidationState,
  candidates: MemoryCandidateV2[],
  jobId: string,
): { items: CompanyMemoryItem[]; events: MemoryEventV2[]; noOp: boolean } {
  const items: CompanyMemoryItem[] = state.items.map((item) => ({ ...item, evidenceIds: [...item.evidenceIds], sourceJobIds: [...(item.sourceJobIds ?? [])] }));
  const events: MemoryEventV2[] = [];
  const seen = new Set<string>();
  // Tracks which memories this run spoke to, by id rather than by topic text. Staleness keys off
  // this: matching on the topic string alone meant a reworded statement forked a new memory and
  // left the original looking omitted.
  const touched = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.kind === "judgment" && (!candidate.evidenceIds.length || !candidate.horizon || !candidate.nextTest || !candidate.falsifier)) continue;
    const normalizedKey = `${candidate.kind}:${candidate.topicKey.trim().toLowerCase()}`;
    const existing = (candidate.memoryId
      ? items.find((item) => item.memoryId === candidate.memoryId && item.kind === candidate.kind)
      : undefined)
      ?? items.find((item) => `${item.kind}:${item.topicKey.trim().toLowerCase()}` === normalizedKey);
    const dedupeKey = existing?.memoryId ?? normalizedKey;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const memoryId = existing?.memoryId ?? `memory:${hashString(`${state.ticker}:${normalizedKey}`)}`;
    touched.add(memoryId);
    if (existing?.sourceJobIds?.includes(jobId)) continue;
    const status = normalizeDisposition(candidate.disposition);
    const next: CompanyMemoryItem = {
      memoryId,
      ticker: state.ticker,
      kind: candidate.kind,
      topicKey: candidate.topicKey,
      statement: candidate.statement,
      status,
      materialityScore: Math.max(0, Math.min(100, candidate.materialityScore)),
      confidence: candidate.confidence,
      evidenceIds: [...new Set([...(existing?.evidenceIds ?? []), ...candidate.evidenceIds])],
      firstSeenPeriod: existing?.firstSeenPeriod ?? state.periodId,
      lastConfirmedPeriod: state.periodId,
      horizon: candidate.horizon,
      nextTest: candidate.nextTest,
      falsifier: candidate.falsifier,
      duePeriod: candidate.horizon,
      sourceJobIds: [...new Set([...(existing?.sourceJobIds ?? []), jobId])],
    };
    if (existing) items.splice(items.indexOf(existing), 1, next);
    else items.push(next);
    events.push({
      eventId: `memory-event:${hashString(`${memoryId}:${jobId}:${status}`)}`,
      memoryId,
      jobId,
      eventType: existing ? status === "active" ? "reaffirmed" : status : "introduced",
      currentStatement: candidate.statement,
      priorStatement: existing?.statement,
      evidenceIds: candidate.evidenceIds,
    });
  }
  for (const item of items) {
    if (!touched.has(item.memoryId) && (item.status === "active" || item.status === "provisional")) {
      item.status = "stale";
      item.sourceJobIds = [...new Set([...(item.sourceJobIds ?? []), jobId])];
      events.push({
        eventId: `memory-event:${hashString(`${item.memoryId}:${jobId}:stale`)}`,
        memoryId: item.memoryId,
        jobId,
        eventType: "stale",
        currentStatement: item.statement,
        priorStatement: item.statement,
        evidenceIds: item.evidenceIds,
      });
    }
  }
  return { items, events, noOp: events.length === 0 };
}

export function buildCompanyMemorySummary(items: CompanyMemoryItem[]): string {
  return items
    .filter((item) => item.status === "active" || item.status === "provisional" || (item.status === "stale" && item.duePeriod))
    .sort((left, right) => right.materialityScore - left.materialityScore)
    .slice(0, 20)
    .map((item) => `[${item.memoryId}] ${item.status} · ${item.statement}${item.nextTest ? ` · nextTest: ${item.nextTest}` : ""}`)
    .join("\n")
    .slice(0, 2_500);
}

function normalizeDisposition(value: MemoryCandidateV2["disposition"]): CompanyMemoryStatus {
  return value === "resolved" || value === "contradicted" || value === "superseded" || value === "rejected" || value === "stale" || value === "provisional" ? value : "active";
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function optional(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 400) : undefined;
}
