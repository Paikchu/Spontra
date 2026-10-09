import { z } from "zod";
import { SECTION_KINDS, type BusinessExplainer, type ExplainerClaim, type ExplainerSection, type ExplainerSectionKind, type ExplainerSectionLayout } from "../analysis-contract/business-explainer.ts";

const https = z.string().max(2000).refine(v => { try { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password; } catch { return false; } });
const text = (max: number) => z.string().trim().min(1).max(max);
const claim = z.object({ text: text(600), sourceIds: z.array(z.string().max(40)).min(1).max(6) });
/** Latin source names must be complete words, not a clipped prefix of a different name. */
export function completeProductName(name: string, passage: string): boolean {
  const needle = name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
  const source = passage.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
  let index = source.indexOf(needle);
  while (index >= 0) {
    const before = source[index - 1] ?? "", after = source[index + needle.length] ?? "";
    if (!(/[a-z0-9]/.test(needle[0] ?? "") && /[a-z0-9]/.test(before)) && !(/[a-z0-9]/.test(needle.at(-1) ?? "") && /[a-z0-9]/.test(after))) return true;
    index = source.indexOf(needle, index + 1);
  }
  return false;
}

export const SECTION_LIMITS = { sections: 6, items: 5, title: 10, label: 24, text: 300 } as const;
const DEFAULT_TITLE: Record<ExplainerSectionKind, string> = {
  delivery: "怎么交付", customers: "客户", monetization: "收费方式", lifecycle: "客户周期", channel: "销售渠道", economics: "成本结构", relation: "关联业务", other: "运营要点",
};
/** Amounts, shares and growth rates belong to the SEC flow, never to model prose. */
const FIGURE = /[$¥€£]\s?\d|\d[\d,.]*\s?(%|％|percent|亿|万|千|百万|billion|million|bn\b|美元|元)/i;
const compact = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const length = (value: string) => [...value].length;

export type SectionCandidate = { kind: unknown; title: unknown; layout: unknown; items: Array<{ label: unknown; claim: ExplainerClaim | null }> };

/**
 * The harness every model-chosen section passes, both when written and when read back: a known kind
 * at most once (except `other`), a short unique title, a layout its items can actually fill, cited
 * items without figures or repeats, and fixed caps. What fails is removed, never repaired by guessing.
 */
export function harnessSections(candidates: SectionCandidate[]): ExplainerSection[] {
  const sections: ExplainerSection[] = [];
  const kinds = new Set<ExplainerSectionKind>(), titles = new Set<string>(), texts = new Set<string>();
  for (const candidate of candidates.slice(0, 12)) {
    if (sections.length >= SECTION_LIMITS.sections) break;
    const kind: ExplainerSectionKind = SECTION_KINDS.includes(candidate.kind as ExplainerSectionKind) ? candidate.kind as ExplainerSectionKind : "other";
    if (kind !== "other" && kinds.has(kind)) continue;
    const items = candidate.items.flatMap(({ label, claim }) => {
      if (!claim || FIGURE.test(claim.text) || length(claim.text) > SECTION_LIMITS.text) return [];
      const key = compact(claim.text);
      if (!key || texts.has(key)) return [];
      texts.add(key);
      const name = typeof label === "string" ? label.trim() : "";
      return [{ label: name && length(name) <= SECTION_LIMITS.label && !FIGURE.test(name) ? name : null, claim }];
    }).slice(0, SECTION_LIMITS.items);
    if (!items.length) continue;
    const requested: ExplainerSectionLayout = candidate.layout === "steps" || candidate.layout === "list" ? candidate.layout : "prose";
    // A chain needs at least two steps; named entries need names.
    const layout = requested === "steps" && items.length < 2 ? "prose" : requested === "list" && !items.every(i => i.label) ? "prose" : requested;
    const raw = typeof candidate.title === "string" ? candidate.title.trim().replace(/[：:。.，,、！!？?\s]+$/u, "") : "";
    const title = [raw, DEFAULT_TITLE[kind]].find(t => length(t) >= 2 && length(t) <= SECTION_LIMITS.title && !FIGURE.test(t) && !titles.has(compact(t)));
    if (!title) continue;
    kinds.add(kind); titles.add(compact(title));
    sections.push({ id: `section-${sections.length + 1}`, kind, title, layout, items });
  }
  return sections;
}

const sectionInput = z.object({
  kind: z.string().max(40), title: z.string().max(40), layout: z.string().max(20),
  items: z.array(z.object({ label: z.string().max(80).nullable(), claim })).max(10),
});
const explanation = z.object({
  nodeId: text(200), name: text(200), summary: claim.nullable(), products: z.array(text(80)).max(10),
  offerings: z.array(z.object({ id: text(80), name: text(80), line: text(80).nullable(), description: claim, membership: claim.optional(), charging: claim.nullable(), sourceIds: z.array(text(40)).min(1).max(6) })).max(8).optional(),
  sections: z.array(sectionInput).max(10).optional(),
  // Documents written before sections carried four fixed fields; they are read as sections.
  howItWorks: claim.nullable().optional(), customers: claim.nullable().optional(), monetization: claim.nullable().optional(), relation: claim.nullable().optional(),
});
export const businessExplainerSchema = z.object({
  schemaVersion: z.literal("business-explainer.v1"),
  ticker: z.string().regex(/^[A-Z][A-Z0-9.-]{0,11}$/),
  companyName: text(200), generatedAt: z.string().max(40), model: text(80), fingerprint: text(128),
  businesses: z.array(explanation).min(1).max(24),
  sources: z.array(z.object({ id: text(40), title: text(300), url: https, kind: z.enum(["sec", "web"]), publishedAt: z.string().max(40).nullable() })).min(1).max(40),
});

/**
 * Parses an explainer for one ticker, stripping unknown fields. Every claim must cite only sources
 * listed in the same document; a claim citing anything else is dropped, an explanation left with no
 * summary, section or product is dropped, and a document with nothing left is rejected rather than shown empty.
 */
export function readBusinessExplainer(value: unknown, ticker: string): BusinessExplainer | null {
  const parsed = businessExplainerSchema.safeParse(value);
  if (!parsed.success || parsed.data.ticker !== ticker) return null;
  const ids = new Set(parsed.data.sources.map(s => s.id));
  const valid = (c: { text: string; sourceIds: string[] } | null) => c && c.sourceIds.every(id => ids.has(id)) ? c : null;
  const businesses = parsed.data.businesses.flatMap(({ howItWorks, customers, monetization, relation, sections, ...b }) => {
    const offerings = b.offerings?.filter(p => valid(p.description) && valid(p.membership ?? null) && completeProductName(p.name, p.membership!.text) && p.sourceIds.every(id => ids.has(id))).map(p => ({ ...p, line: p.line?.toLowerCase() === p.name.toLowerCase() ? null : p.line, charging: valid(p.charging) }));
    const legacy: SectionCandidate[] = [
      ...(offerings?.length ? [] : [{ kind: "delivery", title: "产品介绍", layout: "prose", items: [{ label: null, claim: howItWorks ?? null }] }]),
      { kind: "customers", title: "客户", layout: "prose", items: [{ label: null, claim: customers ?? null }] },
      { kind: "monetization", title: "收费方式", layout: "prose", items: [{ label: null, claim: monetization ?? null }] },
      { kind: "relation", title: "关联业务", layout: "prose", items: [{ label: null, claim: relation ?? null }] },
    ];
    const candidates: SectionCandidate[] = sections ?? legacy;
    const kept = harnessSections(candidates.map(s => ({ ...s, items: s.items.map(i => ({ label: i.label, claim: valid(i.claim) })) })));
    const summary = valid(b.summary);
    return summary || kept.length || offerings?.length ? [{ ...b, summary, offerings, sections: kept }] : [];
  });
  return businesses.length ? { ...parsed.data, businesses } : null;
}
