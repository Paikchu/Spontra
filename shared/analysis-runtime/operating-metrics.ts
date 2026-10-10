import { z } from "zod";
import { OPERATING_ROLES, OPERATING_UNITS, type OperatingMetric, type OperatingMetricsPublication, type OperatingObservation } from "../analysis-contract/operating-metrics.ts";
import { normalizeForMatch, quoteNumbers } from "./guidance.ts";
import { figureSchemas } from "./findings.ts";

const text = (max: number) => z.string().trim().min(1).max(max);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const observation = z.object({ asOf: date, value: z.number().finite(), basis: z.enum(["point", "period"]), quote: text(300), sourceId: text(40) });
const metric = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), label: text(16), unit: z.enum(OPERATING_UNITS), role: z.enum(OPERATING_ROLES), pairWith: z.string().max(42).nullable().optional(),
  subject: text(80), observations: z.array(observation).max(40),
});
export const operatingMetricsSchema = z.object({
  schemaVersion: z.literal("operating-metrics.v1"),
  ticker: z.string().regex(/^[A-Z][A-Z0-9.-]{0,11}$/), generatedAt: z.string().max(40), model: text(80),
  metrics: z.array(metric).max(40),
  sources: z.array(z.object({ id: text(40), title: text(300), url: figureSchemas.https, kind: z.enum(["sec", "web"]), publishedAt: z.string().max(40).nullable() })).min(1).max(60),
});

/** Numbers as a reader writes them: the stated value, or the value in GW when the unit is MW and the text says GW. */
export function numberSupported(value: number, quote: string, unit: OperatingMetric["unit"]): boolean {
  const numbers = quoteNumbers(quote);
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(Math.abs(b) * 0.005, 0.0001);
  return numbers.some(n => near(n, value) || (unit === "MW" && near(n * 1000, value)) || (unit === "count" && (near(n * 1000, value) || near(n * 1_000_000, value))));
}

/**
 * The deterministic acceptance the extractor applies to each model-written observation: the quote
 * is verbatim in the source, and the number is in the quote. Nothing is repaired by guessing.
 */
export function verifyObservation(observation: OperatingObservation, unit: OperatingMetric["unit"], normalizedSource: string): string[] {
  const issues: string[] = [];
  if (/\[\.\.\.\]/.test(observation.quote) || !normalizedSource.includes(normalizeForMatch(observation.quote))) issues.push("quote is not verbatim from the source");
  if (!numberSupported(observation.value, observation.quote, unit)) issues.push("value does not appear in the quote");
  if (unit === "percent" && (observation.value < -100 || observation.value > 1000)) issues.push("percent out of range");
  if (unit !== "percent" && observation.value < 0) issues.push("a quantity cannot be negative");
  return issues;
}

/**
 * Parses a publication for one ticker, stripping unknown fields. An observation citing a source the
 * document does not list is dropped, one date keeps a single observation per metric (the later
 * source wins), a metric with no observation is dropped, and an empty document reads as none.
 */
export function readOperatingMetrics(value: unknown, ticker: string): OperatingMetricsPublication | null {
  const parsed = operatingMetricsSchema.safeParse(value);
  if (!parsed.success || parsed.data.ticker !== ticker) return null;
  const ids = new Set(parsed.data.sources.map(s => s.id));
  const order = new Map(parsed.data.sources.map((s, i) => [s.id, i]));
  const keys = new Set(parsed.data.metrics.map(m => m.key));
  const metrics = parsed.data.metrics.flatMap((m): OperatingMetric[] => {
    const byDate = new Map<string, OperatingObservation>();
    for (const o of m.observations) {
      if (!ids.has(o.sourceId)) continue;
      const held = byDate.get(o.asOf);
      if (!held || (order.get(o.sourceId) ?? 0) >= (order.get(held.sourceId) ?? 0)) byDate.set(o.asOf, o);
    }
    const observations = [...byDate.values()].sort((a, b) => a.asOf.localeCompare(b.asOf));
    return observations.length ? [{ ...m, pairWith: m.pairWith && keys.has(m.pairWith) && m.pairWith !== m.key ? m.pairWith : null, observations }] : [];
  });
  return metrics.length ? { ...parsed.data, metrics } : null;
}

/** `1.5 GW`, `850 MW`, `43`, `300,000`, `12%`. */
export function formatOperating(value: number, unit: OperatingMetric["unit"]): string {
  if (unit === "MW") return value >= 1000 ? `${Number((value / 1000).toFixed(value >= 10_000 ? 0 : 1))} GW` : `${Number(value.toFixed(0))} MW`;
  if (unit === "percent") return `${Number(value.toFixed(1))}%`;
  return Math.round(value).toLocaleString("en-US");
}
