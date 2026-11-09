import type { ManagerReview } from "../sec/analysis.ts";
import type { SecNodePlan, SecNodeResult, SecNodeSpec, SecSummaryBullet } from "../sec/sec.ts";

/**
 * The code's walk over a filing's sections. Every leaf section is visited: one whose text did not change and whose
 * earlier conclusion exists carries that conclusion forward; every other goes to a model in document-ordered batches.
 * The model never chooses a section.
 */
export type SectionFacts = { documentId: string; sectionId: string; path: string[]; canonical: string; change: "unchanged" | "changed" | "new"; previousSectionId: string | null; chars: number };
export type PassageFacts = { sectionId: string; chars: number; change: string };
export type SectionNote = { sectionId: string; summary: string; changes: SecSummaryBullet[]; watch: string[]; quotes: string[] };
export type StoredNote = { sectionId: string; note: SectionNote };
export type WorkEntry = SectionFacts & { prior: "note" | "text" | "none"; workChars: number };
export type Carried = { section: SectionFacts; from: string; note: SectionNote };
export type Worklist = { carried: Carried[]; batches: WorkEntry[][] };

export function buildWorklist(sections: SectionFacts[], passages: PassageFacts[], earlier: ReadonlyMap<string, SectionNote>, batchChars: number): Worklist {
  const carried: Carried[] = [], work: WorkEntry[] = [];
  const changedChars = new Map<string, number>();
  for (const p of passages) if (p.change !== "unchanged") changedChars.set(p.sectionId, (changedChars.get(p.sectionId) ?? 0) + p.chars);
  for (const section of sections) {
    const note = section.previousSectionId ? earlier.get(section.previousSectionId) : undefined;
    if (section.change === "unchanged" && note) { carried.push({ section, from: section.previousSectionId!, note }); continue; }
    const prior = note ? "note" : section.previousSectionId ? "text" : "none";
    // An unchanged section without an earlier conclusion is read whole, once; afterwards it is carried.
    const workChars = section.change === "changed" && changedChars.has(section.sectionId) ? changedChars.get(section.sectionId)! : section.chars;
    work.push({ ...section, prior, workChars });
  }
  const batches: WorkEntry[][] = [];
  let current: WorkEntry[] = [], used = 0, parent: string | null = null;
  for (const entry of work) {
    const head = `${entry.documentId}:${entry.path[0] ?? ""}`;
    if (current.length && (used + entry.workChars > batchChars || (head !== parent && used > batchChars / 2))) { batches.push(current); current = []; used = 0; }
    current.push(entry);
    used += entry.workChars;
    parent = head;
  }
  if (current.length) batches.push(current);
  return { carried, batches };
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();
/** Whether every quote stands word for word in one of the texts; the ones that do not. */
export const missingQuotes = (quotes: string[], texts: string[]): string[] => {
  const haystack = texts.map(collapse);
  return quotes.filter(q => !haystack.some(t => t.includes(collapse(q))));
};

const importance = (value: unknown): SecSummaryBullet["importance"] => value === "high" || value === "low" ? value : "medium";
const line = (value: unknown, max: number) => typeof value === "string" ? collapse(value).slice(0, max) : "";

/** The model's notes for a batch, or what is wrong with them. */
export function readNotes(value: unknown, sectionIds: string[]): { notes: SectionNote[] } | { error: string } {
  if (!Array.isArray(value)) return { error: "notes must be an array with one entry per section." };
  const notes = value.flatMap((raw): SectionNote[] => {
    const v = (raw ?? {}) as Record<string, unknown>;
    const sectionId = String(v.sectionId ?? ""), summary = line(v.summary, 1600);
    if (!sectionId || !summary) return [];
    const changes = (Array.isArray(v.changes) ? v.changes : []).flatMap((c): SecSummaryBullet[] => {
      const item = (c ?? {}) as Record<string, unknown>, label = line(item.label, 60), detail = line(item.detail, 800);
      return label && detail ? [{ label, detail, importance: importance(item.importance) }] : [];
    }).slice(0, 6);
    return [{ sectionId, summary, changes, watch: (Array.isArray(v.watch) ? v.watch : []).map(w => line(w, 240)).filter(Boolean).slice(0, 4), quotes: (Array.isArray(v.quotes) ? v.quotes : []).map(q => typeof q === "string" ? q.trim() : "").filter(Boolean).slice(0, 6) }];
  });
  const written = new Set(notes.map(n => n.sectionId));
  const missing = sectionIds.filter(id => !written.has(id));
  if (missing.length) return { error: `Write a note with a non-empty summary for every section. Missing: ${missing.join(", ")}.` };
  const unknown = notes.filter(n => !sectionIds.includes(n.sectionId)).map(n => n.sectionId);
  if (unknown.length) return { error: `These ids are not sections of this batch: ${unknown.join(", ")}.` };
  return { notes };
}

const rank = { high: 0, medium: 1, low: 2 } as const;
const NODE_SECTIONS = 10;

/**
 * The notes as the questions and answers the report is written from: one node per run of sections under the same
 * heading, in document order. Every section is in exactly one node, so the coverage is complete by construction.
 */
export function notesToNodes(sections: SectionFacts[], notes: ReadonlyMap<string, SectionNote>, evidenceOf: (section: SectionFacts, note: SectionNote) => string[]): { plan: SecNodePlan; nodes: SecNodeResult[]; review: ManagerReview } {
  const groups: SectionFacts[][] = [];
  for (const section of sections) {
    if (!notes.has(section.sectionId)) continue;
    const last = groups.at(-1);
    if (last && last.length < NODE_SECTIONS && last[0]!.documentId === section.documentId && last[0]!.path[0] === section.path[0]) last.push(section); else groups.push([section]);
  }
  const specs: SecNodeSpec[] = [], nodes: SecNodeResult[] = [];
  groups.forEach((group, index) => {
    const id = `sections-${index + 1}`;
    const title = (group[0]!.path[0] ?? group[0]!.canonical).slice(0, 120);
    const written = group.map(s => ({ section: s, note: notes.get(s.sectionId)! }));
    const findings = written.flatMap(w => w.note.changes).sort((a, b) => rank[a.importance] - rank[b.importance]).slice(0, 6);
    specs.push({ id, title, question: `What did the filing disclose or change in ${title}?`, sectionIds: group.map(s => s.sectionId), keywords: [], historySeriesIds: [], memoryIds: [], acceptanceCriteria: [], materiality: findings[0]?.importance ?? "low" } as SecNodeSpec);
    nodes.push({ id, title, status: "complete", findings, narrative: written.map(w => `${w.section.path.at(-1) ?? ""}: ${w.note.summary}`).join("\n").slice(0, 8000), facts: [], evidence: [], evidenceIds: [...new Set(written.flatMap(w => evidenceOf(w.section, w.note)))] });
  });
  const missing = sections.filter(s => !notes.has(s.sectionId)).map(s => s.path.join(" › "));
  const review: ManagerReview = {
    status: missing.length ? "partial" : "complete",
    questions: specs.map(s => ({ questionId: s.id, status: "answered" as const, explanation: "Every section of this heading has a note." })),
    repairTasks: [], unresolvedQuestions: missing.map(m => `Not read: ${m}`).slice(0, 40), coverageScore: sections.length ? (sections.length - missing.length) / sections.length : 0,
    stopReason: missing.length ? "analysis_incomplete" : "complete",
  };
  return { plan: { nodes: specs, outlineSections: sections.length }, nodes, review };
}
