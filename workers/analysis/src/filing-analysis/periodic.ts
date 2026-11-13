import { quoteInText } from "../../../../shared/analysis-runtime/artifact/html.ts";
import { ARTIFACT_BLOCK_ID } from "../../../../shared/analysis-contract/artifact.ts";
import type { MaterialRef, MaterialSnapshot } from "../../../../shared/analysis-contract/filing-material.ts";
import type { ValueUnit } from "../../../../shared/analysis-runtime/findings.ts";
import { chartHeight, compilePoints, type PointSeries } from "../../../../shared/analysis-runtime/lens/compile.ts";
import { renderChartSvg } from "../../../../shared/analysis-runtime/lens/render.ts";
import { factText, periodText } from "../../../../shared/analysis-runtime/filing-library/facts.ts";
import { readMaterialSnapshot, getFilingMaterial, listFilingMaterials, requestFilingMaterial } from "../filing-material/index.ts";
import { readFilingMarkdown, findFilingTables, readFilingTable, searchFilingMarkdown, sourceText, filingMaterialMeta } from "../filing-material/read.ts";
import { createAnalysisOperations, type AnalysisEnv } from "../operations.ts";
import { handTool, type HandResult } from "../pi/hand-tools.ts";
import type { SecFiling } from "../sec/sec.ts";
import type { AnyTool } from "../tools/registry.ts";
import { registerSource, type ComposerState } from "../artifact/document.ts";
import { computedText, evaluate, factLine, factSourceText, namesIn, type Computed, type StoredFact, type FactQuery } from "./facts.ts";
import { excerpts, transcripts } from "./research.ts";

export type Evidence = { id: string; section: string; ordinal: number; statement: string; quote: string; facts: string[]; origin: "session" };
export type Lead = { id: string; source: "session"; priority: "high" | "normal"; question: string; why: string; refs: string[];
  verdict?: "highlight" | "risk" | "nothing unusual" | "open"; finding?: string; evidence?: string[] };
export type PeriodicState = {
  leads: Lead[]; evidence: Evidence[]; computed: Record<string, Computed>;
  facts: Record<string, { text: string; value: number }>; texts: Record<string, string>;
  materials: MaterialRef[]; markdownRead: boolean; tablesFound: boolean; tablesRead: string[]; charted?: string[];
};
export const openPeriodic = (): PeriodicState => ({ leads: [], evidence: [], computed: {}, facts: {}, texts: {}, materials: [], markdownRead: false, tablesFound: false, tablesRead: [] });
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

export function periodicTools<S extends State>(deps: { env: AnalysisEnv; ticker: string; filing: SecFiling; snapshot: MaterialSnapshot; runId: string; flags?: Array<{ rule: string; level: string; metric: string; value: unknown }> }): {
  tools: AnyTool<S>[]; resolve(id: string, state: S): Promise<boolean>;
  figure(id: string, state: S): Promise<number[] | null>;
  read(id: string, state: S): { title: string; text: string } | null;
  precheck(state: S): string | null; detail(state: S): Record<string, unknown>; standing(state: S): string;
} {
  const { ticker, filing, snapshot } = deps;
  const db = deps.env.DB!;
  const accession = filing.accessionNumber;
  const p = (state: S) => state.periodic ??= openPeriodic();
  const snapshots = new Map<string, MaterialSnapshot>();
  const indexedFacts = new Map<string, StoredFact & { form: string; filedAt: string }>();
  const addSnapshot = (material: MaterialSnapshot) => {
    snapshots.set(material.ref.accession, material);
    const documentOf = new Map(material.blocks.map(block => [block.id, block.documentId]));
    for (const fact of material.facts) indexedFacts.set(fact.factId, { ...fact, documentId: documentOf.get(fact.passageId) ?? "", form: material.filing.form, filedAt: material.filing.filedAt });
  };
  addSnapshot(snapshot);
  const restore = async (state: S) => {
    for (const ref of p(state).materials) if (!snapshots.has(ref.accession)) addSnapshot(await readMaterialSnapshot(deps.env, ref));
  };
  const allFacts = () => [...indexedFacts.values()];
  const factsById = async (_db: D1Database, ids: string[]) => ids.flatMap(id => { const fact = indexedFacts.get(id); return fact ? [fact] : []; });
  const remember = (state: S) => { p(state).materials = [...new Map([...p(state).materials, ...[...snapshots.values()].map(material => material.ref)].map(ref => [`${ref.accession}:${ref.version}`, ref])).values()]; };
  const documents = async () => snapshot.documents.map(d => d.id);
  const queryFacts = async (_db: D1Database, q: FactQuery) => snapshot.facts.filter(f =>
    (!q.label || q.label.toLowerCase().split(/\s+/).every(w => `${f.label} ${f.concept ?? ""}`.toLowerCase().includes(w))) &&
    (!q.periodEnd || f.periodEnd === q.periodEnd) && (q.months === undefined || f.periodMonths === q.months) &&
    (!q.section || f.sectionId === q.section || f.passageId === q.section))
    .map(f => indexedFacts.get(f.factId)!);
  const history = async (state: S) => {
    await restore(state);
    for (const material of await listFilingMaterials(deps.env, ticker)) if (material.status === "ready" && material.filing.filedAt <= filing.filingDate && !snapshots.has(material.ref.accession)) {
      addSnapshot(await readMaterialSnapshot(deps.env, material.ref));
    }
    remember(state);
  };
  const factHistory = async (_db: D1Database, _ticker: string, fact: StoredFact, periods: number, state: S) => {
    await history(state);
    const seen = new Set<string>();
    return allFacts().filter(f => f.concept === fact.concept && f.dimensions === fact.dimensions && f.periodMonths === fact.periodMonths && f.periodEnd && f.periodEnd <= (fact.periodEnd ?? "9999"))
      .sort((a, b) => (b.periodEnd ?? "").localeCompare(a.periodEnd ?? "") || b.filedAt.localeCompare(a.filedAt))
      .filter(f => !seen.has(f.periodEnd!) && !!seen.add(f.periodEnd!)).slice(0, periods);
  };
  const pick = async (wanted: string, state: S): Promise<MaterialSnapshot> => {
    await restore(state);
    const key = wanted || accession;
    if (!snapshots.has(key)) {
      const material = await getFilingMaterial(deps.env, ticker, key);
      if (material?.status !== "ready") {
        const other = await createAnalysisOperations(deps.env, fetch, deps.runId).loadFiling?.(ticker, key);
        if (other) await requestFilingMaterial(deps.env, filingMaterialMeta(other));
        throw new Error(`FILING_MATERIAL_PENDING: ${key}. Its complete material must be prepared before it can be read.`);
      }
      addSnapshot(await readMaterialSnapshot(deps.env, material.ref));
    }
    const found = snapshots.get(key)!;
    if (!p(state).materials.some(r => r.accession === found.ref.accession && r.version === found.ref.version)) p(state).materials.push(found.ref);
    return found;
  };
  const resolve = async (id: string, state: S): Promise<boolean> => {
    const s = p(state);
    if (s.facts[id] !== undefined || s.texts[id] !== undefined || s.computed[id] !== undefined) return true;
    for (const ref of s.materials) if (!snapshots.has(ref.accession)) addSnapshot(await readMaterialSnapshot(deps.env, ref));
    for (const material of snapshots.values()) {
      const found = await sourceText(deps.env, material, id);
      if (!found) continue;
      s.texts[id] = found.text;
      if (found.exact !== undefined) s.facts[id] = { text: found.text, value: found.exact };
      registerSource(state.composer, id, { title: found.title, url: found.url, kind: found.exact === undefined ? "sec" : "data" });
      if (material.ref.accession === accession) state.read = [...new Set([...(state.read ?? []), id])];
      return true;
    }
    return false;
  };
  const valueOf = async (name: string, state: S): Promise<number | undefined> => {
    const s = p(state);
    if (s.computed[name]) return s.computed[name]!.value;
    if (s.facts[name]) return s.facts[name]!.value;
    if (!await resolve(name, state)) return undefined;
    return p(state).facts[name]?.value;
  };
  const sectionText = async (id: string) => {
    for (const material of snapshots.values()) {
      const source = await sourceText(deps.env, material, id);
      if (source) return source.text;
    }
    return null;
  };
  const leadLine = (l: Lead) => `${l.id} [${l.priority}, ${l.source}${l.verdict ? `, ${l.verdict}` : ", not closed"}] ${l.question}${l.finding ? ` → ${l.finding}` : ""}`;
  const tools: AnyTool<S>[] = [
    handTool<S>({ name: "read_filing_markdown", description: "Read the complete preprocessed filing and all its exhibits at the session's fixed material version. Use an anchor or continue with nextCursor. Each returned block is a source id. accession reads a prepared earlier filing; no accession reads this filing.",
      input_schema: object({ accession: { type: "string" }, anchor: { type: "string" }, cursor: { type: "string" }, maxChars: { type: "number" } }) },
      async (args, state) => {
        const material = await pick(str(args.accession), state);
        const page = await readFilingMarkdown(deps.env, material, { ...(str(args.anchor) ? { anchor: str(args.anchor) } : {}), ...(str(args.cursor) ? { cursor: str(args.cursor) } : {}), ...(Number(args.maxChars) > 0 ? { maxChars: Math.min(48_000, Number(args.maxChars)) } : {}) });
        for (const id of page.blockIds) await resolve(id, state);
        if (material.ref.accession === accession) p(state).markdownRead = true;
        return ok(`${JSON.stringify({ material: page.ref, nextCursor: page.nextCursor, sources: page.blockIds })}\n\n${page.text}`);
      }),
    handTool<S>({ name: "find_filing_tables", description: "Find the filing's standalone CSV tables by title or description. Each result names a tableId, contents, periods and source. Read the needed tables with read_filing_table.",
      input_schema: object({ accession: { type: "string" }, name: { type: "string" }, description: { type: "string" }, cursor: { type: "string" } }) },
      async (args, state) => {
        const material = await pick(str(args.accession), state);
        const found = findFilingTables(material, { name: str(args.name), description: str(args.description), cursor: str(args.cursor) || undefined });
        if (material.ref.accession === accession) p(state).tablesFound = true;
        return ok(JSON.stringify({ ref: material.ref, tables: found.tables.map(t => ({ tableId: t.tableId, name: t.title, description: t.description, filename: t.filename, unit: t.table.unit, reportDate: t.reportDate, source: t.sourceUrl })), nextCursor: found.nextCursor }));
      }),
    handTool<S>({ name: "read_filing_table", description: "Read an archived CSV table with units, periods, notes, source and the fact ids used by compute. Continue with nextCursor for every row. The CSV and its source metadata belong to the same fixed material version.",
      input_schema: object({ accession: { type: "string" }, tableId: { type: "string" }, cursor: { type: "string" }, rows: { type: "number" } }, ["tableId"]) },
      async (args, state) => {
        const material = await pick(str(args.accession), state);
        const start = Number(str(args.cursor) || 0), rows = Number(args.rows) > 0 ? Math.min(40, Number(args.rows)) : 40;
        const result = readFilingTable(material, str(args.tableId), { cursor: str(args.cursor) || undefined, rows });
        const block = material.blocks.find(b => b.tableId === result.table.tableId);
        if (block) await resolve(block.id, state);
        await resolve(result.table.tableId, state);
        const end = result.nextCursor === null ? result.table.table.rows.length : Number(result.nextCursor);
        const facts = material.facts.filter(f => (f.passageId === block?.id || f.passageId === result.table.tableId) && (f.row === null || (f.row >= start && f.row < end)));
        for (const fact of facts) await resolve(fact.factId, state);
        if (material.ref.accession === accession) p(state).tablesRead = [...new Set([...p(state).tablesRead, result.table.tableId])];
        return ok(`${JSON.stringify({ ref: result.ref, tableId: result.table.tableId, filename: result.table.filename, description: result.table.description, unit: result.table.table.unit, notes: result.table.table.notes, source: result.table.sourceUrl, nextCursor: result.nextCursor })}\n\n${result.csv}\n\n${facts.map(f => `${f.factId} row ${f.row} col ${f.col} = ${f.value} ${f.unit}`).join("\n")}`);
      }),
    handTool<S>({ name: "grep", description: "Search the fixed filing Markdown by words or phrases. Returns block anchors to read with read_filing_markdown. scope earlier or all searches prepared earlier materials too.",
      input_schema: object({ terms: strings, scope: { type: "string", enum: ["filing", "earlier", "all"] }, cursor: { type: "string" } }, ["terms"]) },
      async (args, state) => {
        const terms = list(args.terms).map(v => String(v).toLowerCase()), scope = str(args.scope) || "filing";
        if (scope !== "filing") await history(state);
        const materials = [...snapshots.values()].filter(m => scope === "filing" ? m.ref.accession === accession : scope === "earlier" ? m.ref.accession !== accession : true);
        const cursor = str(args.cursor) || "0:0";
        const parts = /^(\d+):(\d+)$/.exec(cursor);
        if (!parts) return fail("Use the previous grep result's nextCursor.");
        let index = Number(parts[1]), blockCursor = parts[2]!;
        const matches: Array<{ accession: string; version: string; anchor: string; title: string; chars: number }> = [];
        for (; index < materials.length; index++) {
          const material = materials[index]!;
          const found = await searchFilingMarkdown(deps.env, material, { query: terms.join(" "), cursor: blockCursor, limit: 20 - matches.length });
          matches.push(...found.matches.map(match => ({ accession: material.ref.accession, version: material.ref.version, ...match })));
          if (found.nextCursor) return ok(JSON.stringify({ matches, nextCursor: `${index}:${found.nextCursor}` }));
          if (matches.length === 20) return ok(JSON.stringify({ matches, nextCursor: index + 1 < materials.length ? `${index + 1}:0` : null }));
          blockCursor = "0";
        }
        return ok(JSON.stringify({ matches, nextCursor: null }));
      }),
    handTool<S>({ name: "filing_history", description: "List prepared earlier filing materials and their immutable versions for comparisons. Read one with read_filing_markdown and its accession.", input_schema: object({}) },
      async (_args, state) => { await history(state); return ok(JSON.stringify([...snapshots.values()].filter(m => m.ref.accession !== accession).map(m => ({ material: m.ref, form: m.filing.form, filedAt: m.filing.filedAt, reportDate: m.filing.reportDate, toc: m.toc })))); }),
    handTool<S>({ name: "query_facts", description: "Find figures of this filing by what they are: words of the row label or XBRL concept, a period end (YYYY-MM-DD), the months a flow covers (3, 9, 12; 0 for a balance), or a section. Each line gives the fact id, label, value, period and how the filing prints it.",
      input_schema: object({ label: { type: "string" }, periodEnd: { type: "string" }, months: { type: "number" }, sectionId: { type: "string" }, cursor: { type: "string" } }) },
      async (args) => {
        const months = args.months === undefined || args.months === null || args.months === "" ? undefined : Number(args.months);
        const found = await queryFacts(db, { documents: await documents(), ...(str(args.label) ? { label: str(args.label) } : {}), ...(str(args.periodEnd) ? { periodEnd: str(args.periodEnd) } : {}),
          ...(months !== undefined && Number.isFinite(months) ? { months } : {}), ...(str(args.sectionId) ? { section: str(args.sectionId) } : {}) });
        const start = Number(str(args.cursor) || 0), end = start + 60;
        return ok(found.length ? `${found.slice(start, end).map(factLine).join("\n")}\nnextCursor: ${end < found.length ? String(end) : "none"}` : "No fact matches; try fewer words, or read the CSV with read_filing_table.");
      }),
    handTool<S>({ name: "fact_history", description: "The same figure in earlier periods, from the company's earlier filings: same line, same breakdown, same period length, newest first. For a quarter's flow this gives the earlier quarters the company reported as quarters; a fourth quarter is usually reported only inside the year.",
      input_schema: object({ factId: { type: "string" }, periods: { type: "number" } }, ["factId"]) },
      async (args, state) => {
        const [fact] = await factsById(db, [str(args.factId)]);
        if (!fact) return fail("No such fact; ids come from read_filing_markdown and query_facts.");
        if (!fact.tagged) return ok(`${factLine(fact)}\nThis figure is not tagged, so it cannot be followed by code; use filing_history on its section, or grep its label in earlier filings.`);
        const history = await factHistory(db, ticker, fact, Math.min(16, Math.max(2, Number(args.periods) || 9)), state);
        remember(state);
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
    handTool<S>({ name: "chart_facts", description: "Draw a chart from this company's own filed figures. Each series is either factId, a tagged fact followed through the earlier filings (same line, same period length; up to `periods` of them, 8 by default), or points, a list of {period: \"YYYY-MM-DD\", ref} where ref is a fact id or a result of compute (a margin or growth rate per period). All series of one chart share a unit. type is bar (amounts) or line (rates, trends). On success place it in a block with <figure data-chart=\"id\"></figure>; the reply lists every point drawn, which you may quote as figures citing the same fact or result ids.",
      input_schema: object({ id: { type: "string" }, title: { type: "string" }, type: { type: "string", enum: ["bar", "line"] }, aspect: { type: "string", enum: ["wide", "square"] },
        series: { type: "array", items: object({ label: { type: "string" }, factId: { type: "string" }, periods: { type: "number" }, points: { type: "array", items: object({ period: { type: "string" }, ref: { type: "string" } }, ["ref"]) } }, ["label"]) } }, ["id", "title", "series"]) },
      async (args, state) => {
        const id = str(args.id), title = str(args.title).slice(0, 120);
        if (!ARTIFACT_BLOCK_ID.test(id) || !title) return fail("A chart needs an id (lowercase slug) and a title.");
        const unitOf = (unit: string): ValueUnit | null => unit === "USD" ? "USD" : unit === "shares" ? "shares" : unit === "USD/shares" ? "per_share" : unit === "percent" ? "percent" : unit === "ratio" || unit === "x" ? "ratio" : null;
        const s = p(state);
        const series: PointSeries[] = [], lines: string[] = [];
        let months: number | null = null;
        for (const [i, raw] of (list(args.series) as Array<Record<string, unknown>>).slice(0, 5).entries()) {
          const label = str(raw?.label).slice(0, 60) || `Series ${i + 1}`;
          const points: PointSeries["points"] = [];
          let unit: ValueUnit | null = null;
          if (str(raw?.factId)) {
            const [fact] = await factsById(db, [str(raw.factId)]);
            if (!fact) return fail(`${label}: no such fact; ids come from read_filing_markdown and query_facts.`);
            if (!fact.tagged || !fact.periodEnd) return fail(`${label}: ${fact.factId} is not tagged, so it cannot be followed through earlier filings; give points instead.`);
            unit = fact.unit === "percent" || fact.unit === "ratio" ? null : unitOf(fact.unit);
            if (!unit) return fail(`${label}: a ${fact.unit} fact cannot be charted from its history; compute the rate per period and give points.`);
            months ??= fact.periodMonths;
            const history = await factHistory(db, ticker, fact, Math.min(16, Math.max(2, Number(raw.periods) || 8)), state);
            remember(state);
            for (const h of history) {
              s.facts[h.factId] = { text: factSourceText(h), value: h.value };
              registerSource(state.composer, h.factId, { title: `${h.label}, ${periodText(h)} (${h.form} filed ${h.filedAt})`, url: null, kind: "data" });
              points.push({ end: h.periodEnd!, value: h.value });
              lines.push(`${label} | ${h.periodEnd} | ${factText(h)} | ${h.factId}`);
            }
          } else {
            for (const point of (list(raw?.points) as Array<Record<string, unknown>>).slice(0, 16)) {
              const ref = str(point?.ref);
              const value = await valueOf(ref, state);
              if (value === undefined) return fail(`${label}: "${ref}" is not a fact or a result of this session.`);
              const computed = s.computed[ref];
              const fact = computed ? null : (await factsById(db, [ref]))[0] ?? null;
              const end = /^\d{4}-\d{2}-\d{2}$/.test(str(point?.period)) ? str(point.period) : fact?.periodEnd ?? "";
              if (!end) return fail(`${label}: the point ${ref} needs its period, as YYYY-MM-DD.`);
              const pointUnit = unitOf(computed ? computed.unit : fact?.unit ?? "");
              if (!pointUnit) return fail(`${label}: ${ref} is in ${computed ? computed.unit : fact?.unit}, which a chart cannot draw; use USD, shares, percent, ratio or x.`);
              if (unit && unit !== pointUnit) return fail(`${label}: its points are in different units (${unit}, ${pointUnit}).`);
              unit = pointUnit;
              points.push({ end, value });
              lines.push(`${label} | ${end} | ${Number(value.toPrecision(6))} ${computed ? computed.unit : fact?.unit ?? ""} | ${ref}`);
            }
          }
          if (points.length < 2 || !unit) return fail(`${label}: fewer than two periods could be drawn${str(raw?.factId) ? "; the earlier filings do not report this line the same way" : ""}.`);
          series.push({ id: `s${i + 1}`, label, unit, currency: unit === "USD" || unit === "per_share" ? "USD" : null, points });
        }
        const result = compilePoints({ id, title, aspect: args.aspect === "square" ? "square" : "wide", span: months === 12 ? "fiscal_year" : "quarter", mark: args.type === "line" ? "line" : "bar", series });
        if (!result.chart) return fail(`The chart did not compile:\n${result.errors.map(e => `- ${e}`).join("\n")}`);
        const width = 720;
        state.composer.charts[id] = { id, title: result.chart.title ?? title, svg: renderChartSvg(result.chart, { width, height: chartHeight(width, result.chart.aspect) }, { still: true }), points: [], compiled: result.chart };
        (s.charted ??= []).push(id);
        return ok(`Chart "${id}" compiled. Place it with <figure data-chart="${id}"></figure>. Points drawn (series | period | value | cite as):\n${lines.join("\n")}`);
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
    handTool<S>({ name: "add_lead", description: "Record a question to investigate from the filing material.", input_schema: object({ question: { type: "string" }, why: { type: "string" }, priority: { type: "string", enum: ["high", "normal"] } }, ["question"]) },
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
    handTool<S>({ name: "list_leads", description: "The leads and where each stands.", input_schema: object({}) }, (_args, state) => ok(p(state).leads.map(leadLine).join("\n") || "No leads recorded yet.")),
    handTool<S>({ name: "note_evidence", description: "Record facts you confirmed, so they outlast the conversation's memory. Each: the section it is in (a section id you have read), the words that state it copied exactly, the fact in one sentence with its period, and the fact ids of its figures. The quote is checked against the section. Send several at once.",
      input_schema: object({ entries: { type: "array", items: object({ section: { type: "string" }, quote: { type: "string" }, statement: { type: "string" }, facts: strings }, ["section", "quote", "statement"]) } }, ["entries"]) },
      async (args, state) => {
        const s = p(state);
        const out: string[] = [];
        for (const raw of list(args.entries) as Array<Record<string, unknown>>) {
          const section = str(raw?.section), quote = str(raw?.quote).slice(0, 600), statement = str(raw?.statement).slice(0, 400);
          const known = s.texts[section] ?? (/#\d+$/.test(section) && await resolve(section, state) ? s.texts[section] : state.composer.sources[section] ? await sectionText(section) : null);
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
        return ok(found.length ? found.map(e => `${e.id} [cite as ${e.section}${e.ordinal >= 0 ? `#${e.ordinal}` : ""}] ${e.statement}\n  "${e.quote}"${e.facts.length ? `\n  facts: ${e.facts.join(", ")}` : ""}`).join("\n") : "No note matches.");
      }),
  ];

  return {
    tools, resolve,
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
      if (!s.markdownRead) return "Read this filing with read_filing_markdown before finishing.";
      if (snapshot.tables.length && !s.tablesFound) return "Use find_filing_tables to confirm the relevant CSV by its table name or description before finishing.";
      if (snapshot.tables.length && !s.tablesRead.length) return "Find and read the relevant archived CSV with find_filing_tables and read_filing_table before finishing.";
      const open = s.leads.filter(l => l.priority === "high" && !l.verdict);
      return open.length ? `these high-priority leads are not closed: ${open.map(l => l.id).join(", ")}. Close each with close_lead (highlight, risk, nothing unusual, or open with what is missing)` : null;
    },
    standing: (state) => {
      const s = p(state);

      const open = s.leads.filter(l => !l.verdict);
      return ` Notes on file: ${s.evidence.length} (read_evidence), results computed: ${Object.keys(s.computed).length}. Leads not closed: ${open.length ? open.slice(0, 12).map(l => `${l.id}${l.priority === "high" ? "!" : ""}`).join(", ") + (open.length > 12 ? "…" : "") : "none"}.`;
    },
    detail: (state) => {
      const s = p(state);
      const verdicts: Record<string, number> = {};
      for (const l of s.leads) verdicts[l.verdict ?? "not closed"] = (verdicts[l.verdict ?? "not closed"] ?? 0) + 1;
      const sources: Record<string, number> = {};
      for (const l of s.leads) sources[l.source] = (sources[l.source] ?? 0) + 1;
      return { material: snapshot.ref, reading: snapshot.coverage, tablesRead: s.tablesRead, leads: { total: s.leads.length, high: s.leads.filter(l => l.priority === "high").length, highOpen: s.leads.filter(l => l.priority === "high" && !l.verdict).length, verdicts, sources },
        notes: { total: s.evidence.length, session: s.evidence.filter(e => e.origin === "session").length }, computed: Object.keys(s.computed).length, factsCited: Object.keys(s.facts).length, charts: s.charted ?? [] };
    },
  };
}
