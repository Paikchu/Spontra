import { quoteInText } from "../../../../shared/analysis-runtime/artifact/html.ts";
import { factText, periodText } from "../../../../shared/analysis-runtime/filing-library/facts.ts";
import { librarySectionPassages } from "../filing-library/store.ts";
import type { AnalysisEnv } from "../operations.ts";
import { handTool, type HandResult } from "../pi/hand-tools.ts";
import type { SecFiling } from "../sec/sec.ts";
import type { AnyTool } from "../tools/registry.ts";
import { registerSource, type ComposerState } from "../artifact/document.ts";
import { computedText, evaluate, factHistory, factLine, factSourceText, factsById, factsOfPassages, namesIn, queryFacts, renderPassage, type Computed } from "./facts.ts";
import { buildPack, type Evidence, type Lead } from "./pack.ts";
import { earlierReports, excerpts, grepPassages, sectionChanges, sectionVersions, transcripts, wordingDelta } from "./research.ts";
import { sectionDocuments } from "./store.ts";

/**
 * The tools of a periodic-report session (docs/filing-analysis-optimization.md §4.10, §4.11): the research pack, reading
 * by passage with each number's fact id, search across the company's filings, a section through its earlier versions,
 * facts and their history, arithmetic, earlier reports and calls, and the two ledgers the session keeps — leads and notes.
 */
export type PeriodicState = {
  leads: Lead[]; evidence: Evidence[]; computed: Record<string, Computed>;
  /** Cited facts: what each stands for, read back for the checks. */
  facts: Record<string, { text: string; value: number }>;
  /** Earlier reports and calls read, by source id. */
  texts: Record<string, string>;
  packed?: boolean; coverage?: Record<string, unknown>;
};
export const openPeriodic = (): PeriodicState => ({ leads: [], evidence: [], computed: {}, facts: {}, texts: {} });
type State = { composer: ComposerState; read?: string[]; periodic?: PeriodicState };

export const PERIODIC_BLOCKS = ["summary", "highlights", "risks", "overlooked", "versus-prior", "what-to-watch"] as const;
const FACT_ID = /^f[0-9a-f]{14}$/;
const ok = (observation: string): HandResult => ({ observation });
const fail = (observation: string): HandResult => ({ observation, error: true });
const parsed = (value: unknown): unknown => { if (typeof value !== "string" || !/^\s*[[{]/.test(value)) return value; try { return JSON.parse(value); } catch { return value; } };
const list = (value: unknown): unknown[] => { const v = parsed(value); return Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v]; };
const str = (v: unknown) => typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object" as const, properties, required });
const strings = { type: "array", items: { type: "string" } };

export function periodicTools<S extends State>(deps: { env: AnalysisEnv; ticker: string; filing: SecFiling; runId: string; flags?: Array<{ rule: string; level: string; metric: string; value: unknown }> }): {
  tools: AnyTool<S>[];
  resolve(id: string, state: S): Promise<boolean>;
  figure(id: string, state: S): Promise<number[] | null>;
  read(id: string, state: S): { title: string; text: string } | null;
  precheck(state: S): string | null;
  detail(state: S): Record<string, unknown>;
} {
  const db = deps.env.DB!;
  const { ticker, filing } = deps;
  const accession = filing.accessionNumber;
  const p = (state: S) => state.periodic ??= openPeriodic();
  const documents = async () => (await db.prepare("SELECT document_id FROM sec_documents WHERE ticker = ? AND accession_number = ? AND status = 'ready'").bind(ticker, accession).all<{ document_id: string }>()).results.map(r => r.document_id);
  // ¶ numbers are the primary document's: the report itself, not the exhibits filed with it.
  const primary = async () => (await db.prepare("SELECT document_id FROM sec_documents WHERE ticker = ? AND accession_number = ? AND status = 'ready' AND doc_type = 'primary' ORDER BY chars DESC LIMIT 1").bind(ticker, accession).first<{ document_id: string }>())?.document_id ?? null;
  const publicUrl = /^https:\/\//.test(filing.indexUrl) ? filing.indexUrl : null;

  /** The sections asked for that belong to this company, with the filing each is from. */
  const sectionsOf = async (ids: string[]) => {
    if (!ids.length) return [];
    const rows = await db.prepare(`SELECT s.section_id, s.document_id, s.path, d.accession_number, d.form, d.report_date, d.filed_at FROM sec_sections s JOIN sec_documents d ON d.document_id = s.document_id
      WHERE d.ticker = ? AND s.section_id IN (SELECT value FROM json_each(?))`).bind(ticker, JSON.stringify(ids)).all<{ section_id: string; document_id: string; path: string; accession_number: string; form: string; report_date: string; filed_at: string }>();
    const found = new Map(rows.results.map(r => [r.section_id, r]));
    return ids.flatMap(id => found.has(id) ? [found.get(id)!] : []);
  };
  const register = (state: S, s: { section_id: string; accession_number: string; form: string; report_date: string; filed_at: string; path: string }) => {
    const own = s.accession_number === accession;
    registerSource(state.composer, s.section_id, { title: `${s.form} ${s.report_date || s.filed_at}${own ? "" : " (earlier filing)"}, ${(JSON.parse(s.path) as string[]).slice(-2).join(" › ")}`, url: own ? publicUrl : null, kind: "sec" });
    if (own) state.read = [...new Set([...(state.read ?? []), s.section_id])];
  };
  const resolve = async (id: string, state: S): Promise<boolean> => {
    if (state.composer.sources[id] !== undefined) return true;
    if (FACT_ID.test(id)) {
      const [fact] = await factsById(db, [id]);
      if (!fact) return false;
      p(state).facts[id] = { text: factSourceText(fact), value: fact.value };
      registerSource(state.composer, id, { title: `${fact.label}, ${periodText(fact)}`, url: publicUrl, kind: "data" });
      return true;
    }
    // A section the pack or a search named, cited without a read of its own.
    const [section] = await sectionsOf([id]);
    if (!section) return false;
    register(state, section);
    return true;
  };
  const valueOf = async (name: string, state: S): Promise<number | undefined> => {
    const s = p(state);
    if (s.computed[name]) return s.computed[name]!.value;
    if (s.facts[name]) return s.facts[name]!.value;
    if (!FACT_ID.test(name) || !await resolve(name, state)) return undefined;
    return p(state).facts[name]?.value;
  };
  const sectionText = async (sectionId: string) => {
    const [pair] = await sectionDocuments(db, [sectionId]);
    return pair ? (await librarySectionPassages(db, pair[1], [sectionId])).map(x => x.text).join("\n\n") : null;
  };
  const leadLine = (l: Lead) => `${l.id} [${l.priority}, ${l.source}${l.verdict ? `, ${l.verdict}` : ", not closed"}] ${l.question}${l.finding ? ` → ${l.finding}` : ""}`;

  const tools: AnyTool<S>[] = [
    handTool<S>({ name: "research_pack", description: "The pack prepared for this filing: leads, the figures that moved most, the wording that changed against the earlier filing, what the last report said to watch, the notes on file, and what else can be read. Call it first; it takes a few minutes the first time.", input_schema: object({}) },
      async (_args, state) => {
        const s = p(state);
        if (s.packed) return ok(`The pack was already given. Leads:\n${s.leads.map(leadLine).join("\n")}\nNotes on file: ${s.evidence.length} (read_evidence).`);
        const document = await primary();
        if (!document) return fail("The library holds no readable primary document for this filing.");
        const pack = await buildPack(deps.env, { ticker, filing, documents: [document], runId: deps.runId, ...(deps.flags ? { flags: deps.flags } : {}) });
        s.leads = pack.leads; s.evidence = pack.evidence; s.coverage = pack.coverage; s.packed = true;
        for (const section of await sectionsOf(pack.sections)) register(state, section);
        return ok(pack.text);
      }),
    handTool<S>({ name: "read_sections", description: "Read this filing or an earlier one. Give paragraphs, a list of ¶ numbers of this filing (as the pack and grep give them), to read those paragraphs with the ones around them; or sectionIds, to read whole sections of any of the company's filings. Each paragraph is numbered ¶n; a table shows its merged columns with their periods and each number's fact id (f…). from and to narrow a section to a range of ¶ numbers. Each section read becomes a source a block can cite by its id, shown as [source …].",
      input_schema: object({ paragraphs: { type: "array", items: { type: "number" } }, sectionIds: strings, from: { type: "number" }, to: { type: "number" } }) },
      async (args, state) => {
        const wanted = list(args.paragraphs).map(v => Number(String(v).replace(/[^\d]/g, ""))).filter(Number.isInteger).slice(0, 40);
        if (wanted.length) {
          const document = await primary();
          if (!document) return fail("The library holds no readable primary document for this filing.");
          const near = [...new Set(wanted.flatMap(n => [n - 1, n, n + 1]))].filter(n => n >= 0);
          const rows = await db.prepare("SELECT section_id FROM sec_passages WHERE document_id = ? AND ordinal IN (SELECT value FROM json_each(?)) GROUP BY section_id").bind(document, JSON.stringify(near)).all<{ section_id: string }>();
          const out: string[] = [];
          for (const s of await sectionsOf(rows.results.map(r => r.section_id))) {
            register(state, s);
            const passages = (await librarySectionPassages(db, s.document_id, [s.section_id])).filter(x => near.includes(x.ordinal));
            const facts = await factsOfPassages(db, passages.map(x => x.passageId));
            out.push(`## ${(JSON.parse(s.path) as string[]).join(" › ")} [source ${s.section_id}]\n${passages.map(x => renderPassage(x, facts.get(x.passageId) ?? [])).join("\n\n")}`);
          }
          return out.length ? ok(out.join("\n\n")) : fail("No such paragraph in this filing.");
        }
        const sections = await sectionsOf(list(args.sectionIds).map(String));
        if (!sections.length) return fail("Give paragraphs (¶ numbers of this filing) or sectionIds; ids come from the pack, grep and section_history.");
        const from = Number(args.from), to = Number(args.to);
        const out: string[] = [];
        for (const s of sections) {
          register(state, s);
          const passages = (await librarySectionPassages(db, s.document_id, [s.section_id])).filter(x => (!Number.isFinite(from) || x.ordinal >= from) && (!Number.isFinite(to) || x.ordinal <= to));
          const facts = await factsOfPassages(db, passages.map(x => x.passageId));
          out.push(`## ${(JSON.parse(s.path) as string[]).join(" › ")} — ${s.form} ${s.report_date || s.filed_at} [source ${s.section_id}]\n${passages.map(x => renderPassage(x, facts.get(x.passageId) ?? [])).join("\n\n") || "(no text)"}`);
        }
        return ok(out.join("\n\n"));
      }),
    handTool<S>({ name: "grep", description: "Find passages holding every one of up to four terms (plain words or phrases, case ignored). scope: \"filing\" (this filing, the default), \"earlier\" (the company's earlier periodic reports) or \"all\". Returns the section id, the ¶ number and the words around the first term; read the passage with read_sections.",
      input_schema: object({ terms: strings, scope: { type: "string", enum: ["filing", "earlier", "all"] } }, ["terms"]) },
      async (args) => {
        const terms = list(args.terms).map(String);
        const scope = str(args.scope) || "filing";
        const own = await documents();
        const found = await grepPassages(db, ticker, terms, scope === "filing" ? { documents: own, limit: 20 } : { limit: 30 });
        const kept = scope === "earlier" ? found.filter(f => !own.includes(f.documentId)) : found;
        return ok(kept.length ? kept.map(f => `${f.form} ${f.reportDate || f.filedAt} · ${f.sectionId} ¶${f.ordinal} · ${f.path}\n  ${f.snippet}`).join("\n") : `Nothing holds ${terms.map(t => `"${t}"`).join(" and ")}${scope === "filing" ? " in this filing; try fewer terms or scope \"all\"" : ""}.`);
      }),
    handTool<S>({ name: "section_history", description: "One section of this filing through the filings before it: each earlier version (readable by its id with read_sections) and, against the one just before, the paragraphs added, removed and rewritten.",
      input_schema: object({ sectionId: { type: "string" }, filings: { type: "number" } }, ["sectionId"]) },
      async (args) => {
        const versions = await sectionVersions(db, str(args.sectionId), Math.min(8, Math.max(2, Number(args.filings) || 4)));
        if (!versions.length) return fail("No such section.");
        const lines = versions.map(v => `${v.form} ${v.reportDate || v.filedAt}: ${v.sectionId}, ${v.chars} characters, ${v.change} against the one before`);
        if (versions.length < 2) return ok(`${lines.join("\n")}\nThe earlier filing has no section under this heading.`);
        const changes = await sectionChanges(db, versions[0]!.sectionId, versions[1]!.sectionId);
        const shown = changes.slice(0, 30).map(c => c.kind === "rewritten" ? (() => { const d = wordingDelta(c.before ?? "", c.text); return `rewritten ¶${c.ordinal}\n  now: ${d.came || "(only figures changed)"}\n  was: ${d.gone || "(only figures changed)"}`; })() : `${c.kind} ¶${c.ordinal}: ${c.text.slice(0, 500)}`);
        return ok(`${lines.join("\n")}\n\nAgainst ${versions[1]!.form} ${versions[1]!.reportDate || versions[1]!.filedAt}:\n${shown.join("\n") || "The paragraphs are the same; only tables differ."}${changes.length > 30 ? `\n(${changes.length - 30} more)` : ""}`);
      }),
    handTool<S>({ name: "query_facts", description: "Find figures of this filing by what they are: words of the row label or XBRL concept, a period end (YYYY-MM-DD), the months a flow covers (3, 9, 12; 0 for a balance), or a section. Each line gives the fact id, label, value, period and how the filing prints it.",
      input_schema: object({ label: { type: "string" }, periodEnd: { type: "string" }, months: { type: "number" }, sectionId: { type: "string" } }) },
      async (args) => {
        const months = args.months === undefined || args.months === null || args.months === "" ? undefined : Number(args.months);
        const found = await queryFacts(db, { documents: await documents(), ...(str(args.label) ? { label: str(args.label) } : {}), ...(str(args.periodEnd) ? { periodEnd: str(args.periodEnd) } : {}),
          ...(months !== undefined && Number.isFinite(months) ? { months } : {}), ...(str(args.sectionId) ? { section: str(args.sectionId) } : {}) });
        return ok(found.length ? found.map(factLine).join("\n") : "No fact matches; try fewer words, or read the table with read_sections.");
      }),
    handTool<S>({ name: "fact_history", description: "The same figure in earlier periods, from the company's earlier filings: same line, same breakdown, same period length, newest first. For a quarter's flow this gives the earlier quarters the company reported as quarters; a fourth quarter is usually reported only inside the year.",
      input_schema: object({ factId: { type: "string" }, periods: { type: "number" } }, ["factId"]) },
      async (args, state) => {
        const [fact] = await factsById(db, [str(args.factId)]);
        if (!fact) return fail("No such fact; ids come from read_sections and query_facts.");
        if (!fact.tagged) return ok(`${factLine(fact)}\nThis figure is not tagged, so it cannot be followed by code; use section_history on its section, or grep its label in earlier filings.`);
        const history = await factHistory(db, ticker, fact, Math.min(16, Math.max(2, Number(args.periods) || 9)));
        for (const h of history) { p(state).facts[h.factId] = { text: factSourceText(h), value: h.value }; registerSource(state.composer, h.factId, { title: `${h.label}, ${periodText(h)} (${h.form} filed ${h.filedAt})`, url: null, kind: "data" }); }
        return ok(history.length ? history.map(h => `${h.factId} | ${factText(h)} | ${periodText(h)} | ${h.form} filed ${h.filedAt}`).join("\n") : "No earlier filing reports this line.");
      }),
    handTool<S>({ name: "compute", description: "Work out a figure from facts and earlier results: a formula of fact ids (f…), result ids (c…) and numbers with + - * / and brackets, e.g. \"(f1a… - f2b…) / f2b… * 100\". Facts are in base units (dollars, shares). The result gets an id a block can cite. unit says what the result is: percent, USD, ratio, x, shares, days.",
      input_schema: object({ label: { type: "string" }, formula: { type: "string" }, unit: { type: "string" } }, ["label", "formula", "unit"]) },
      async (args, state) => {
        const formula = str(args.formula), label = str(args.label).slice(0, 160);
        if (!formula || !label) return fail("compute needs a label and a formula.");
        let names: string[];
        try { names = namesIn(formula); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
        const inputs: Record<string, number> = {};
        for (const name of names) { const v = await valueOf(name, state); if (v === undefined) return fail(`"${name}" is not a fact or a result of this session.`); inputs[name] = v; }
        let value: number;
        try { value = evaluate(formula, inputs); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
        const s = p(state);
        const id = `c${Object.keys(s.computed).length + 1}`;
        s.computed[id] = { id, label, formula, inputs, value, unit: str(args.unit).slice(0, 20) || "number" };
        registerSource(state.composer, id, { title: `Computed: ${label}`, url: null, kind: "data" });
        return ok(`${id} = ${Number(value.toPrecision(8))} ${s.computed[id]!.unit} (${label}). Cite it as data-ref="${id}".`);
      }),
    handTool<S>({ name: "read_report", description: "The reports written on the company's earlier filings. Without an accession: the list, newest first. With one: that report's text, which becomes a source you can cite.",
      input_schema: object({ accession: { type: "string" } }) },
      async (args, state) => {
        const reports = await earlierReports(db, ticker, accession, 12);
        const wanted = str(args.accession);
        if (!wanted) return ok(reports.length ? reports.map(r => `${r.accession} | ${r.form} filed ${r.filingDate} | ${r.headline}`).join("\n") : "No earlier report is on file.");
        const report = reports.find(r => r.accession === wanted);
        if (!report) return fail("No report on that filing; call read_report without an accession for the list.");
        const id = `r${report.accession}`;
        p(state).texts[id] = report.text.slice(0, 30_000);
        registerSource(state.composer, id, { title: `Report on the ${report.form} filed ${report.filingDate}`, url: null, kind: "data" });
        return ok(`[source ${id}] ${report.headline}\n${report.text.slice(0, 14_000)}`);
      }),
    handTool<S>({ name: "read_transcript", description: "An earnings call around the terms you give. Without a periodEnd: the calls on file. The excerpt becomes a source you can cite.",
      input_schema: object({ periodEnd: { type: "string" }, focus: strings }) },
      async (args, state) => {
        const calls = await transcripts(db, ticker, 8);
        const wanted = str(args.periodEnd);
        if (!wanted) return ok(calls.length ? calls.map(c => `${c.periodEnd} | ${c.title} | ${c.content.length} characters`).join("\n") : "No earnings call is on file.");
        const call = calls.find(c => c.periodEnd === wanted);
        if (!call) return fail("No call for that period; call read_transcript without a periodEnd for the list.");
        const id = `t${call.periodEnd}`;
        const text = excerpts(call.content, list(args.focus).map(String).filter(Boolean), 10_000);
        p(state).texts[id] = `${p(state).texts[id] ?? ""}\n${text}`.slice(-40_000);
        registerSource(state.composer, id, { title: `${call.title}, period ending ${call.periodEnd}`, url: null, kind: "web" });
        return ok(`[source ${id}]\n${text}`);
      }),
    handTool<S>({ name: "add_lead", description: "Record a lead of your own: something the pack did not raise.", input_schema: object({ question: { type: "string" }, why: { type: "string" }, priority: { type: "string", enum: ["high", "normal"] } }, ["question"]) },
      (args, state) => {
        const s = p(state);
        const lead: Lead = { id: `L${s.leads.length + 1}`, source: "session", priority: args.priority === "high" ? "high" : "normal", question: str(args.question).slice(0, 300), why: str(args.why).slice(0, 300), refs: [] };
        if (!lead.question) return fail("A lead needs a question.");
        s.leads.push(lead);
        return ok(`Recorded as ${lead.id}.`);
      }),
    handTool<S>({ name: "close_lead", description: "Close leads with what you found. Each: the lead id, a verdict (highlight, risk, nothing unusual, open), the finding in a sentence or two with its size and history, and the notes (E…), facts (f…), results (c…) or sections it rests on. An open lead says what is missing and where it would show up next. Send several at once.",
      input_schema: object({ leads: { type: "array", items: object({ id: { type: "string" }, verdict: { type: "string", enum: ["highlight", "risk", "nothing unusual", "open"] }, finding: { type: "string" }, evidence: strings }, ["id", "verdict", "finding"]) } }, ["leads"]) },
      (args, state) => {
        const s = p(state);
        const out: string[] = [];
        for (const raw of list(args.leads) as Array<Record<string, unknown>>) {
          const lead = s.leads.find(l => l.id === str(raw?.id));
          const verdict = str(raw?.verdict) as Lead["verdict"];
          if (!lead) { out.push(`${str(raw?.id) || "?"}: no such lead`); continue; }
          if (!verdict || !["highlight", "risk", "nothing unusual", "open"].includes(verdict)) { out.push(`${lead.id}: the verdict is highlight, risk, nothing unusual or open`); continue; }
          const finding = str(raw?.finding).slice(0, 600);
          if (!finding) { out.push(`${lead.id}: say what you found`); continue; }
          if ((verdict === "highlight" || verdict === "risk") && !list(raw?.evidence).length) { out.push(`${lead.id}: a highlight or risk names the notes, facts or sections it rests on`); continue; }
          Object.assign(lead, { verdict, finding, evidence: list(raw?.evidence).map(String).slice(0, 12) });
          out.push(`${lead.id}: ${verdict}`);
        }
        const left = s.leads.filter(l => !l.verdict);
        return ok(`${out.join("\n")}\nNot closed: ${left.length ? left.map(l => `${l.id}${l.priority === "high" ? " (high)" : ""}`).join(", ") : "none"}.`);
      }),
    handTool<S>({ name: "list_leads", description: "The leads and where each stands.", input_schema: object({}) }, (_args, state) => ok(p(state).leads.map(leadLine).join("\n") || "No leads; call research_pack.")),
    handTool<S>({ name: "note_evidence", description: "Record facts you confirmed, so they outlast the conversation's memory. Each: the section it is in (a section id you have read), the words that state it copied exactly, the fact in one sentence with its period, and the fact ids of its figures. The quote is checked against the section. Send several at once.",
      input_schema: object({ entries: { type: "array", items: object({ section: { type: "string" }, quote: { type: "string" }, statement: { type: "string" }, facts: strings }, ["section", "quote", "statement"]) } }, ["entries"]) },
      async (args, state) => {
        const s = p(state);
        const out: string[] = [];
        for (const raw of list(args.entries) as Array<Record<string, unknown>>) {
          const section = str(raw?.section), quote = str(raw?.quote).slice(0, 600), statement = str(raw?.statement).slice(0, 400);
          const known = s.texts[section] ?? (state.composer.sources[section] ? await sectionText(section) : null);
          if (!known) { out.push(`"${statement.slice(0, 40)}…": ${section || "the section"} is not a source you have read`); continue; }
          if (!quoteInText(quote, known)) { out.push(`"${statement.slice(0, 40)}…": the quote is not in ${section} word for word`); continue; }
          const entry: Evidence = { id: `E${s.evidence.length + 1}`, section, ordinal: -1, statement, quote, facts: list(raw?.facts).map(String).filter(f => FACT_ID.test(f)).slice(0, 8), origin: "session" };
          s.evidence.push(entry);
          out.push(`${entry.id}: recorded`);
        }
        return ok(out.join("\n") || "Nothing to record.");
      }),
    handTool<S>({ name: "read_evidence", description: "Read notes in full: by ids (E12, E40), or those whose statement holds a word. Each gives the statement, the section to cite, the exact words and the fact ids.", input_schema: object({ ids: strings, search: { type: "string" } }) },
      (args, state) => {
        const s = p(state);
        const ids = new Set(list(args.ids).map(String)), word = str(args.search).toLowerCase();
        const found = s.evidence.filter(e => ids.size ? ids.has(e.id) : word ? `${e.statement} ${e.quote}`.toLowerCase().includes(word) : true).slice(0, 60);
        return ok(found.length ? found.map(e => `${e.id} [section ${e.section}${e.ordinal >= 0 ? ` ¶${e.ordinal}` : ""}] ${e.statement}\n  "${e.quote}"${e.facts.length ? `\n  facts: ${e.facts.join(", ")}` : ""}`).join("\n") : "No note matches.");
      }),
  ];

  return {
    // The pack reads the filing with several model calls; it is given the time the review at finish is given.
    tools: tools.map(t => t.name === "research_pack" ? { ...t, timeoutMs: 14 * 60_000 } : t), resolve,
    figure: async (id, state) => { const s = p(state); return s.computed[id] ? [s.computed[id]!.value] : s.facts[id] ? [s.facts[id]!.value] : null; },
    read: (id, state) => {
      const s = p(state);
      if (s.computed[id]) return { title: `Computed: ${s.computed[id]!.label}`, text: computedText(s.computed[id]!) };
      if (s.facts[id]) return { title: state.composer.sources[id]?.title ?? id, text: s.facts[id]!.text };
      if (s.texts[id] !== undefined) return { title: state.composer.sources[id]?.title ?? id, text: s.texts[id]! };
      return null;
    },
    precheck: (state) => {
      const s = p(state);
      if (!s.packed) return "call research_pack and work its leads before finishing";
      const open = s.leads.filter(l => l.priority === "high" && !l.verdict);
      return open.length ? `these high-priority leads are not closed: ${open.map(l => l.id).join(", ")}. Close each with close_lead (highlight, risk, nothing unusual, or open with what is missing)` : null;
    },
    detail: (state) => {
      const s = p(state);
      const verdicts: Record<string, number> = {};
      for (const l of s.leads) verdicts[l.verdict ?? "not closed"] = (verdicts[l.verdict ?? "not closed"] ?? 0) + 1;
      const sources: Record<string, number> = {};
      for (const l of s.leads) sources[l.source] = (sources[l.source] ?? 0) + 1;
      return { reading: s.coverage ?? null, leads: { total: s.leads.length, high: s.leads.filter(l => l.priority === "high").length, highOpen: s.leads.filter(l => l.priority === "high" && !l.verdict).length, verdicts, sources },
        notes: { total: s.evidence.length, session: s.evidence.filter(e => e.origin === "session").length }, computed: Object.keys(s.computed).length, factsCited: Object.keys(s.facts).length };
    },
  };
}
