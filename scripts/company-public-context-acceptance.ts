/** Scripted local tool journey; synthetic public/company evidence never leaves this process. No model calls. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { FrozenCompanyResearch, PublicReportVersion } from "../shared/analysis-contract/public-research.ts";
import { openComposer, registerSource } from "../workers/analysis/src/artifact/document.ts";
import { publicResearchTools, type ResearchContextState, type ResearchUse } from "../workers/analysis/src/company-research/context-tools.ts";
import { handPolicy } from "../workers/analysis/src/pi/hand-tools.ts";
import { runTool, type AnyTool } from "../workers/analysis/src/tools/registry.ts";
import { valuationPublicResearchGate, valuationPublicResearchTools } from "../workers/analysis/src/valuation/public-research.ts";
import type { ValuationState } from "../workers/analysis/src/valuation/tools.ts";
import type { AnalysisEnv } from "../workers/analysis/src/operations.ts";

const asOf = "2026-11-01T00:00:00.000Z";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const excerpt = "SYNTHETIC ACCEPTANCE MATERIAL: a short-term financing repricing channel; this is not market evidence.";
function report(reportId: string, type: PublicReportVersion["type"], industryId: string | null): PublicReportVersion {
  const claims = ["funding", "other-channel"].map(id => ({
    id, kind: "inference" as const, title: `Synthetic ${id}`, statement: "Synthetic financing can transmit to cash interest only when company contracts reprice.",
    sourceIds: ["source"], observationIds: [], premiseClaimIds: [], assumptions: ["Company contract terms must be checked"],
    impactChannels: ["Funding → contractual repricing → cash interest"], counterEvidence: ["Fixed-rate debt may not reprice"],
    verification: "Read the company's own contract terms", shockId: id === "funding" ? "shared-funding-shock" : `${reportId}-other`, financialVariable: "cashInterest",
  }));
  return {
    schemaVersion: "public-research.v1", reportId, type, title: `Synthetic ${reportId}`, language: "en",
    scope: { regions: ["US"], currency: "USD", industryId, description: "Synthetic acceptance scope" }, asOf, generatedAt: asOf, validUntil: "2099-01-01T00:00:00.000Z",
    inputFingerprint: hash(reportId), modelVersion: "no-model-called", promptVersion: "synthetic-v1", toolVersion: "synthetic-v1",
    coverage: "limited", missingInputs: ["Synthetic fixture is not production evidence"], changes: ["Synthetic initial version"], summary: "Synthetic context gate journey only.",
    sources: [{ id: "source", canonicalId: "synthetic-original", uri: "https://example.com/synthetic-public", title: "Synthetic source", locator: "paragraph 1", excerpt, contentHash: hash(excerpt), revision: "1", publishedAt: asOf, availableAt: asOf, collectedAt: asOf, observationPeriod: { start: "2026-11-01", end: "2026-11-01" }, usage: "public", authorization: "Synthetic acceptance only" }],
    observations: [], claims, dependencies: [], scenarios: [{ name: "base", assumptions: ["Contractual terms control cash interest"], claimIds: ["funding"] }],
    authorRunId: "synthetic-author", sections: [{ id: "funding", title: "Synthetic funding", claimIds: claims.map(claim => claim.id) }],
    version: "v1", publishedAt: asOf, supersedes: null, freshnessStatus: "valid", bodyMarkdown: "Synthetic local acceptance material only.",
    review: { mode: "automatic", reviewer: "synthetic-independent-reviewer", reviewedAt: asOf, authorRunId: "synthetic-author", claimChecks: claims.map(claim => ({ claimId: claim.id, supported: true, notes: "Synthetic fixture only" })), conclusion: "approved", notes: "Not a real financial review" },
    claimStates: Object.fromEntries(claims.map(claim => [claim.id, "valid" as const])),
  };
}
const frozen: FrozenCompanyResearch = {
  ticker: "SYNTHETIC", asOf, frozenAt: asOf, mappingVersions: [], gaps: [],
  reports: [report("synthetic-macro", "macro", null), report("synthetic-cloud", "industry", "cloud"), report("synthetic-energy", "industry", "energy")].map(value => ({ report: value, exposures: [], applicability: "requires_company_review" })),
};
const checks: Array<{ name: string; status: "passed"; detail?: unknown }> = [];
const calls: Array<{ name: string; error: boolean; observation: string }> = [];
function check(name: string, pass: unknown, detail?: unknown) {
  if (!pass) throw new Error(name);
  checks.push({ name, status: "passed", ...(detail === undefined ? {} : { detail }) });
}
async function invoke<S>(tools: AnyTool<S>[], state: S, name: string, input: Record<string, unknown>, expectError = false) {
  const outcome = await runTool(tools, handPolicy(tools), { name, input }, { state, signal: new AbortController().signal, recipe: "synthetic-company-context-journey", stage: async (_name, work) => work() });
  calls.push({ name, error: !!outcome.error, observation: outcome.observation.slice(0, 450) });
  if (!!outcome.error !== expectError) throw new Error(`${name}: ${outcome.observation}`);
  return outcome;
}
function harness(context: FrozenCompanyResearch | undefined) {
  const state: ResearchContextState = { composer: openComposer({ kind: "filing-report", ticker: frozen.ticker, subject: frozen.ticker, title: "Synthetic context journey", lang: "en" }) };
  const background = publicResearchTools<ResearchContextState>(context, "https://example.com");
  return { state, background, call: (name: string, input: Record<string, unknown>, expectError = false) => invoke(background.tools, state, name, input, expectError) };
}
function decision(index: number, value: ResearchUse["decision"], reason: string, overrides: Partial<ResearchUse> = {}): ResearchUse {
  const { report } = frozen.reports[index]!;
  return { reportId: report.reportId, version: report.version, claimId: "funding", decision: value, reason, companySources: [], financialVariable: "cashInterest", ...overrides };
}
const reasons = [
  "The synthetic company's existing debt has a fixed contractual coupon through 2030, so this short-term funding repricing channel does not change its existing cash interest.",
  "This synthetic company's cloud contracts have no funding-index pass-through clause, so the industry funding channel cannot determine its current cash interest.",
  "The synthetic company's power supply agreement fixes prices through 2030; an energy-industry repricing claim therefore does not alter this contract's cash interest.",
];
const readClaim = (journey: ReturnType<typeof harness>, index: number, claimId = "funding") => journey.call("read_public_research", { reportId: frozen.reports[index]!.report.reportId, claimId });

let networkCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { networkCalls++; throw new Error("Network is disabled for this local journey"); };
try {
  const legacy = harness(undefined);
  check("Undefined legacy checkpoint keeps its original information set without a new read requirement", legacy.background.precheck(legacy.state) === null);
  const legacyRead = await legacy.call("read_public_research", {});
  check("Legacy read explicitly reports unavailable without injecting current context", JSON.parse(legacyRead.observation).status === "unavailable" && !legacy.state.composer.researchContext);

  const gapsOnly: FrozenCompanyResearch = { ...frozen, reports: [], gaps: [{ kind: "industry", industryId: "cloud", reason: "uncovered" }] };
  const gaps = harness(gapsOnly);
  check("Coverage gaps must be read even when no public report exists", gaps.background.precheck(gaps.state) !== null);
  await gaps.call("read_public_research", {});
  check("Read no-report coverage gaps remains a legal publishable context", gaps.background.precheck(gaps.state) === null && gaps.state.composer.researchContext?.gaps[0]?.reason === "uncovered");

  const journey = harness(frozen);
  check("New frozen context cannot publish before reading", journey.background.precheck(journey.state) !== null);
  await journey.call("read_public_research", {});
  const directoryIssue = journey.background.precheck(journey.state);
  check("Reading only the public directory no longer bypasses applicability", directoryIssue?.includes("synthetic-macro") && !journey.state.researchUses?.length, directoryIssue);
  await journey.call("record_public_research_use", decision(0, "rejected", reasons[0]!), true);
  check("Recording an unread claim is rejected", !journey.state.researchUses?.length);
  await readClaim(journey, 0);
  check("Reading a claim without a decision remains blocked", journey.background.precheck(journey.state)?.includes("synthetic-macro"));
  await journey.call("record_public_research_use", decision(0, "rejected", "   "), true);
  check("A blank reason is refused by the real record tool", !journey.state.researchUses?.length);
  await journey.call("record_public_research_use", decision(0, "rejected", reasons[0]!));
  check("A macro decision does not cover the first industry report", journey.background.precheck(journey.state)?.includes("synthetic-cloud"));
  await readClaim(journey, 1);
  await journey.call("record_public_research_use", decision(1, "not_applicable", reasons[1]!));
  const missingSecondIndustry = journey.background.precheck(journey.state);
  check("Omitting the second industry report is refused", missingSecondIndustry?.includes("synthetic-energy"), missingSecondIndustry);
  await readClaim(journey, 2);
  await journey.call("record_public_research_use", decision(2, "rejected", reasons[2]!));
  check("One explicit rejection or non-applicability per report passes without forced adoption or assessing every claim", journey.background.precheck(journey.state) === null && journey.state.researchUses?.length === 3 && journey.state.researchUses.every(use => use.decision !== "adopted"));
  check("Pinned report decisions are retained in the report's research context", JSON.stringify(journey.state.composer.researchContext?.uses) === JSON.stringify(journey.state.researchUses));

  journey.state.composer.blocks.push({ id: "summary", title: "Synthetic context", html: "<h2>Synthetic context</h2><p>Only a local acceptance fixture.</p>", sources: ["public1c2"], state: "passed" });
  check("A report-level decision does not authorize a different cited claim", journey.background.precheck(journey.state)?.includes("synthetic-macro/other-channel"));
  await readClaim(journey, 0, "other-channel");
  await journey.call("record_public_research_use", decision(0, "not_applicable", "This separate synthetic channel depends on a floating-rate exposure that the company's fixed-rate contract does not have.", { claimId: "other-channel" }));
  check("The separately cited claim passes after its own explicit decision", journey.background.precheck(journey.state) === null);
  const wrongVersion = structuredClone(journey.state);
  wrongVersion.researchUses = wrongVersion.researchUses?.map(use => use.reportId === "synthetic-macro" ? { ...use, version: "old-version" } : use);
  check("A decision against another version cannot satisfy the frozen report gate", journey.background.precheck(wrongVersion)?.includes("synthetic-macro"));
  const blankCheckpoint = structuredClone(journey.state);
  blankCheckpoint.researchUses = blankCheckpoint.researchUses?.map(use => use.reportId === "synthetic-macro" ? { ...use, reason: " " } : use);
  check("Restored decisions with blank reasons cannot satisfy the report gate", journey.background.precheck(blankCheckpoint)?.includes("synthetic-macro"));

  const adoption = harness(frozen);
  await adoption.call("read_public_research", {});
  await readClaim(adoption, 0);
  await adoption.call("record_public_research_use", decision(0, "adopted", "Synthetic floating-rate borrowing reprices with this benchmark."), true);
  await adoption.call("record_public_research_use", decision(0, "adopted", "A public macro claim is not company contract evidence.", { companySources: ["public1c1"] }), true);
  await adoption.call("record_public_research_use", decision(0, "adopted", "An unregistered source is not company evidence.", { companySources: ["missing-company-source"] }), true);
  check("Adoption still rejects missing, public-only and unregistered company evidence", !adoption.state.researchUses?.length);
  registerSource(adoption.state.composer, "company-debt", { title: "Synthetic company floating-rate contract", url: "https://example.com/synthetic-company-debt", kind: "sec" });
  const adopted = decision(0, "adopted", "The synthetic company's floating-rate facility resets with this benchmark next quarter, transmitting to its cash interest.", { companySources: ["company-debt"] });
  await adoption.call("record_public_research_use", adopted);
  await adoption.call("record_public_research_use", { ...adopted, reason: `${adopted.reason} Contract evidence retained.` });
  check("Revising the same claim replaces its decision without duplicating it", adoption.state.researchUses?.length === 1);
  await readClaim(adoption, 1);
  const duplicate = await adoption.call("record_public_research_use", decision(1, "adopted", "This industry channel repeats the same funding shock for the same company cash-interest variable.", { companySources: ["company-debt"] }), true);
  check("The same macro/industry shock and financial variable cannot be adopted twice", duplicate.observation.includes("Duplicate shock") && adoption.state.researchUses?.length === 1, duplicate.observation);
  await adoption.call("record_public_research_use", decision(1, "rejected", "Its funding shock is already adopted once through the macro report; no second cash-interest impact is added.", { companySources: ["company-debt"] }));
  await readClaim(adoption, 2);
  await adoption.call("record_public_research_use", decision(2, "not_applicable", reasons[2]!));
  check("One evidenced adoption plus explicit decisions on other reports passes", adoption.background.precheck(adoption.state) === null && adoption.state.researchUses?.filter(use => use.decision === "adopted").length === 1);

  const staleContext = structuredClone(frozen);
  staleContext.reports[0]!.report.freshnessStatus = "stale";
  const stale = harness(staleContext);
  registerSource(stale.state.composer, "company-debt", adoption.state.composer.sources["company-debt"]!);
  await stale.call("read_public_research", {});
  await readClaim(stale, 0);
  await stale.call("record_public_research_use", adopted, true);
  check("Stale research still cannot be adopted even with company evidence", !stale.state.researchUses?.length);
  await stale.call("record_public_research_use", decision(0, "rejected", "The frozen report is stale; this task cannot use its claim to quantify the company's cash interest."));
  check("Stale coverage may be explicitly rejected without claiming adoption", stale.state.researchUses?.[0]?.decision === "rejected");

  const valuation: ValuationState = {
    publicResearch: frozen, input: { ticker: frozen.ticker, cik: null, companyName: "Synthetic company", currency: "USD", financialPeriodEnd: "2026-09-30", incomeModel: "synthetic", facts: [], distributions: [], diagnostics: [], documents: [], transcripts: [], missing: ["Synthetic acceptance only"], fingerprint: hash("synthetic-valuation"), rpo: null, lifecycle: "growth", peers: [], peerBasis: "none", peerNotes: [], management: null, managementNotes: [], trailingQuarters: [] },
    researchAsOf: asOf, now: asOf, quote: null, riskFree: null, beta: null, peerMultiples: null, multipleHistory: null, evidence: new Map(), hits: [],
    used: { finds: 0, reads: 0, searches: 0, webReads: 0, transcripts: 0 }, dimensions: new Map(), researchDone: false, calc: null, modelGaps: [], insufficient: null, assumptionsDone: false, redTeam: null, composed: null, cancelled: false,
  };
  const valuationTools = valuationPublicResearchTools({ BUSINESS_SITE_ORIGIN: "https://example.com" } as AnalysisEnv, frozen);
  await invoke(valuationTools, valuation, "read_public_research", {});
  check("Valuation uses the shared gate after a directory-only read", valuationPublicResearchGate(valuation) === directoryIssue);
  for (let i = 0; i < frozen.reports.length; i++) {
    await invoke(valuationTools, valuation, "read_public_research", { reportId: frozen.reports[i]!.report.reportId, claimId: "funding" });
    await invoke(valuationTools, valuation, "record_public_research_use", decision(i, i === 1 ? "not_applicable" : "rejected", reasons[i]!));
  }
  check("Valuation's real adapter passes the same per-report decisions", valuationPublicResearchGate(valuation) === null && valuation.evidence.size === 3);
  check("Valuation keeps exact frozen report versions for its registered public evidence", Object.values(valuation.publicEvidence ?? {}).every(evidence => evidence.version === "v1"));
  check("The entire local tool journey performed no network calls", networkCalls === 0);
  const output = resolve(process.argv[2] ?? "/tmp/spontra-company-public-context-gate.json");
  const evidence = {
    at: new Date().toISOString(), scope: "Actual runTool/handPolicy and valuation adapter/publication gate journey with synthetic frozen reports; no unit tests, model calls or production writes", modelCalls: 0, networkCalls, productionWrites: 0,
    ...(process.argv[3] ? { beforeFix: JSON.parse(readFileSync(resolve(process.argv[3]), "utf8")) as unknown } : {}), checks, calls,
    limitations: ["Semantic quality of a company-specific reason remains a model/content-review responsibility; the harness enforces a recorded non-empty decision", "No real report generation, deployment or production publication was performed", "Filing and analyst publish paths consume this shared precheck; their full content/render-review journeys were not rerun here"],
  };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify({ passed: checks.length, toolCalls: calls.length, modelCalls: 0, networkCalls, productionWrites: 0, evidence: output }));
} finally {
  globalThis.fetch = originalFetch;
}
