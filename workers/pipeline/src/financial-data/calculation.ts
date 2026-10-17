import { D1SecRepository } from '../sec/d1.ts';

/**
 * A filing's own arithmetic for its income statement, as its calculation linkbase declares it: each line's parent
 * total and the weight it enters that total with. EDGAR renders every XBRL filing's linkbases into one
 * `MetaLinks.json` beside the documents (member-labels.ts reads the labels from the same file), so the structure
 * comes from the issuer, never from a list of concept names kept here.
 */
export const CALCULATION_VERSION = 'calculation.v2';
const cacheKey = (accession: string) => `sec:calculation:v2:${accession}`;

/** One summation arc: `child` enters `parent` with `weight` (+1 or −1), at `order` among its siblings. */
export type CalculationArc = { parent: string; child: string; weight: 1 | -1; order: number };
/** The income statement's calculation tree: its root total and every arc under it, concepts as `prefix:Local`. */
export type IncomeCalculation = { role: string; title: string; root: string; arcs: CalculationArc[]; labels: Record<string, string> };
/**
 * How a filing reconciles its revenue disclosures, from the same file. `arcs`: every summation under a revenue total,
 * in any role; a segment note declaring Revenues = RevenueFromContractWithCustomer + RevenueNotFromContractWithCustomer
 * says the segment split, reported in the first, reaches consolidated revenue only with the second (Alphabet's hedging
 * gains). `members`: the tables (presentation roles showing a revenue total) each dimension member is shown in; the
 * members one table shows are one split of revenue, and one axis shown in two tables is two splits (Autodesk shows
 * subscription and other on its statement, product families in its revenue note).
 */
export type RevenueStructure = { arcs: Array<{ role: string; parent: string; child: string; weight: 1 | -1 }>; labels: Record<string, string>; members: Record<string, string[]> };
export type StoredCalculation = { version: string; accession: string; calculation: IncomeCalculation | null; revenue: RevenueStructure | null };

type MetaRole = { parentTag?: unknown; weight?: unknown; order?: unknown; root?: unknown };
type MetaTag = { calculation?: Record<string, MetaRole>; presentation?: unknown; lang?: Record<string, { role?: { terseLabel?: unknown; label?: unknown } }> };
type MetaReport = { role?: unknown; shortName?: unknown; longName?: unknown; groupType?: unknown; order?: unknown };
type MetaLinks = { instance?: Record<string, { tag?: Record<string, MetaTag>; report?: Record<string, MetaReport> }> };

/** `prefix_Local` → `prefix:Local`, the form an instance document names a concept in. */
const qname = (key: string) => { const i = key.indexOf('_'); return i > 0 ? `${key.slice(0, i)}:${key.slice(i + 1)}` : key; };
const local = (concept: string) => concept.split(':').at(-1)!;
/** The totals an income statement ends on; a role rooted elsewhere is a cash-flow, comprehensive-income or segment table. */
export const NET_ROOTS = ['NetIncomeLoss', 'ProfitLoss', 'IncomeLossFromContinuingOperations', 'NetIncomeLossAvailableToCommonStockholdersBasic'];
const STATEMENT_TITLE = /\b(?:operations|income|earnings|loss)\b/i;
const NOT_INCOME = /\b(?:cash flows?|balance sheets?|stockholders|shareholders|equity|parenthetical|segment)\b/i;
const clean = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
/** The concepts revenue is totalled in, consolidated or by segment; everything between them comes from the filing. */
export const REVENUE_TOTALS = ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet', 'RevenuesNetOfInterestExpense'];
const labelOf = (tag: MetaTag) => { const roles = tag.lang?.['en-us']?.role ?? tag.lang?.['en']?.role; return clean(roles?.terseLabel) || clean(roles?.label); };
/** A table's name: the last segment of its role URI, unique within a filing. */
export const tableName = (role: string) => role.split('/').at(-1)!;

/**
 * The income statement's calculation tree from a filing's `MetaLinks.json`: in the first statement role (as EDGAR
 * orders them) titled for operations, income or earnings, the topmost net-income total that sums other lines. A
 * statement that combines operations and comprehensive income roots its tree at comprehensive income; the net income
 * total inside it is the root taken. Null when the filing declares none; the caller then reads the statement rows.
 */
export function parseIncomeCalculation(json: unknown): IncomeCalculation | null {
  for (const instance of Object.values((json as MetaLinks | null)?.instance ?? {})) {
    const reports = Object.values(instance?.report ?? {})
      .filter(r => r.groupType === 'statement' && typeof r.role === 'string')
      .map(r => ({ role: r.role as string, title: clean(r.shortName) || clean(r.longName), order: Number(r.order) || 0 }))
      .filter(r => STATEMENT_TITLE.test(r.title) && !NOT_INCOME.test(r.title))
      .sort((a, b) => a.order - b.order);
    const tags = instance?.tag ?? {};
    for (const report of reports) {
      const arcs: CalculationArc[] = [];
      const labels: Record<string, string> = {};
      for (const [key, tag] of Object.entries(tags)) {
        const entry = tag?.calculation?.[report.role];
        if (!entry) continue;
        const concept = qname(key);
        const label = labelOf(tag);
        if (label) labels[concept] = label;
        const weight = Number(entry.weight);
        if (entry.root === true || typeof entry.parentTag !== 'string' || (weight !== 1 && weight !== -1)) continue;
        arcs.push({ parent: qname(entry.parentTag), child: concept, weight: weight as 1 | -1, order: Number(entry.order) || 0 });
      }
      const parentOf = new Map(arcs.map(a => [a.child, a.parent]));
      const totals = [...new Set(arcs.map(a => a.parent))].filter(c => NET_ROOTS.includes(local(c)));
      const ancestorIsTotal = (c: string) => { for (let p = parentOf.get(c), guard = 0; p && guard < 50; p = parentOf.get(p), guard++) if (totals.includes(p)) return true; return false; };
      const root = totals.find(c => !ancestorIsTotal(c));
      if (root) return { role: report.role, title: report.title, root, arcs, labels };
    }
  }
  return null;
}

/** The revenue reconciliations and tables a filing's `MetaLinks.json` declares (see RevenueStructure); null when it has none. */
export function parseRevenueStructure(json: unknown): RevenueStructure | null {
  const arcs: RevenueStructure['arcs'] = [], labels: Record<string, string> = {}, members: Record<string, string[]> = {};
  for (const instance of Object.values((json as MetaLinks | null)?.instance ?? {})) {
    const tags = Object.entries(instance?.tag ?? {});
    const byRole = new Map<string, Array<{ parent: string; child: string; weight: 1 | -1 }>>();
    for (const [key, tag] of tags) for (const [role, entry] of Object.entries(tag?.calculation ?? {})) {
      const weight = Number(entry?.weight);
      if (typeof entry?.parentTag !== 'string' || (weight !== 1 && weight !== -1)) continue;
      byRole.set(role, [...(byRole.get(role) ?? []), { parent: qname(entry.parentTag), child: qname(key), weight: weight as 1 | -1 }]);
    }
    // Each role's subtree under a revenue total: the lines the filing adds up to that total.
    for (const [role, roleArcs] of byRole) {
      const open = roleArcs.map(a => a.parent).filter(p => REVENUE_TOTALS.includes(local(p))), seen = new Set<string>();
      while (open.length) {
        const parent = open.pop()!;
        if (seen.has(parent)) continue;
        seen.add(parent);
        for (const arc of roleArcs) if (arc.parent === parent) { arcs.push({ role, ...arc }); open.push(arc.child); }
      }
    }
    const concepts = new Set(arcs.flatMap(a => [a.parent, a.child]));
    const tables = new Set(tags.filter(([key]) => REVENUE_TOTALS.includes(local(qname(key)))).flatMap(([, tag]) => Array.isArray(tag?.presentation) ? tag.presentation.filter((r): r is string => typeof r === 'string') : []));
    for (const [key, tag] of tags) {
      if (concepts.has(qname(key))) { const label = labelOf(tag); if (label) labels[qname(key)] = label; }
      if (!key.endsWith('Member') || !Array.isArray(tag?.presentation)) continue;
      const shown = tag.presentation.filter((r): r is string => typeof r === 'string' && tables.has(r)).map(tableName);
      if (shown.length) members[qname(key)] = shown;
    }
  }
  return arcs.length || Object.keys(members).length ? { arcs, labels, members } : null;
}

export async function storedCalculation(db: D1Database, accession: string): Promise<StoredCalculation | null> {
  const record = await new D1SecRepository(db).getCache<StoredCalculation>(cacheKey(accession));
  return record?.payload.version === CALCULATION_VERSION ? record.payload : null;
}

/**
 * A filing's income statement calculation and revenue structure, read from EDGAR once and kept by accession (a filed
 * linkbase never changes). A filing without them, or whose `MetaLinks.json` cannot be read, gives nulls and is read
 * through its statement rows; only an SEC access pause stops the caller. An unreadable file is asked for again on the
 * next parse.
 */
async function filingStructure(db: D1Database, read: (url: string) => Promise<Response>, documentUrl: string, accession: string): Promise<Pick<StoredCalculation, 'calculation' | 'revenue'>> {
  const stored = await storedCalculation(db, accession);
  if (stored) return stored;
  const folder = documentUrl.slice(0, documentUrl.lastIndexOf('/') + 1);
  let json: unknown;
  try {
    const response = await read(folder + 'MetaLinks.json');
    if (Number(response.headers.get('content-length')) > 12_000_000) return { calculation: null, revenue: null };
    json = await response.json();
  } catch (error) {
    if (error instanceof Error && error.message === 'SEC_ACCESS_PAUSED') throw error;
    return { calculation: null, revenue: null };
  }
  const parsed = { calculation: parseIncomeCalculation(json), revenue: parseRevenueStructure(json) };
  await new D1SecRepository(db).setCache<StoredCalculation>(cacheKey(accession), { version: CALCULATION_VERSION, accession, ...parsed }, new Date().toISOString());
  return parsed;
}
export const filingCalculation = async (db: D1Database, read: (url: string) => Promise<Response>, documentUrl: string, accession: string) => (await filingStructure(db, read, documentUrl, accession)).calculation;
export const filingRevenueStructure = async (db: D1Database, read: (url: string) => Promise<Response>, documentUrl: string, accession: string) => (await filingStructure(db, read, documentUrl, accession)).revenue;
