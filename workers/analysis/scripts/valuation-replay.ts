/**
 * Replays a published valuation's drivers through the current calculator, with the method weights and scenario probabilities given on the command line standing in for the
 * model's judgements. Offline: reads one payload file; no network, database or model call. Required environment variables: none.
 *
 *   node --experimental-strip-types --no-warnings workers/analysis/scripts/valuation-replay.ts \
 *     --payload ORCL-live-payload.json --weights 0.5,0.3,0.2 --probabilities 0.2,0.4,0.25,0.15 --consensus 235.8,110,400,43,2026-10-31 --out replay.md --json replay.json
 *
 * The payload is a ValuationPublication (or `{ report }`); the peers, anchor, facts, rate, shares and bridge it carries are reused as they
 * were frozen with the report; management targets come from `--inputs`, the company's valuation inputs as the admin route answers
 * them (`GET /api/admin/business-map/companies/<T>/valuation-inputs`), placed by `--fye` or the file's `fiscalYearEndMonth`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { ValuationPublication } from "../../../shared/analysis-contract/valuation.ts";
import { calculateValuation, type CalcRequest } from "../../../shared/analysis-runtime/valuation/calculator.ts";
import { managementTargetSet, parseTargets } from "../src/valuation/curated.ts";

const { values: args } = parseArgs({ options: { payload: { type: "string" }, weights: { type: "string" }, probabilities: { type: "string" }, consensus: { type: "string" }, out: { type: "string" }, json: { type: "string" }, inputs: { type: "string" }, fye: { type: "string" } } });
const raw = JSON.parse(readFileSync(args.payload!, "utf8")) as { report?: ValuationPublication } & ValuationPublication;
const report = raw.report ?? raw;
const inputs = args.inputs ? JSON.parse(readFileSync(args.inputs, "utf8")) as { targets?: unknown; fiscalYearEndMonth?: number | null } : null;
const management = managementTargetSet(report.ticker, inputs?.targets ? parseTargets(inputs.targets) : null, args.fye ? Number(args.fye) : inputs?.fiscalYearEndMonth ?? null, new Date().toISOString()).set;
const m = report.model;
if (!m) throw new Error("the payload has no model");
const fact = (id: string) => report.facts.find(f => f.id === id)?.value ?? null;
const [dcf, ev, pe] = (args.weights ?? "").split(",").map(Number);
const weights = args.weights ? { dcf: { weight: dcf!, rationale: "replay (command line)", evidenceIds: [] }, ev_ebitda_forward: { weight: ev!, rationale: "replay (command line)", evidenceIds: [] }, pe_forward: { weight: pe!, rationale: "replay (command line)", evidenceIds: [] } } : null;
const probabilities = args.probabilities ? (([bear, base, mgmt, bull]) => Object.fromEntries([["bear", bear], ["base", base], ["management", mgmt], ["bull", bull]].map(([k, v]) => [k, { probability: Number(v), rationale: "replay (command line)", evidenceIds: [] }])))(args.probabilities.split(",")) as unknown as NonNullable<CalcRequest["context"]>["scenarioProbabilities"] : null;
const consensus = args.consensus ? (([mean, low, high, count, asOf]) => ({ mean: Number(mean), low: low ? Number(low) : null, high: high ? Number(high) : null, count: count ? Number(count) : null, asOf: asOf ?? null, evidenceId: null }))(args.consensus.split(",")) : m.consensus ?? null;
const request: CalcRequest = {
  modelType: m.modelType, currency: m.currency, discountRate: m.discountRate, shares: { base: m.shares.base, dilutionReserve: m.shares.dilutionReserve, basis: m.shares.basis }, bridge: m.bridge, price: m.range.price, midYear: m.midYear === true,
  scenarios: Object.fromEntries((["bear", "base", "bull"] as const).map(k => [k, { narrative: m.scenarios[k].narrative, probability: null, triggers: m.scenarios[k].triggers, invalidation: m.scenarios[k].invalidation, evidenceIds: m.scenarios[k].evidenceIds, drivers: m.scenarios[k].drivers }])) as CalcRequest["scenarios"],
  context: {
    facts: report.facts.map(f => ({ id: f.id, value: f.value, unit: f.unit })), riskFree: m.discountRate.components.riskFree, anchor: m.anchors?.revenue ?? null, peers: m.peers ?? null, consensus,
    consensusNote: consensus ? { status: "cited", source: args.consensus ? "command line" : "the published report", reason: null } : { status: "unavailable", source: null, reason: "the published report cited none and none was given on the command line" },
    trailing: { ebitda: fact("ebitda_ttm"), da: fact("da_ttm"), interestExpense: fact("interest_expense_ttm") }, forwardYears: 3, methodWeights: weights, lifecycle: null,
    management, periodEnd: report.financialPeriodEnd, scenarioProbabilities: probabilities, managementComparison: { rationale: "replay (command line)", evidenceIds: [] },
  },
};
const result = calculateValuation(request);
const money = (v: number | null | undefined) => v == null ? "n/a" : `$${v.toFixed(2)}`;
const pct = (v: number | null | undefined) => v == null ? "n/a" : `${(v * 100).toFixed(1)}%`;
const lines: string[] = [];
lines.push(`# ${report.ticker} replay of the published drivers (${report.methodVersion} / ${report.calculatorVersion}, generated ${report.generatedAt.slice(0, 10)}) through ${result.calculatorVersion}`, "");
lines.push(`Price ${money(m.range.price)}; published base ${money(m.range.base)} (weights ${JSON.stringify(m.triangulation?.weights ?? null)}); replay weights ${weights ? `dcf ${pct(dcf)}, ev_ebitda_forward ${pct(ev)}, pe_forward ${pct(pe)}` : "life-cycle default (mature)"}; probabilities ${probabilities ? Object.entries(probabilities).map(([k, v]) => `${k} ${pct(v.probability)}`).join(", ") : "none"} (illustrative, from the command line; the production run has the model judge them).`, "");
lines.push("| Scenario | DCF | EV/EBITDA fwd | P/E fwd | Weighted | Probability |", "| --- | --- | --- | --- | --- | --- |");
for (const k of ["bear", "base", "bull"] as const) { const s = result.scenarios[k]; lines.push(`| ${k} | ${money(s.result.perShare)} | ${money(s.valuation?.methods.ev_ebitda_forward)} | ${money(s.valuation?.methods.pe_forward)} | ${money(s.valuation?.perShare)} | ${pct(s.probability)} |`); }
const ms = result.managementScenario;
if (ms) lines.push(`| management | ${money(ms.result.perShare)} | ${money(ms.valuation?.methods.ev_ebitda_forward)} | ${money(ms.valuation?.methods.pe_forward)} | ${money(ms.valuation?.perShare)} | ${pct(ms.probability)} |`);
lines.push("", `Range (weighted) ${money(result.range.low)} – ${money(result.range.base)} – ${money(result.range.high)}; expected ${money(result.range.expected)}; margin of safety on the base ${pct(result.range.marginOfSafety)}; expected upside ${pct(result.range.expectedUpside)}; base upside ${pct(result.range.baseUpside)}.`, "");
lines.push("| Method (base path) | Low | Base | High | Weight | Basis |", "| --- | --- | --- | --- | --- | --- |", ...(result.methods ?? []).map(x => `| ${x.label} | ${money(x.low)} | ${money(x.base)} | ${money(x.high)} | ${pct(x.weight)} | ${x.base != null ? x.basis : x.notes.join("; ")} |`), "");
if (result.managementComparison) lines.push(`Management comparison: ${result.managementComparison.rows.map(r => `year ${r.year} (FY${r.fiscalYear}) base ${(r.base / 1e9).toFixed(1)}B vs target ${(r.target / 1e9).toFixed(1)}B (${r.gap >= 0 ? "+" : ""}${(r.gap * 100).toFixed(0)}%)`).join("; ")}.`, "");
lines.push("| Gate | Status | Detail |", "| --- | --- | --- |", ...(result.gates ?? []).map(g => `| ${g.key} | ${g.status} | ${g.detail} |`), "");
const out = lines.join("\n");
if (args.out) writeFileSync(args.out, out); else process.stdout.write(out);
if (args.json) writeFileSync(args.json, JSON.stringify({ request, result }, null, 1));
