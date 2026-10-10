import { z } from "zod";
import { MILESTONE_STATES, NARRATIVE_GRADES, NARRATIVE_STAGES, NARRATIVE_STATUSES, PARTY_ROLES, type BusinessNarrative, type CompanyNarrative, type NarrativeCheck, type NarrativeFigure, type NarrativeLink, type PanelPlan } from "../analysis-contract/business-narrative.ts";
import type { ExplainerClaim } from "../analysis-contract/business-explainer.ts";
import { figureSchemas } from "./findings.ts";

const { ref, span, compare, claim, https } = figureSchemas;
const text = (max: number) => z.string().trim().min(1).max(max);
/** A day, a month, or a year alone when the material names no more. */
const date = z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/);
/** Prose bound to a resolved figure may not restate one: amounts, shares and rates come from the statements. */
const FIGURE = /[$¥€£]\s?\d|\d[\d,.]*\s?(%|％|percent|亿|万|千|百万|billion|million|bn\b|美元|元)/i;
const prose = (max: number) => text(max).refine(v => !FIGURE.test(v), "figures belong to the statements");
const status = z.enum(NARRATIVE_STATUSES);

const milestone = z.object({ id: text(80), date, label: text(28), state: z.enum(MILESTONE_STATES), originalDate: date.nullable().optional(), claim });
const party = z.object({ name: text(80), role: z.enum(PARTY_ROLES), claim });
const cell = z.object({ grade: z.enum(NARRATIVE_GRADES), claim });
const comparison = z.object({ need: text(80), dimensions: z.array(text(16)).min(1).max(6), self: z.array(cell).min(1).max(6), alternatives: z.array(z.object({ id: text(80), name: text(40), cells: z.array(cell).min(1).max(6) })).min(1).max(6) });
const tie = z.object({ ref, span, compare: compare.optional(), label: text(40).optional(), meaning: prose(200) });
const check = z.object({ id: text(80), condition: prose(120), status, ref: ref.optional(), span: span.optional(), compare: compare.optional(), claim: claim.nullable().optional() });
export const figureSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stack"), title: text(24), layers: z.array(z.object({ name: text(12), items: z.array(text(40)).max(8) })).min(1).max(6), meaning: prose(120) }),
  z.object({ type: z.literal("ladder"), title: text(24), tracks: z.array(z.object({ metricKey: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), role: z.enum(["actual", "contracted", "target"]) })).min(1).max(3), meaning: prose(120) }),
]);
const panelSpan = z.union([z.literal(1), z.literal(2)]).optional();
export const panelRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dossier"), span: panelSpan }),
  z.object({ kind: z.literal("flow"), span: panelSpan }), z.object({ kind: z.literal("cash"), span: panelSpan }), z.object({ kind: z.literal("balance"), span: panelSpan }),
  z.object({ kind: z.literal("revenue_trend"), span: panelSpan }), z.object({ kind: z.literal("metric"), key: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/), span: panelSpan }),
  z.object({ kind: z.literal("figure"), index: z.number().int().min(0).max(3), span: panelSpan }),
  z.object({ kind: z.literal("timeline"), span: panelSpan }), z.object({ kind: z.literal("parties"), span: panelSpan }), z.object({ kind: z.literal("comparison"), span: panelSpan }), z.object({ kind: z.literal("checks"), span: panelSpan }), z.object({ kind: z.literal("chain"), span: panelSpan }),
]);
export const panelPlanSchema = z.object({ panels: z.array(panelRefSchema).min(1).max(8), reason: prose(120) });
const link = z.object({ id: text(80), premise: prose(80), status, evidence: z.array(claim).max(6), failure: prose(120), checkIds: z.array(text(80)).max(6) });
const business = z.object({
  nodeId: text(200), name: text(80), parentNodeId: text(200).nullable().optional(),
  stage: z.enum(NARRATIVE_STAGES), stageClaim: claim, verdict: prose(90),
  anchor: z.object({ ref, span, label: text(24) }).nullable().optional(),
  capabilities: z.array(z.object({ label: text(24).nullable(), claim })).max(8),
  milestones: z.array(milestone).max(24), parties: z.array(party).max(16), comparison: comparison.nullable().optional(),
  ties: z.array(tie).max(8), chain: z.array(link).max(8), checks: z.array(check).max(8), figures: z.array(figureSchema).max(4).optional(), layout: panelPlanSchema.nullable().optional(),
});
/** The item schemas, for a writer that keeps the valid items of a draft and sends the rest back for repair. */
export const narrativeSchemas = { claim, milestone, party, cell, comparison, tie, check, link, panelPlan: panelPlanSchema, stage: z.enum(NARRATIVE_STAGES), status, verdict: prose(90), premise: prose(80), figureText: FIGURE } as const;
export const companyNarrativeSchema = z.object({
  schemaVersion: z.literal("business-narrative.v1"),
  ticker: z.string().regex(/^[A-Z][A-Z0-9.-]{0,11}$/),
  companyName: text(200), periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), generatedAt: z.string().max(40), model: text(80), fingerprint: text(128).optional(),
  positioning: claim, stage: z.enum(NARRATIVE_STAGES), stageClaim: claim, verdict: prose(90), industry: claim,
  chain: z.array(link).max(8), checks: z.array(check).max(10), figures: z.array(figureSchema).max(4).optional(), layout: panelPlanSchema.nullable().optional(),
  businesses: z.array(business).min(1).max(16),
  sources: z.array(z.object({ id: text(40), title: text(300), url: https, kind: z.enum(["sec", "web"]), publishedAt: z.string().max(40).nullable() })).min(1).max(60),
});

/**
 * A stack names only things the material carries: a business's capabilities, or the company's
 * businesses. Items named nothing go, layers left empty go, and a stack needs two layers. An item
 * may appear in one layer only; a later repeat is dropped. Ladders pass through: the page withholds
 * one whose metric keys resolve to fewer than two dates.
 */
export function harnessFigures(figures: NarrativeFigure[] | undefined, names: Set<string>): NarrativeFigure[] {
  const seen = new Set<string>();
  return (figures ?? []).flatMap((f): NarrativeFigure[] => {
    if (f.type !== "stack") return [f];
    const layers = f.layers.map(l => ({ ...l, items: l.items.filter(i => names.has(i) && !seen.has(i) && (seen.add(i), true)) })).filter(l => l.items.length);
    return layers.length >= 2 ? [{ ...f, layers }] : [];
  }).slice(0, 4);
}

/** A plan names only figures that exist and each panel once; a plan left with nothing opens on the flow. */
export function harnessLayout(plan: PanelPlan | null | undefined, figureCount: number): PanelPlan | null {
  if (!plan) return null;
  const seen = new Set<string>();
  const identity = (ref: PanelPlan["panels"][number]) => JSON.stringify({ ...ref, span: undefined });
  const panels = plan.panels.filter(ref => (ref.kind !== "figure" || ref.index < figureCount) && !seen.has(identity(ref)) && (seen.add(identity(ref)), true)).slice(0, 8);
  return { panels: panels.length ? panels : [{ kind: "flow" }], reason: plan.reason };
}

/**
 * Parses a narrative for one ticker, stripping unknown fields. Every claim must cite only sources the
 * document lists: an uncited milestone, party, capability or cell is dropped, a link keeps only its
 * cited evidence, and a link or check whose cross-references point nowhere loses them. A business
 * is dropped only when nothing verifiable is left; a document with no business is rejected.
 */
export function readCompanyNarrative(value: unknown, ticker: string): CompanyNarrative | null {
  const parsed = companyNarrativeSchema.safeParse(value);
  if (!parsed.success || parsed.data.ticker !== ticker) return null;
  const ids = new Set(parsed.data.sources.map(s => s.id));
  const cited = (c: ExplainerClaim | null | undefined): c is ExplainerClaim => !!c && c.sourceIds.every(id => ids.has(id));
  const checksOf = (checks: NarrativeCheck[]): NarrativeCheck[] => checks.flatMap(c => c.claim && !cited(c.claim) ? [{ ...c, claim: null }] : [c]);
  const linksOf = (links: NarrativeLink[], checks: NarrativeCheck[]): NarrativeLink[] => {
    const known = new Set(checks.map(c => c.id));
    return links.map(l => ({ ...l, evidence: l.evidence.filter(cited), checkIds: l.checkIds.filter(id => known.has(id)) }));
  };
  const companyChecks = checksOf(parsed.data.checks);
  const figuresOf = harnessFigures;
  const businesses = parsed.data.businesses.flatMap((b): BusinessNarrative[] => {
    if (!cited(b.stageClaim)) return [];
    const checks = checksOf(b.checks);
    const figures = figuresOf(b.figures, new Set(b.capabilities.filter(c => cited(c.claim)).flatMap(c => c.label ? [c.label] : [])));
    const comparison = b.comparison && b.comparison.self.length === b.comparison.dimensions.length && b.comparison.self.every(c => cited(c.claim))
      ? { ...b.comparison, alternatives: b.comparison.alternatives.filter(a => a.cells.length === b.comparison!.dimensions.length && a.cells.every(c => cited(c.claim))) }
      : null;
    return [{
      ...b, parentNodeId: b.parentNodeId ?? null, anchor: b.anchor ?? null,
      capabilities: b.capabilities.filter(c => cited(c.claim)),
      milestones: b.milestones.filter(m => cited(m.claim)).map(m => ({ ...m, originalDate: m.originalDate ?? null })),
      parties: b.parties.filter(p => cited(p.claim)),
      comparison: comparison?.alternatives.length ? comparison : null,
      // Links may cite the company's checks as well as the business's own.
      chain: linksOf(b.chain, [...checks, ...companyChecks]), checks,
      figures, layout: harnessLayout(b.layout, figures.length),
    }];
  });
  if (!businesses.length || !cited(parsed.data.positioning) || !cited(parsed.data.stageClaim) || !cited(parsed.data.industry)) return null;
  const figures = figuresOf(parsed.data.figures, new Set(businesses.map(b => b.name)));
  return { ...parsed.data, checks: companyChecks, chain: linksOf(parsed.data.chain, [...companyChecks, ...businesses.flatMap(b => b.checks)]), figures, layout: harnessLayout(parsed.data.layout, figures.length), businesses };
}
