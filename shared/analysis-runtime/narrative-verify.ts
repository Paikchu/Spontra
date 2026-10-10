import type { ExplainerClaim } from "../analysis-contract/business-explainer.ts";
import { normalizeForMatch, quoteNumbers } from "./guidance.ts";

/**
 * The rule the narrative writer lives under: a number in a claim must be a number its cited
 * material states. Chinese prose writes amounts in 亿 and 万 and capacities in GW; the material
 * writes billions, millions and MW. Both are read into plain values and compared within one percent,
 * so "119 亿美元" matches "$11.9 billion" and "1.5 GW" matches "1,500 MW" or "1.5 GW". Years and
 * dates are not numbers to verify; neither are ordinals or footnote marks.
 */
const CLAIM_NUMBER = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(亿|万|千|百万|%|％|GW|MW|TW|个|块|家|座|股|倍)?/g;
const DATE_AFTER = /^\s*(年|月|日|季度|财年|FY|Q[1-4])/;
const SCALE: Record<string, number> = { "亿": 1e8, "万": 1e4, "千": 1e3, "百万": 1e6 };

/** Numbers a claim asserts, each as the set of values it could stand for. */
export function claimNumbers(text: string): number[][] {
  const out: number[][] = [];
  const source = text.normalize("NFKC");
  for (const m of source.matchAll(CLAIM_NUMBER)) {
    const raw = m[1].replace(/,/g, ""), unit = m[3] ?? "";
    const value = Number(`${raw}${m[2] ? `.${m[2]}` : ""}`);
    if (!Number.isFinite(value)) continue;
    const after = source.slice(m.index! + m[0].length);
    // A year, a date, a fiscal label or a footnote-style mark carries no quantity to check.
    if (DATE_AFTER.test(after) || /^(19|20)\d{2}$/.test(raw) && !unit) continue;
    if (/^[A-Za-z]/.test(after.trim()) && !unit && /^(?:K|k)\b/.test(after.trim())) continue;
    const values = [value];
    if (SCALE[unit]) values.push(value * SCALE[unit]);
    if (unit === "GW") values.push(value * 1000);
    if (unit === "TW") values.push(value * 1e6);
    if (unit === "%" || unit === "％") values.push(value / 100);
    out.push(values);
  }
  return out;
}

const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(Math.abs(b) * 0.01, 0.005);

/** The numbers a material states, in every reading `quoteNumbers` gives them (raw, scaled by billion/million, basis points). */
export function materialNumbers(text: string): number[] {
  const values = quoteNumbers(normalizeForMatch(text));
  // "1.5 GW" is also 1,500 MW; "850 MW" is also 0.85 GW.
  const extra: number[] = [];
  for (const m of text.normalize("NFKC").matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(GW|MW)/gi)) {
    const v = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(v)) extra.push(m[2].toUpperCase() === "GW" ? v * 1000 : v / 1000);
  }
  return [...values, ...extra];
}

/**
 * Every number the claim asserts must be stated by at least one of its cited materials. Returns the
 * numbers that no material supports; an empty list means the claim passes.
 */
export function unsupportedNumbers(claim: ExplainerClaim, numbersBySource: Map<string, number[]>): number[] {
  const pool = claim.sourceIds.flatMap(id => numbersBySource.get(id) ?? []);
  return claimNumbers(claim.text).flatMap(options => options.some(v => pool.some(p => near(p, v))) ? [] : [options[0]]);
}
