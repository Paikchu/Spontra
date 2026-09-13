import {
  cleanSecNodeId,
  type SecDocument,
  type SecHeadingCandidate,
  type SecNodePlan,
  type SecNodeResult,
  type SecNodeSpec,
  type SecSummaryImportance,
  type SecWorkflowEvidence,
} from "./sec.ts";
import { normalizeAnalysisFacts, SEC_CANONICAL_SERIES_IDS, type SecCanonicalSeriesId } from "./analysis.ts";

const TABLE_OF_CONTENTS_FRACTION = 0.1;
const MIN_BOLD_SECTION_CHARACTERS = 400;
const MAX_OUTLINE_SECTIONS = 120;
const STRUCTURAL_LEVEL = 6;
const MAX_NODES = 24;
const MAX_NODE_CHARACTERS = 12_000;
const MIN_SECTION_BUDGET = 1_200;
const MAX_EVIDENCE_PER_SECTION = 6;
const MAX_CANDIDATE_CHARACTERS = 1_400;

export type SecOutlineSection = {
  id: string;
  title: string;
  level: number;
  start: number;
  end: number;
  characters: number;
};

export type SecNodeSectionInput = {
  id: string;
  title: string;
  text: string;
  compressed: boolean;
};

export type SecNodeInput = {
  sections: SecNodeSectionInput[];
  characters: number;
  evidence: SecWorkflowEvidence[];
};

export function buildSecOutline(document: SecDocument): SecOutlineSection[] {
  const headings = dropTableOfContents(
    document.headings.filter((heading) => isLikelyHeading(heading.title)),
    document.text.length,
  );
  const sections = withBoundaries(headings, document.text.length)
    .filter((section) => section.level <= STRUCTURAL_LEVEL || isItemHeading(section.title) || section.characters >= MIN_BOLD_SECTION_CHARACTERS);
  const outline = assignIds(capOutline(sections));
  if (outline.length) return outline;
  return document.text.trim()
    ? [{ id: "document", title: "Full document", level: 1, start: 0, end: document.text.length, characters: document.text.length }]
    : [];
}

export function describeSecOutline(outline: SecOutlineSection[]): Array<{ id: string; title: string; characters: number }> {
  return outline.map(({ id, title, characters }) => ({ id, title, characters }));
}

export function normalizeSecNodePlan(value: unknown, outline: SecOutlineSection[]): SecNodePlan {
  const root = asRecord(value);
  const knownSections = new Set(outline.map((section) => section.id));
  const knownSeriesIds = new Set<string>(SEC_CANONICAL_SERIES_IDS);
  const usedIds = new Set<string>();
  const inventedSeriesIds = new Set<string>();
  const nodes = (Array.isArray(root?.nodes) ? root.nodes : []).flatMap((item): SecNodeSpec[] => {
    const input = asRecord(item);
    if (!input) return [];
    const title = cleanLine(input.title, 60);
    const question = cleanLine(input.question, 400);
    const sectionIds = [...new Set((Array.isArray(input.sectionIds) ? input.sectionIds : [])
      .map((id) => String(id ?? "").trim())
      .filter((id) => knownSections.has(id)))];
    if (!title || !sectionIds.length) return [];
    const keywords = [...new Set((Array.isArray(input.keywords) ? input.keywords : [])
      .map((keyword) => String(keyword ?? "").toLowerCase().replace(/\s+/g, " ").trim())
      .filter((keyword) => keyword.length > 1 && keyword.length <= 40))].slice(0, 12);
    const baseId = cleanSecNodeId(input.id) || cleanSecNodeId(title) || "node";
    let id = baseId;
    for (let suffix = 2; usedIds.has(id); suffix += 1) id = `${baseId}-${suffix}`;
    usedIds.add(id);
    const requestedSeriesIds = (Array.isArray(input.historySeriesIds) ? input.historySeriesIds : []).map(String).map((item) => item.trim()).filter(Boolean);
    for (const seriesId of requestedSeriesIds) if (!knownSeriesIds.has(seriesId)) inventedSeriesIds.add(seriesId);
    return [{
      id,
      title,
      question: question || `围绕「${title}」说明本期财报的变化、驱动因素与需要验证的问题。`,
      sectionIds,
      ...(keywords.length ? { keywords } : {}),
      historySeriesIds: requestedSeriesIds.filter((item) => knownSeriesIds.has(item)).slice(0, 12) as SecCanonicalSeriesId[],
      memoryIds: [],
      acceptanceCriteria: Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria.map((criterion) => cleanLine(criterion, 240)).filter(Boolean).slice(0, 8) : ["明确回答任务问题并引用当前 filing 证据"],
      materiality: input.materiality === "high" || input.materiality === "low" ? input.materiality : "medium",
    }];
  });
  const clamped = Math.max(0, nodes.length - MAX_NODES);
  const kept = nodes.slice(0, MAX_NODES);
  const warnings: string[] = [];
  if (inventedSeriesIds.size) warnings.push(`Manager referenced unknown history series: ${[...inventedSeriesIds].sort().slice(0, 8).join(", ")}`);
  return {
    nodes: kept,
    outlineSections: outline.length,
    ...(clamped ? { clamped } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

export function sectionText(text: string, section: SecOutlineSection): string {
  return text.slice(section.start, section.end).trim();
}

export function buildSecNodeInput(spec: SecNodeSpec, outline: SecOutlineSection[], text: string): SecNodeInput {
  const resolved = spec.sectionIds.flatMap((id) => {
    const section = outline.find((candidate) => candidate.id === id);
    if (!section) return [];
    const raw = text.slice(section.start, section.end);
    const body = raw.trim();
    const start = section.start + raw.length - raw.trimStart().length;
    return body ? [{ section: { ...section, start, end: start + body.length }, body }] : [];
  });
  const totalCharacters = resolved.reduce((sum, item) => sum + item.body.length, 0);
  const budgets = allocateSectionBudgets(resolved.map((item) => item.body.length), totalCharacters);
  const terms = nodeTerms(spec, resolved.map((item) => item.section));
  const sections: SecNodeSectionInput[] = [];
  const evidence: SecWorkflowEvidence[] = [];
  for (const [index, { section, body }] of resolved.entries()) {
    const budget = budgets[index];
    const evidenceSelection = selectEvidence(body, terms, Math.min(body.length, Math.max(560, Math.min(budget, 2_400))), MAX_EVIDENCE_PER_SECTION);
    const locatedEvidence = evidenceSelection.evidence.length ? evidenceSelection.evidence : fallbackEvidence(body);
    for (const item of locatedEvidence) {
      evidence.push({ ...item, start: section.start + item.start, end: section.start + item.end });
    }
    if (body.length <= budget) {
      sections.push({ id: section.id, title: section.title, text: body, compressed: false });
      continue;
    }
    const compressed = selectEvidence(body, terms, budget, MAX_EVIDENCE_PER_SECTION);
    sections.push({ id: section.id, title: section.title, text: compressed.text || body.slice(0, budget), compressed: true });
  }
  return { sections, characters: sections.reduce((sum, section) => sum + section.text.length, 0), evidence };
}

function allocateSectionBudgets(lengths: number[], totalCharacters: number): number[] {
  if (totalCharacters <= MAX_NODE_CHARACTERS) return lengths;
  const floor = Math.max(1, Math.min(MIN_SECTION_BUDGET, Math.floor(MAX_NODE_CHARACTERS / Math.max(1, lengths.length))));
  const budgets = lengths.map((length) => Math.min(length, floor));
  let remaining = MAX_NODE_CHARACTERS - budgets.reduce((sum, value) => sum + value, 0);
  while (remaining > 0) {
    const unmet = lengths.map((length, index) => Math.max(0, length - budgets[index]));
    const totalUnmet = unmet.reduce((sum, value) => sum + value, 0);
    if (!totalUnmet) break;
    const available = remaining;
    let distributed = 0;
    for (let index = 0; index < unmet.length && distributed < available; index += 1) {
      if (!unmet[index]) continue;
      const share = Math.min(unmet[index], Math.max(1, Math.floor(available * (unmet[index] / totalUnmet))), available - distributed);
      budgets[index] += share;
      distributed += share;
    }
    if (!distributed) break;
    remaining -= distributed;
  }
  return budgets;
}

function fallbackEvidence(text: string): SecWorkflowEvidence[] {
  const match = text.match(/\S[\s\S]{0,559}/);
  if (!match || match.index === undefined) return [];
  const excerpt = match[0].trimEnd();
  return [{
    start: match.index,
    end: match.index + excerpt.length,
    score: 0,
    reasons: ["绑定章节原文"],
    excerpt,
  }];
}

export function normalizeSecNodeResult(
  value: unknown,
  spec: SecNodeSpec,
  evidence: SecWorkflowEvidence[],
  validEvidenceIds: Set<string> = new Set(),
): SecNodeResult {
  const input = asRecord(value) ?? {};
  const findings = (Array.isArray(input.findings) ? input.findings : []).flatMap((item) => {
    const finding = asRecord(item);
    const label = cleanLine(finding?.label, 24);
    const detail = cleanLine(finding?.detail, 320);
    if (!label || !detail) return [];
    const importance: SecSummaryImportance = finding?.importance === "high" || finding?.importance === "low" ? finding.importance : "medium";
    return [{ label, detail, importance }];
  }).slice(0, 6);
  const narrative = cleanProse(input.narrative, 4_000);
  const facts = normalizeAnalysisFacts(input.facts, validEvidenceIds);
  return {
    id: spec.id,
    title: spec.title,
    status: narrative || findings.length ? "complete" : "empty",
    findings,
    narrative,
    facts,
    evidence: evidence.slice(0, 16),
  };
}

function selectEvidence(text: string, terms: string[], maxCharacters: number, maxSelected: number): { text: string; evidence: SecWorkflowEvidence[] } {
  const normalizedTerms = [...new Set(terms.map((term) => term.toLowerCase().trim()).filter(Boolean))];
  const candidates = buildCandidates(text)
    .map((candidate) => ({ candidate, ...scoreCandidate(candidate.text, normalizedTerms) }))
    .filter((item) => item.rawScore >= 4)
    .sort((left, right) => right.rawScore - left.rawScore || left.candidate.start - right.candidate.start);
  const selected: typeof candidates = [];
  let characters = 0;
  for (const item of candidates) {
    if (selected.length >= maxSelected) break;
    if (selected.some((existing) => overlaps(existing.candidate, item.candidate))) continue;
    const separator = selected.length ? 2 : 0;
    if (characters + separator + item.candidate.text.length > maxCharacters) continue;
    selected.push(item);
    characters += separator + item.candidate.text.length;
  }
  return {
    text: [...selected].sort((left, right) => left.candidate.start - right.candidate.start).map((item) => item.candidate.text).join("\n\n"),
    evidence: selected.map(({ candidate, score, reasons }) => ({
      start: candidate.start,
      end: candidate.end,
      score,
      reasons,
      excerpt: excerpt(candidate.text, 560),
    })),
  };
}

function buildCandidates(text: string): Array<{ text: string; start: number; end: number }> {
  const candidates: Array<{ text: string; start: number; end: number }> = [];
  for (const match of text.matchAll(/[^\n]+/g)) {
    const raw = match[0];
    const leading = raw.length - raw.trimStart().length;
    const value = raw.trim();
    if (!value) continue;
    const start = (match.index ?? 0) + leading;
    for (let offset = 0; offset < value.length; offset += MAX_CANDIDATE_CHARACTERS) {
      const chunk = value.slice(offset, offset + MAX_CANDIDATE_CHARACTERS).trim();
      if (!chunk) continue;
      const chunkStart = start + offset;
      candidates.push({ text: chunk, start: chunkStart, end: chunkStart + chunk.length });
    }
  }
  return candidates;
}

function scoreCandidate(text: string, terms: string[]): { rawScore: number; score: number; reasons: string[] } {
  const lower = text.toLowerCase();
  const reasons: string[] = [];
  let rawScore = 0;
  const matchedTerms = terms.filter((term) => lower.includes(term));
  if (matchedTerms.length) {
    rawScore += Math.min(12, matchedTerms.length * 3);
    reasons.push(`主题词：${matchedTerms.slice(0, 3).join("、")}`);
  }
  if (/[$€£¥]|\b\d+(?:\.\d+)?%|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/.test(text)) {
    rawScore += 5;
    reasons.push("包含定量数据");
  }
  if (/increase|decrease|grew|growth|decline|improve|expand|contract|higher|lower|up \d|down \d/i.test(text)) {
    rawScore += 3;
    reasons.push("包含变化表述");
  }
  if (/driven by|due to|primarily|reflecting|resulted from|attributable to/i.test(text)) {
    rawScore += 3;
    reasons.push("包含驱动解释");
  }
  if (/management['’]s discussion|results of operations|liquidity and capital resources|item\s+[12]a?\b/i.test(text)) {
    rawScore += 4;
    reasons.push("位于高价值章节");
  }
  const riskNode = terms.some((term) => term.includes("risk"));
  if (!riskNode && /forward-looking statements?|safe harbor|uncertaint(?:y|ies)|may be affected/i.test(text)) rawScore -= 7;
  if (/table of contents|signatures?|certifications?|exhibit index/i.test(text)) rawScore -= 10;
  return { rawScore, score: Math.max(0, Math.min(100, Math.round((rawScore / 24) * 100))), reasons };
}

function nodeTerms(spec: SecNodeSpec, sections: SecOutlineSection[]): string[] {
  const titleTerms = sections.flatMap((section) => section.title.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []);
  return [...new Set([...(spec.keywords ?? []), ...titleTerms])];
}

function overlaps(left: { start: number; end: number }, right: { start: number; end: number }): boolean {
  const overlap = Math.max(0, Math.min(left.end, right.end) - Math.max(left.start, right.start));
  return overlap / Math.max(1, Math.min(left.end - left.start, right.end - right.start)) > 0.72;
}

function excerpt(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

function dropTableOfContents(headings: SecHeadingCandidate[], textLength: number): SecHeadingCandidate[] {
  const boundary = textLength * TABLE_OF_CONTENTS_FRACTION;
  const groups = new Map<string, SecHeadingCandidate[]>();
  for (const heading of headings) {
    const key = heading.title.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), heading]);
  }
  const dropped = new Set<SecHeadingCandidate>();
  for (const group of groups.values()) {
    if (group.length < 2 || !group.some((heading) => heading.start > boundary)) continue;
    for (const heading of group) if (heading.start <= boundary) dropped.add(heading);
  }
  return headings.filter((heading) => !dropped.has(heading));
}

function withBoundaries(headings: SecHeadingCandidate[], textLength: number): SecOutlineSection[] {
  const ordered = [...headings].sort((left, right) => left.start - right.start);
  return ordered.map((heading, index) => {
    const next = ordered.slice(index + 1).find((candidate) => candidate.level <= heading.level);
    const end = next?.start ?? textLength;
    return { id: "", title: heading.title, level: heading.level, start: heading.start, end, characters: Math.max(0, end - heading.start) };
  });
}

function capOutline(sections: SecOutlineSection[]): SecOutlineSection[] {
  if (sections.length <= MAX_OUTLINE_SECTIONS) return sections;
  return [...sections]
    .sort((left, right) => left.level - right.level || right.characters - left.characters)
    .slice(0, MAX_OUTLINE_SECTIONS)
    .sort((left, right) => left.start - right.start);
}

function assignIds(sections: SecOutlineSection[]): SecOutlineSection[] {
  const used = new Map<string, number>();
  return sections.map((section, index) => {
    const base = cleanSecNodeId(section.title) || `section-${index + 1}`;
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return { ...section, id: seen ? `${base}-${seen + 1}` : base };
  });
}

function isItemHeading(value: string): boolean {
  return /^(?:part\s+[ivx]+|items?\s+\d{1,2}[a-z]?)\b/i.test(value.trim());
}

function isLikelyHeading(value: string): boolean {
  const title = value.trim();
  return Boolean(title) && title.length <= 120 && title.split(/\s+/).length <= 16 && !/[.!?;:]$/.test(title);
}

function cleanLine(value: unknown, max: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanProse(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}
