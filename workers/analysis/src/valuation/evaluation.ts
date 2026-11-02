import { z } from "zod";
import type { DiagnosticMetric } from "../../../../shared/analysis-contract/valuation.ts";
import { peerMultiplesOf } from "../../../../shared/analysis-runtime/valuation/calculator.ts";
import { readHistoryInput, type HistoryInput } from "../../../../shared/analysis-runtime/valuation/history.ts";
import { lifecycleOf } from "../../../../shared/analysis-runtime/valuation/prior.ts";
import { priceGuideOf } from "../../../../shared/analysis-runtime/valuation/price-guide.ts";
import { modelFor } from "../ai-config.ts";
import { requireDb } from "../core.ts";
import type { AnalysisEnv } from "../operations.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { sha256 } from "../sha256.ts";
import type { WorkflowStepLike } from "../workflow-core.ts";
import type { ValuationInput } from "./input.ts";
import type { FrozenResearchSource, ValuationState } from "./tools.ts";
import { researchValuation } from "./workflow.ts";

export function evaluationStatus(result: NonNullable<Awaited<ReturnType<typeof researchValuation>>>): "succeeded" | "insufficient" {
  return result.publication.reportStatus === "ready" && result.publication.model?.fairValueRange?.status === "available"
    && Object.values(result.phases).every(phase => phase === "finished") && result.nearTermForecast != null ? "succeeded" : "insufficient";
}

export type ValuationEvaluationParams = { ticker: string; evaluationId: string };
export const evaluationInputKey = (id: string) => `valuation:evaluation:input:${id}`;
export const evaluationResultKey = (id: string) => `valuation:evaluation:result:${id}`;
const paramsSchema = z.object({ ticker: z.string().regex(/^[A-Z][A-Z0-9.-]{0,11}$/), evaluationId: z.string().regex(/^[a-zA-Z0-9-]{1,90}$/) });
const envelopeSchema = z.object({ schemaVersion: z.literal("valuation-evaluation-input.v1"), chunks: z.array(z.string().regex(/^valuation:evaluation:chunk:[a-zA-Z0-9-]+:\d+$/)).min(1).max(100), inputSha256: z.string().regex(/^[a-f0-9]{64}$/) });

/** The research view deliberately excludes daily outcome series and all current database projections. */
export function historicalResearchInput(history: HistoryInput, inputSha256: string, producedAt: string): {
  input: ValuationInput; sources: FrozenResearchSource[]; market: Pick<ValuationState, "quote" | "riskFree" | "beta" | "peerMultiples" | "multipleHistory">;
} {
  const byId = new Map(history.sources.map(s => [s.id, s]));
  const fact = (id: string) => history.facts.find(f => f.id === id)?.value ?? null;
  const capex = fact("capex_ttm"), da = fact("da_ttm");
  const diagnostics: DiagnosticMetric[] = [{ key: "capexToDa", label: "Capex / depreciation and amortization", value: capex != null && da != null && da > 0 ? Math.abs(capex) / da : null, unit: "x", periodEnd: history.financialPeriodEnd, note: null }];
  const input: ValuationInput = {
    ticker: history.ticker, cik: null, companyName: history.ticker, currency: history.currency, financialPeriodEnd: history.financialPeriodEnd, incomeModel: "operating",
    facts: history.facts, distributions: [], diagnostics, documents: [], guidance: null, transcripts: [], missing: history.missing, fingerprint: inputSha256,
    rpo: null, lifecycle: lifecycleOf({ facts: history.facts, diagnostics }),
    peers: history.peers.map(peer => ({ ticker: peer.ticker, periodEnd: peer.periodEnd, ebitda: peer.ebitda, coreEarnings: peer.coreEarnings, netDebt: peer.netDebt, shares: peer.shares, weight: 1 })), peerBasis: "curated", peerNotes: history.limitations,
    management: history.management, managementNotes: history.management ? [] : ["No eligible management target set in this frozen snapshot."], trailingQuarters: [],
  };
  const quoteSource = byId.get(history.market.quote.sourceId)!;
  const rateSource = byId.get(history.market.riskFree.sourceId)!;
  const beta = history.market.beta;
  const sources: FrozenResearchSource[] = history.researchMaterials.map(material => {
    const source = byId.get(material.sourceId)!;
    return { sourceId: source.id, title: material.title, text: material.text, url: source.url, publishedAt: source.availableAt, form: source.accession ? "SEC filing" : "original source", kind: source.accession ? "sec" : "web" };
  });
  return {
    input, sources,
    market: {
      quote: { ...history.market.quote, currency: history.currency, source: quoteSource.id, sourceUrl: quoteSource.url, fetchedAt: producedAt, usable: true, limitations: [] },
      riskFree: { ...history.market.riskFree, label: "Frozen USD 10-year Treasury yield", sourceUrl: rateSource.url },
      beta: beta ? { beta: beta.value, observations: beta.observations, from: beta.from, to: beta.to, index: "S&P 500", sourceUrl: byId.get(beta.sourceIds[0]!)!.url } : null,
      peerMultiples: peerMultiplesOf(history.peers, history.cutoff.slice(0, 10), "curated"), multipleHistory: null,
    },
  };
}

/** An explicitly triggered evaluation is isolated from current reports, feature failure switches and publication events. */
export async function executeValuationEvaluation(rawParams: ValuationEvaluationParams, step: WorkflowStepLike, env: AnalysisEnv, runId: string) {
  const params = paramsSchema.parse(rawParams);
  const db = requireDb(env), store = new D1SecRepository(db);
  const producedAt = await step.do("evaluation-time", async () => new Date().toISOString());
  const prepared = await step.do("evaluation-input", async () => {
    const saved = await store.getCache<unknown>(evaluationInputKey(params.evaluationId));
    const envelope = envelopeSchema.parse(saved?.payload);
    const chunks = await Promise.all(envelope.chunks.map(async key => {
      const chunk = await store.getCache<unknown>(key);
      return z.string().max(60_000).parse(chunk?.payload);
    }));
    const inputJson = chunks.join("");
    if (inputJson.length > 1_900_000) throw new Error("Historical input exceeds the evaluation limit");
    if (await sha256(inputJson) !== envelope.inputSha256) throw new Error("Historical input hash mismatch");
    const history = readHistoryInput(JSON.parse(inputJson));
    if (history.ticker !== params.ticker || Date.parse(history.cutoff) > Date.parse(producedAt)) throw new Error("Historical input ticker or cutoff is invalid");
    for (const material of history.researchMaterials) if (await sha256(material.text) !== material.sha256) throw new Error(`Historical source text hash mismatch: ${material.sourceId}`);
    return { ...historicalResearchInput(history, envelope.inputSha256, producedAt), cutoff: history.cutoff, inputSha256: envelope.inputSha256, limitations: history.limitations };
  });
  const stage: WorkflowStepLike = {
    do: (name, work) => step.do(name, async (context) => {
      await store.setCache(evaluationResultKey(params.evaluationId), { status: "running", runId, stage: name, cutoff: prepared.cutoff, inputSha256: prepared.inputSha256, producedAt }, new Date().toISOString());
      return work(context);
    }),
  };
  try {
    const result = await researchValuation({ ...prepared, now: prepared.cutoff, generatedAt: producedAt, step: stage, env, mode: { kind: "snapshot", sources: prepared.sources }, runId });
    if (!result) throw new Error("Historical research did not finish");
    const shares = prepared.input.facts.find(f => f.id === result.request?.shares.basis.split(";")[0] && f.unit === "shares" && f.value === result.request?.shares.base);
    const artifact = result.request ? {
      schemaVersion: "valuation-history-assumptions.v1", kind: "agent_reconstruction", ticker: params.ticker, cutoff: prepared.cutoff, inputSha256: prepared.inputSha256,
      producedAt, model: modelFor(env, "valuation"), promptSha256: result.promptSha256, transcriptPath: evaluationResultKey(params.evaluationId), shareBasisFactId: shares?.id ?? "",
      request: result.request, evidence: result.registeredEvidence, operatingForecasts: result.nearTermForecast?.status === "available" ? result.nearTermForecast.forecasts : [],
    } : null;
    const output = {
      status: evaluationStatus(result), phases: result.phases, runId, producedAt, cutoff: prepared.cutoff, inputSha256: prepared.inputSha256,
      publication: result.publication, artifact, nearTermForecast: result.nearTermForecast, trace: result.turns, limitations: prepared.limitations,
      priceGuide: priceGuideOf({ report: result.publication, quote: result.publication.quote, asOf: prepared.cutoff }),
    };
    await step.do("evaluation-save", () => store.setCache(evaluationResultKey(params.evaluationId), output, producedAt));
    return { status: output.status, evaluationId: params.evaluationId, cutoff: prepared.cutoff, resultKey: evaluationResultKey(params.evaluationId) };
  } catch (error) {
    await store.setCache(evaluationResultKey(params.evaluationId), { status: "failed", runId, producedAt, cutoff: prepared.cutoff, inputSha256: prepared.inputSha256, error: error instanceof Error ? error.message : String(error) }, new Date().toISOString());
    throw error;
  }
}
