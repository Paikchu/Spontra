import type { Fact } from './parser.ts';
import type { IncomeCalculation } from './calculation.ts';

/**
 * From operating income to net income, in the filing's own arithmetic: which total is income before taxes, and which
 * signed lines the statement places after income taxes (equity-method results, noncontrolling interests, discontinued
 * operations). Code here names no company and no line beyond the four anchors (revenue, operating income, income
 * taxes, net income); the rest comes from the filing's calculation linkbase, from its statement rows, or from a
 * structure a model proposed and these same checks accepted on an earlier filing. Every structure is used only when
 * the reported facts balance it exactly: net = pretax − tax + Σ weight × line.
 */
export type BridgeStructure = { pretax: string | null; afterTax: Array<{ concept: string; weight: 1 | -1 }> };
export type BridgeSource = 'calculation' | 'statement' | 'profile';
export type BridgeAnchors = { revenue: Fact | null; operating: Fact | null; tax: Fact; net: Fact };
export type ResolvedBridge = {
  source: BridgeSource;
  structure: BridgeStructure;
  /** The reported pretax fact, or null when the pretax total is the sum of the lines the calculation places under it. */
  pretax: { value: number; fact: Fact | null; operands: Array<{ fact: Fact; weight: 1 | -1 }> };
  afterTax: Array<{ fact: Fact; weight: 1 | -1; value: number }>;
};

const local = (concept: string) => concept.split(':').at(-1)!;
const same = (a: string, b: string) => local(a) === local(b);
export const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, Math.max(Math.abs(a), Math.abs(b)) * 1e-9);

/** A short, stable name for a structure: two filings with the same structure share it, a changed structure gets a new one. */
export function structureKey(structure: BridgeStructure): string {
  const text = JSON.stringify([structure.pretax && local(structure.pretax), [...structure.afterTax].map(a => `${a.weight}${local(a.concept)}`).sort()]);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0; h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0; }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * The structure the calculation linkbase declares. The path from the net income total down to the total income taxes
 * are summed into gives each node its sign toward net income; at the tax node, the one positive child whose subtree
 * holds operating income (revenue when the statement has no operating line) is income before taxes, and every other
 * line hanging off that path is a line after taxes. Null when the tree does not reach the anchors, or when it has no
 * pretax total of its own (operating income sits directly beside the taxes): then which lines come before taxes is a
 * question for the statement rows.
 */
export function structureFromCalculation(calculation: IncomeCalculation | null | undefined, anchors: BridgeAnchors): BridgeStructure | null {
  if (!calculation) return null;
  const children = (node: string) => calculation.arcs.filter(a => a.parent === node).sort((a, b) => a.order - b.order);
  const arcOf = (child: string) => calculation.arcs.find(a => a.child === child);
  const concepts = new Set([calculation.root, ...calculation.arcs.flatMap(a => [a.parent, a.child])]);
  const net = [...concepts].find(c => same(c, anchors.net.tag));
  const taxArc = calculation.arcs.find(a => same(a.child, anchors.tax.tag));
  if (!net || !taxArc) return null;
  const path: string[] = [];
  for (let node: string | undefined = taxArc.parent, guard = 0; node && guard < 30; guard++) {
    path.unshift(node);
    if (node === net) break;
    node = arcOf(node)?.parent;
  }
  if (path[0] !== net) return null;
  const sign = new Map<string, 1 | -1>([[net, 1]]);
  for (let i = 1; i < path.length; i++) sign.set(path[i], (sign.get(path[i - 1])! * arcOf(path[i])!.weight) as 1 | -1);
  const taxNode = path.at(-1)!;
  if (sign.get(taxNode)! * taxArc.weight !== -1) return null;
  const target = anchors.operating?.tag ?? anchors.revenue?.tag;
  if (!target) return null;
  const holds = (node: string, guard = 0): boolean => same(node, target) || (guard < 30 && children(node).some(a => holds(a.child, guard + 1)));
  const pretax = children(taxNode).filter(a => a !== taxArc && sign.get(taxNode)! * a.weight === 1 && holds(a.child));
  if (pretax.length !== 1 || same(pretax[0].child, target)) return null;
  const afterTax: BridgeStructure['afterTax'] = [];
  for (let i = 0; i < path.length; i++) {
    for (const arc of children(path[i])) {
      if (arc.child === path[i + 1] || arc === taxArc || arc === pretax[0]) continue;
      afterTax.push({ concept: arc.child, weight: (sign.get(path[i])! * arc.weight) as 1 | -1 });
    }
  }
  return { pretax: pretax[0].child, afterTax };
}

/** The pretax total's own lines in the calculation, when every one is reported: the pretax value without a pretax fact. */
export function pretaxOperands(calculation: IncomeCalculation | null | undefined, pretax: string | null, pick: (concept: string) => Fact | undefined): Array<{ fact: Fact; weight: 1 | -1 }> | null {
  if (!calculation || !pretax) return null;
  const lines = calculation.arcs.filter(a => a.parent === pretax);
  const facts = lines.map(a => ({ fact: pick(a.child), weight: a.weight }));
  return lines.length && facts.every(f => f.fact) ? facts as Array<{ fact: Fact; weight: 1 | -1 }> : null;
}

/** Statement rows of one document, in printed order, one fact per row. */
function statementRows(facts: Fact[], anchor: Fact): Fact[] {
  const byOrder = new Map<number, Fact>();
  for (const f of facts) {
    if (!f.statementRow || Object.keys(f.dimensions).length || f.source.url !== anchor.source.url) continue;
    const old = byOrder.get(f.statementRow.order);
    if (!old || f.precision > old.precision) byOrder.set(f.statementRow.order, f);
  }
  return [...byOrder].sort((a, b) => a[0] - b[0]).map(([, f]) => f);
}
const PRETAX_LABEL = /\bbefore\s+(?:the\s+)?(?:provision\s+for\s+|benefit\s+from\s+|\(?provision\)?\s+)?(?:income\s+)?tax|\bpre-?tax\b/i;
const SUBTOTAL_LABEL = /^total\b|\bnet\s+(?:income|earnings|loss|\(loss\))|including\s+non-?controlling/i;

/**
 * The structure the statement rows print: the last row before the income-tax row that is labelled (or tagged) as income
 * before taxes, and the rows between the income-tax row and the net income row (subtotals excluded). A row's sign is
 * not printed reliably, so each combination of signs is tried and the one that balances is kept; more than one, or a
 * statement with more than six such rows, gives null.
 */
export function structureFromStatement(facts: Fact[], anchors: BridgeAnchors): BridgeStructure | null {
  const rows = statementRows(facts, anchors.net);
  const taxAt = rows.findIndex(f => same(f.tag, anchors.tax.tag)), netAt = rows.findIndex((f, i) => i > taxAt && same(f.tag, anchors.net.tag));
  if (taxAt < 0 || netAt < 0) return null;
  const operatingAt = anchors.operating ? rows.findIndex(f => same(f.tag, anchors.operating!.tag)) : -1;
  const pretaxRow = rows.slice(Math.max(0, operatingAt + 1), taxAt).findLast(f => /BeforeIncomeTax/i.test(local(f.tag)) || PRETAX_LABEL.test(f.statementRow!.label));
  const lines = rows.slice(taxAt + 1, netAt).filter(f => !SUBTOTAL_LABEL.test(f.statementRow!.label));
  if (lines.length > 6 || (!pretaxRow && lines.length)) return null;
  const pretax = pretaxRow?.value ?? anchors.net.value + anchors.tax.value;
  const fits: BridgeStructure[] = [];
  for (let mask = 0; mask < 1 << lines.length; mask++) {
    const weights = lines.map((_, i) => (mask >> i & 1 ? -1 : 1) as 1 | -1);
    if (near(pretax - anchors.tax.value + lines.reduce((sum, f, i) => sum + weights[i] * f.value, 0), anchors.net.value)) fits.push({ pretax: pretaxRow?.tag ?? null, afterTax: lines.map((f, i) => ({ concept: f.tag, weight: weights[i] })) });
  }
  return fits.length === 1 ? fits[0] : null;
}

/**
 * Resolves a structure against one period's consolidated facts and accepts it only when it balances exactly. A line the
 * structure names but the period does not report counts as zero (filings omit a nil line); income before taxes is the
 * reported total, or the sum of its calculation lines when only those are reported.
 */
export function applyStructure(structure: BridgeStructure, source: BridgeSource, anchors: BridgeAnchors, pick: (concept: string) => Fact | undefined, calculation?: IncomeCalculation | null): ResolvedBridge | null {
  const afterTax = structure.afterTax.flatMap(a => { const fact = pick(a.concept); return fact ? [{ fact, weight: a.weight, value: a.weight * fact.value }] : []; });
  const reported = structure.pretax ? pick(structure.pretax) ?? null : null;
  let pretax: ResolvedBridge['pretax'];
  if (reported) pretax = { value: reported.value, fact: reported, operands: [] };
  else {
    const operands = pretaxOperands(calculation, structure.pretax, pick);
    if (operands) pretax = { value: operands.reduce((sum, o) => sum + o.weight * o.fact.value, 0), fact: null, operands };
    // Without a pretax total, a statement whose only lines after operating income are taxes reads pretax as net + taxes.
    else if (!structure.afterTax.length) pretax = { value: anchors.net.value + anchors.tax.value, fact: null, operands: [{ fact: anchors.net, weight: 1 }, { fact: anchors.tax, weight: 1 }] };
    else return null;
  }
  const total = pretax.value - anchors.tax.value + afterTax.reduce((sum, a) => sum + a.value, 0);
  return near(total, anchors.net.value) ? { source, structure, pretax, afterTax } : null;
}

/**
 * From operating income to income before taxes, in the filing's own arithmetic: the signed lines (interest, investment
 * gains, equity-method results, other income) that close pretax = operating + Σ weight × line. Like the after-tax
 * structure, it comes from the calculation linkbase or from the statement rows and is used only where the reported facts
 * balance it exactly; a line a period does not report counts as zero.
 */
export type OtherStructure = { source: 'calculation' | 'statement'; lines: Array<{ concept: string; weight: 1 | -1 }> };
export type OtherLine = { fact: Fact; weight: 1 | -1; value: number };
/** One period as the other-income lines are checked against it. */
export type OtherPeriod = { pick: (concept: string) => Fact | undefined; operating: Fact; pretax: Fact };

/**
 * The lines the calculation hangs beside operating income on its way up to the pretax total, each signed toward it:
 * the subtotals among them opened into their own lines first, then as the subtotals themselves.
 */
export function otherFromCalculation(calculation: IncomeCalculation | null | undefined, pretax: string, operating: string): OtherStructure[] {
  if (!calculation) return [];
  const children = (node: string) => calculation.arcs.filter(a => a.parent === node).sort((a, b) => a.order - b.order);
  const top = [calculation.root, ...calculation.arcs.map(a => a.parent)].find(c => same(c, pretax));
  if (!top) return [];
  // The path from the pretax total down to operating income, with each node's sign toward the total.
  const path = (node: string, guard = 0): Array<{ node: string; weight: 1 | -1 }> | null => {
    if (same(node, operating)) return [];
    if (guard > 20) return null;
    for (const arc of children(node)) { const rest = path(arc.child, guard + 1); if (rest) return [{ node: arc.child, weight: arc.weight }, ...rest]; }
    return null;
  };
  const steps = path(top);
  if (!steps?.length) return [];
  const shallow: OtherStructure['lines'] = [];
  let parent = top, sign: 1 | -1 = 1;
  for (const step of steps) {
    for (const arc of children(parent)) if (arc.child !== step.node) shallow.push({ concept: arc.child, weight: (sign * arc.weight) as 1 | -1 });
    sign = (sign * step.weight) as 1 | -1;
    parent = step.node;
  }
  if (sign !== 1 || !shallow.length) return [];
  const open = (line: OtherStructure['lines'][number], guard = 0): OtherStructure['lines'] => {
    const below = children(line.concept);
    return !below.length || guard > 10 ? [line] : below.flatMap(a => open({ concept: a.child, weight: (line.weight * a.weight) as 1 | -1 }, guard + 1));
  };
  const deep = shallow.flatMap(l => open(l));
  return deep.length !== shallow.length ? [{ source: 'calculation', lines: deep }, { source: 'calculation', lines: shallow }] : [{ source: 'calculation', lines: shallow }];
}

/**
 * The rows the statement prints between operating income and income before taxes (subtotals excluded). A row's printed
 * sign is not reliable, so every combination of signs is tried against every period; the one combination that balances
 * all of them is kept, and none or several gives null. A row that is zero in every period takes no sign.
 */
export function otherFromStatement(facts: Fact[], periods: OtherPeriod[]): OtherStructure | null {
  if (!periods.length) return null;
  const { operating, pretax } = periods[0];
  const rows = statementRows(facts, operating);
  const from = rows.findIndex(f => same(f.tag, operating.tag)), to = rows.findIndex((f, i) => i > from && same(f.tag, pretax.tag));
  if (from < 0 || to < 0) return null;
  let lines = rows.slice(from + 1, to).filter(f => !/^total\b/i.test(f.statementRow!.label));
  // A printed net nonoperating total beside its own lines is their subtotal.
  if (lines.length > 1) lines = lines.filter(f => local(f.tag) !== 'NonoperatingIncomeExpense');
  if (!lines.length || lines.length > 8) return null;
  const values = periods.map(p => lines.map(f => p.pick(f.tag)?.value ?? 0));
  const silent = lines.map((_, i) => values.every(v => v[i] === 0));
  const fits = new Map<string, OtherStructure>();
  for (let mask = 0; mask < 1 << lines.length; mask++) {
    const weights = lines.map((_, i) => (silent[i] || !(mask >> i & 1) ? 1 : -1) as 1 | -1);
    if (!periods.every((p, k) => near(p.operating.value + values[k].reduce((sum, v, i) => sum + weights[i] * v, 0), p.pretax.value))) continue;
    fits.set(weights.join(), { source: 'statement', lines: lines.map((f, i) => ({ concept: f.tag, weight: weights[i] })) });
  }
  return fits.size === 1 ? [...fits.values()][0] : null;
}

/** A structure's lines in one period, when they balance operating income to income before taxes exactly. */
export function applyOther(structure: OtherStructure, period: OtherPeriod): OtherLine[] | null {
  const lines = structure.lines.flatMap(l => { const fact = period.pick(l.concept); return fact ? [{ fact, weight: l.weight, value: l.weight * fact.value }] : []; });
  if (!lines.length) return null;
  return near(period.operating.value + lines.reduce((sum, l) => sum + l.value, 0), period.pretax.value) ? lines : null;
}
