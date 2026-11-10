import type { LibraryPassageView } from "../../../../shared/analysis-contract/filing-library.ts";
import { quoteInText } from "../../../../shared/analysis-runtime/artifact/html.ts";
import { factText, periodText } from "../../../../shared/analysis-runtime/filing-library/facts.ts";
import { modelFor, reasoningFor } from "../ai-config.ts";
import { callWorkerSecModel, type AnalysisEnv } from "../operations.ts";
import type { SecFiling } from "../sec/sec.ts";
import { factsOfPassages, renderPassage, type StoredFact } from "./facts.ts";
import { CHECKLIST, READER_SYSTEM, READER_VERSION } from "./prompts.ts";
import { earlierReports, sectionChanges, transcripts, watchItems, wordingDelta, type PassageChange } from "./research.ts";

/**
 * The research pack (docs/filing-analysis-optimization.md §4.10): what a periodic-report session opens with. Three
 * sources that cover the whole filing raise the leads — the figures against their own comparatives, the wording against
 * the earlier filing, and a reading of every changed passage against the analyst's checklist — so the session
 * investigates instead of choosing sections by their titles.
 */
export type Evidence = { id: string; section: string; ordinal: number; statement: string; quote: string; facts: string[]; origin: "reading" | "session" };
export type Lead = { id: string; source: "figures" | "wording" | "reading" | "session"; priority: "high" | "normal"; question: string; why: string; refs: string[]; item?: string;
  verdict?: "highlight" | "risk" | "nothing unusual" | "open"; finding?: string; evidence?: string[] };
export type Pack = { text: string; leads: Lead[]; evidence: Evidence[]; sections: string[]; coverage: Record<string, unknown> };

type PassageRow = LibraryPassageView & { canonical: string; path: string; previousSectionId: string | null; textHash: string };
const GROUPS: Array<{ name: string; canonicals: string[] }> = [
  { name: "financial statements and notes", canonicals: ["financial_statements", "note"] },
  { name: "management's discussion and market risk", canonicals: ["mdna", "market_risk"] },
  { name: "risk factors", canonicals: ["risk_factors"] },
];
const OTHER = "legal, controls, other items and exhibits";
// A group is small enough that its notes fit one answer: the first run on NET's 10-Q read 60,000 characters a group and
// seven of ten answers ran out of room.
const GROUP_CHARS = 24_000;
const READ_TOKENS = 48_000;

async function documentPassages(db: D1Database, documents: string[]): Promise<PassageRow[]> {
  if (!documents.length) return [];
  const rows = await db.prepare(`SELECT p.passage_id, p.section_id, p.ordinal, p.kind, p.text, p.table_json, p.fact_refs, p.chars, p.change, p.text_sha256, s.canonical, s.path, s.previous_section_id, s.role
    FROM sec_passages p JOIN sec_sections s ON s.section_id = p.section_id WHERE p.document_id IN (SELECT value FROM json_each(?)) ORDER BY p.document_id, p.ordinal`).bind(JSON.stringify(documents))
    .all<{ passage_id: string; section_id: string; ordinal: number; kind: "paragraph" | "table"; text: string; table_json: string | null; fact_refs: string; chars: number; change: string; text_sha256: string; canonical: string; path: string; previous_section_id: string | null; role: string }>();
  return rows.results.filter(r => r.role !== "boilerplate" || r.change !== "unchanged").map(r => ({ passageId: r.passage_id, sectionId: r.section_id, ordinal: r.ordinal, kind: r.kind, text: r.text, table: r.table_json ? JSON.parse(r.table_json) : null,
    factRefs: JSON.parse(r.fact_refs), chars: r.chars, change: r.change as PassageRow["change"], canonical: r.canonical, path: (JSON.parse(r.path) as string[]).join(" › "), previousSectionId: r.previous_section_id, textHash: r.text_sha256 }));
}

const hashChunks = (hashes: string[]) => { const out: string[][] = []; for (let i = 0; i < hashes.length; i += 400) out.push(hashes.slice(i, i + 400)); return out; };
/** The passages of this text already read under the current checklist, and the notes that reading left. */
type CarriedLead = { question: string; why: string; priority: string; item: string };
async function carried(db: D1Database, ticker: string, hashes: string[]): Promise<{ read: Set<string>; notes: Map<string, Array<{ statement: string; quote: string }>>; leads: Map<string, CarriedLead[]> }> {
  const read = new Set<string>(), notes = new Map<string, Array<{ statement: string; quote: string }>>(), leads = new Map<string, CarriedLead[]>();
  for (const chunk of hashChunks([...new Set(hashes)])) {
    const [seen, kept, raised] = await db.batch<Record<string, string>>([
      db.prepare("SELECT text_sha256 FROM filing_read_passages WHERE ticker = ? AND reader_version = ? AND text_sha256 IN (SELECT value FROM json_each(?))").bind(ticker, READER_VERSION, JSON.stringify(chunk)),
      db.prepare("SELECT text_sha256, statement, quote FROM filing_evidence WHERE ticker = ? AND reader_version = ? AND text_sha256 IN (SELECT value FROM json_each(?)) ORDER BY id").bind(ticker, READER_VERSION, JSON.stringify(chunk)),
      db.prepare("SELECT text_sha256, question, why, priority, item FROM filing_read_leads WHERE ticker = ? AND reader_version = ? AND text_sha256 IN (SELECT value FROM json_each(?)) ORDER BY id").bind(ticker, READER_VERSION, JSON.stringify(chunk)),
    ]);
    for (const r of raised!.results) leads.set(r.text_sha256!, [...leads.get(r.text_sha256!) ?? [], { question: r.question!, why: r.why!, priority: r.priority!, item: r.item! }]);
    for (const r of seen!.results) read.add(r.text_sha256!);
    for (const r of kept!.results) notes.set(r.text_sha256!, [...notes.get(r.text_sha256!) ?? [], { statement: r.statement!, quote: r.quote! }]);
  }
  return { read, notes, leads };
}

async function pooled<T, R>(items: T[], size: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await work(items[i]!, i); } }));
  return out;
}

/** A rewritten paragraph that only rolled its dates and amounts forward is not a change of wording. */
const sameButNumbers = (a: string, b: string) => { const fold = (s: string) => s.replace(/[\d,.$%()]+/g, "#").replace(/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/gi, "#").replace(/\s+/g, " ").trim().toLowerCase(); return fold(a) === fold(b); };

type ReaderAnswer = { evidence?: unknown; leads?: unknown };
const text = (v: unknown, max: number) => typeof v === "string" ? v.trim().slice(0, max) : "";

export async function buildPack(env: AnalysisEnv, input: { ticker: string; filing: SecFiling; documents: string[]; runId: string; flags?: Array<{ rule: string; level: string; metric: string; value: unknown }> }): Promise<Pack> {
  const db = env.DB!;
  const { ticker, filing } = input;
  const all = await documentPassages(db, input.documents);
  const facts = await factsOfPassages(db, all.map(p => p.passageId));
  const changed = all.filter(p => p.change !== "unchanged");
  // A passage is read once per checklist: one a later filing repeats word for word keeps the notes its first reading left.
  const before0 = await carried(db, ticker, all.map(p => p.textHash));
  const toRead = all.filter(p => !before0.read.has(p.textHash));
  const first = before0.read.size === 0;

  // --- Wording against the earlier filing.
  const sections = [...new Map(all.filter(p => p.previousSectionId && p.canonical !== "financial_statements").map(p => [p.sectionId, p])).values()];
  const wording: Array<PassageChange & { section: string; path: string; canonical: string }> = [];
  const before = new Map<string, string>();
  for (const s of sections) {
    if (!changed.some(p => p.sectionId === s.sectionId)) continue;
    for (const c of await sectionChanges(db, s.sectionId, s.previousSectionId!)) {
      if (c.kind === "rewritten" && sameButNumbers(c.text, c.before ?? "")) continue;
      if (c.kind === "rewritten") before.set(`${s.sectionId}|${c.ordinal}`, c.before ?? "");
      wording.push({ ...c, section: s.sectionId, path: s.path, canonical: s.canonical });
    }
  }

  // --- The reading: every passage to read, in groups, each group read once against the checklist.
  const groupOf = (p: PassageRow) => GROUPS.find(g => g.canonicals.includes(p.canonical))?.name ?? OTHER;
  const batches: Array<{ part: string; passages: PassageRow[] }> = [];
  for (const name of [...GROUPS.map(g => g.name), OTHER]) {
    let current: PassageRow[] = [], size = 0;
    for (const p of toRead.filter(x => groupOf(x) === name)) {
      if (size + p.chars > GROUP_CHARS && current.length && current.at(-1)!.sectionId !== p.sectionId) { batches.push({ part: name, passages: current }); current = []; size = 0; }
      current.push(p); size += p.chars;
    }
    if (current.length) batches.push({ part: name, passages: current });
  }
  const byOrdinal = new Map(all.map(p => [p.ordinal, p]));
  const evidence: Evidence[] = [], leads: Lead[] = [];
  for (const p of all) for (const note of before0.notes.get(p.textHash) ?? []) {
    if (before0.read.has(p.textHash)) evidence.push({ id: `E${evidence.length + 1}`, section: p.sectionId, ordinal: p.ordinal, statement: note.statement, quote: note.quote, facts: [], origin: "reading" });
  }
  const carriedNotes = evidence.length;
  // A lead is carried with a passage that is new to this filing: one a later filing merely repeats was worked when it was new.
  for (const p of all) if (before0.read.has(p.textHash) && p.change !== "unchanged") for (const l of before0.leads.get(p.textHash) ?? []) {
    leads.push({ id: "", source: "reading", priority: l.priority === "high" ? "high" : "normal", question: l.question, why: l.why, refs: [`¶${p.ordinal}`], ...(l.item ? { item: l.item } : {}) });
  }
  const carriedLeads = leads.length;
  const failures: string[] = [];
  const answers = await pooled(batches, 8, async (batch, index) => {
    const shown = batch.passages.map(p => {
      const earlier = before.get(`${p.sectionId}|${p.ordinal}`);
      const delta = earlier ? wordingDelta(earlier, p.text) : null;
      return `[${p.path}]\n${renderPassage(p, facts.get(p.passageId) ?? [])}${delta && (delta.gone || delta.came) ? `\n   earlier wording, now gone: ${delta.gone || "(none)"}` : ""}`;
    }).join("\n\n");
    try {
      return await callWorkerSecModel(env, fetch, `filing-read-${index + 1}`, `${READER_SYSTEM(ticker, filing.form, filing.reportDate || filing.filingDate, batch.part)}\n\n${CHECKLIST}`, { passages: shown },
        modelFor(env, "filing-read"), 6 * 60_000, { reasoning: reasoningFor(env, "filing-read"), maxTokens: READ_TOKENS, ticker, runId: input.runId, kind: "filing-read" }) as ReaderAnswer;
    } catch (error) { failures.push(`${batch.part}: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`); return null; }
  });
  // What was read is recorded, group by group: a group whose call failed is left for the next run to read.
  const readNow = batches.flatMap((batch, i) => answers[i] ? batch.passages : []);
  const now = new Date().toISOString();
  const readStatement = db.prepare("INSERT INTO filing_read_passages (ticker, text_sha256, reader_version, read_at) SELECT ?1, value, ?2, ?3 FROM json_each(?4) WHERE true ON CONFLICT DO NOTHING");
  for (const chunk of hashChunks([...new Set(readNow.map(p => p.textHash))])) await readStatement.bind(ticker, READER_VERSION, now, JSON.stringify(chunk)).run().catch(() => undefined);
  const ordinalOf = (v: unknown) => { const n = Number(String(v ?? "").replace(/[^\d]/g, "")); return Number.isInteger(n) && byOrdinal.has(n) ? n : null; };
  for (const answer of answers) {
    for (const raw of Array.isArray(answer?.evidence) ? answer!.evidence as Array<Record<string, unknown>> : []) {
      const ordinal = ordinalOf(raw?.passage), passage = ordinal === null ? null : byOrdinal.get(ordinal)!;
      const quote = text(raw?.quote, 500), statement = text(raw?.statement, 400);
      // An entry is kept only when its words are in the passage it names: the session writes from these.
      if (!passage || !statement || !quote || !quoteInText(quote, passage.text)) continue;
      const known = new Set((facts.get(passage.passageId) ?? []).map(f => f.factId));
      evidence.push({ id: `E${evidence.length + 1}`, section: passage.sectionId, ordinal: passage.ordinal, statement, quote, facts: (Array.isArray(raw.facts) ? raw.facts.map(String) : []).filter(f => known.has(f)).slice(0, 8), origin: "reading" });
    }
    for (const raw of Array.isArray(answer?.leads) ? answer!.leads as Array<Record<string, unknown>> : []) {
      const question = text(raw?.question, 300);
      if (!question) continue;
      const refs = (Array.isArray(raw.passages) ? raw.passages : []).flatMap(v => { const n = ordinalOf(v); return n === null ? [] : [`¶${n}`]; }).slice(0, 6);
      leads.push({ id: "", source: "reading", priority: raw.priority === "high" ? "high" : "normal", question, why: text(raw?.why, 300), refs, item: text(raw?.item, 80) });
    }
  }

  const fresh = evidence.slice(carriedNotes);
  if (fresh.length) {
    const hashOf = new Map(all.map(p => [p.ordinal, p.textHash]));
    const rows = fresh.map(e => [hashOf.get(e.ordinal), e.statement, e.quote]);
    await db.prepare("INSERT INTO filing_evidence (ticker, text_sha256, reader_version, statement, quote, created_at) SELECT ?1, json_extract(value,'$[0]'), ?2, json_extract(value,'$[1]'), json_extract(value,'$[2]'), ?3 FROM json_each(?4)")
      .bind(ticker, READER_VERSION, now, JSON.stringify(rows)).run().catch(() => undefined);
  }

  // The leads this reading raised are kept with the passage each first names.
  const raisedNow = leads.slice(carriedLeads).flatMap(l => { const n = Number((l.refs[0] ?? "").replace(/\D/g, "")); const hash = byOrdinal.get(n)?.textHash; return hash ? [[hash, l.question, l.why, l.priority, l.item ?? ""]] : []; });
  if (raisedNow.length) await db.prepare("INSERT INTO filing_read_leads (ticker, text_sha256, reader_version, question, why, priority, item, created_at) SELECT ?1, json_extract(value,'$[0]'), ?2, json_extract(value,'$[1]'), json_extract(value,'$[2]'), json_extract(value,'$[3]'), json_extract(value,'$[4]'), ?3 FROM json_each(?4)")
    .bind(ticker, READER_VERSION, now, JSON.stringify(raisedNow)).run().catch(() => undefined);

  // --- Figures against their own comparatives: each statement line this period against the same line a year earlier.
  const statementFacts = all.filter(p => p.canonical === "financial_statements").flatMap(p => facts.get(p.passageId) ?? []).filter(f => f.tagged && f.concept && !f.dimensions && f.unit === "USD" && f.periodEnd);
  const latest = statementFacts.map(f => f.periodEnd!).sort().at(-1) ?? "";
  const key = (f: StoredFact) => `${f.concept}|${f.periodMonths}`;
  const byKey = new Map<string, StoredFact[]>();
  for (const f of statementFacts) byKey.set(key(f), [...byKey.get(key(f)) ?? [], f]);
  const revenue = statementFacts.find(f => f.periodEnd === latest && f.periodMonths === 3 && /^us-gaap:(?:Revenues|RevenueFromContractWithCustomerExcludingAssessedTax)$/.test(f.concept!))?.value ?? 0;
  const movers: Array<{ now: StoredFact; before: StoredFact; change: number }> = [];
  for (const list of byKey.values()) {
    const now = list.find(f => f.periodEnd === latest && (f.periodMonths === 3 || f.periodMonths === 0));
    if (!now) continue;
    // A flow is set against the same quarter a year earlier; a balance against the last year-end the filing shows.
    const earlier = list.filter(f => f.periodEnd! < latest).sort((a, b) => b.periodEnd!.localeCompare(a.periodEnd!))[0];
    if (!earlier || !earlier.value) continue;
    if (revenue && Math.abs(now.value) < revenue * 0.01 && Math.abs(earlier.value) < revenue * 0.01) continue;
    movers.push({ now, before: earlier, change: (now.value - earlier.value) / Math.abs(earlier.value) });
  }
  movers.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  for (const m of movers.slice(0, 8)) leads.push({ id: "", source: "figures", priority: "normal", question: `Why did ${m.now.label} move ${(m.change * 100).toFixed(0)}% (${factText(m.before)} ${periodText(m.before)} to ${factText(m.now)} ${periodText(m.now)})?`,
    why: "One of the largest moves among the statement lines.", refs: [m.now.factId, m.before.factId] });
  // High-priority leads first, then by source, so the ids read in the order worth working.
  leads.sort((a, b) => Number(b.priority === "high") - Number(a.priority === "high"));
  leads.forEach((l, i) => { l.id = `L${i + 1}`; });

  // --- What came before, and what else can be read.
  const reports = await earlierReports(db, ticker, filing.accessionNumber, 8);
  const lastPeriodic = reports.find(r => /^(?:10-[QK]|20-F|40-F)/.test(r.form)) ?? null;
  const calls = await transcripts(db, ticker, 6);
  const filings = await db.prepare("SELECT form, COUNT(*) n, MIN(filed_at) first, MAX(filed_at) last FROM sec_documents WHERE ticker = ? AND doc_type = 'primary' AND status = 'ready' GROUP BY form ORDER BY n DESC LIMIT 8").bind(ticker).all<{ form: string; n: number; first: string; last: string }>();
  const parts = new Map<string, { chars: number; changed: number }>();
  for (const p of all) { const g = parts.get(p.canonical) ?? { chars: 0, changed: 0 }; g.chars += p.chars; if (p.change !== "unchanged") g.changed += p.chars; parts.set(p.canonical, g); }

  const line = (l: Lead) => `${l.id} [${l.priority}, ${l.source}] ${l.question}${l.why ? ` — ${l.why}` : ""}${l.refs.length ? ` (${l.refs.join(", ")})` : ""}`;
  const out = [
    `# Research pack: ${ticker} ${filing.form}, period ending ${filing.reportDate || "n/a"}, filed ${filing.filingDate}`,
    `## 1. Leads (${leads.length})\nRaised before you started, from three sources: figures (each statement line against its comparative), wording (against the earlier filing) and reading (${first ? "every passage" : "every passage not read before"} read against the checklist). They are prompts to investigate, not conclusions; some will come to nothing. ¶n is a passage of this filing, f… a fact.\n${leads.map(line).join("\n") || "None."}`,
    `## 2. Figures that moved most\nThis period against the comparative the filing shows.\n${movers.slice(0, 30).map(m => `${m.now.factId} ${m.now.label}: ${factText(m.now)} ${periodText(m.now)}, was ${factText(m.before)} ${periodText(m.before)} (${m.before.factId}), ${(m.change * 100).toFixed(1)}%`).join("\n") || "No comparable statement lines were found."}`,
    `## 3. Wording that changed\nParagraphs added, removed or rewritten against the earlier filing; paragraphs that only rolled dates and amounts forward are left out.\n${wording.slice(0, 60).map(w => `${w.kind} ¶${w.ordinal} [${w.path}] ${w.kind === "rewritten" ? (() => { const d = wordingDelta(w.before ?? "", w.text); return `now: ${d.came.slice(0, 260)} | was: ${d.gone.slice(0, 200)}`; })() : w.text.slice(0, 300)}`).join("\n") || "None."}${wording.length > 60 ? `\n(${wording.length - 60} more; use section_history on a section to see them)` : ""}`,
    `## 4. What the last report said\n${lastPeriodic ? `${lastPeriodic.form} filed ${lastPeriodic.filingDate}: ${lastPeriodic.headline}\n${watchItems(lastPeriodic.text) || lastPeriodic.text.slice(0, 1500)}\nRead it whole with read_report("${lastPeriodic.accession}"). Answer each item it said to watch in versus-prior.` : "No earlier periodic report is on file: say so in versus-prior and compare with the earlier filings themselves."}`,
    `## 5. Rule flags\n${(input.flags ?? []).slice(0, 12).map(f => `${f.level} ${f.rule}: ${f.metric} ${String(f.value)}`).join("\n") || "None."}`,
    `## 6. Notes already on file (${evidence.length})\nFacts the reading recorded, each with its passage and the words that state it. Read them with read_evidence; add your own with note_evidence.\n${evidence.map(e => `${e.id} ¶${e.ordinal}: ${e.statement.slice(0, 140)}`).join("\n") || "None."}`,
    `## 7. What you can read\nThis filing by part (characters, of which changed): ${[...parts].map(([name, g]) => `${name} ${g.chars}/${g.changed}`).join("; ")}.\nEarlier filings in the library: ${filings.results.map(f => `${f.n} ${f.form} (${f.first} to ${f.last})`).join("; ") || "none"}. Search them with grep, follow one section back with section_history.\nEarlier reports: ${reports.map(r => `${r.accession} ${r.form} ${r.filingDate}`).join("; ") || "none"}.\nEarnings calls: ${calls.map(c => c.periodEnd).join(", ") || "none"}.`,
    ...(failures.length ? [`## Reading that failed\n${failures.join("\n")}\nThese parts were not read for you; read them yourself.`] : []),
  ].join("\n\n");
  return {
    text: out, leads, evidence, sections: [...new Set(all.map(p => p.sectionId))],
    coverage: { first, groups: batches.length, failed: failures.length, passages: all.length, changedPassages: changed.length, changedChars: changed.reduce((n, p) => n + p.chars, 0),
      readPassages: readNow.length, readChars: readNow.reduce((n, p) => n + p.chars, 0), carriedPassages: all.length - toRead.length, carriedNotes, carriedLeads, notes: evidence.length, wordingChanges: wording.length, movers: movers.length },
  };
}
