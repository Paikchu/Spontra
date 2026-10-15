import { D1SecRepository } from '../sec/d1.ts';

/**
 * A filing's own arithmetic for its income statement, as its calculation linkbase declares it: each line's parent
 * total and the weight it enters that total with. EDGAR renders every XBRL filing's linkbases into one
 * `MetaLinks.json` beside the documents (member-labels.ts reads the labels from the same file), so the structure
 * comes from the issuer, never from a list of concept names kept here.
 */
export const CALCULATION_VERSION = 'calculation.v1';
const cacheKey = (accession: string) => `sec:calculation:v1:${accession}`;

/** One summation arc: `child` enters `parent` with `weight` (+1 or −1), at `order` among its siblings. */
export type CalculationArc = { parent: string; child: string; weight: 1 | -1; order: number };
/** The income statement's calculation tree: its root total and every arc under it, concepts as `prefix:Local`. */
export type IncomeCalculation = { role: string; title: string; root: string; arcs: CalculationArc[]; labels: Record<string, string> };
export type StoredCalculation = { version: string; accession: string; calculation: IncomeCalculation | null };

type MetaRole = { parentTag?: unknown; weight?: unknown; order?: unknown; root?: unknown };
type MetaTag = { calculation?: Record<string, MetaRole>; lang?: Record<string, { role?: { terseLabel?: unknown; label?: unknown } }> };
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
        const roles = tag.lang?.['en-us']?.role ?? tag.lang?.['en']?.role;
        const label = clean(roles?.terseLabel) || clean(roles?.label);
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

export async function storedCalculation(db: D1Database, accession: string): Promise<StoredCalculation | null> {
  const record = await new D1SecRepository(db).getCache<StoredCalculation>(cacheKey(accession));
  return record?.payload.version === CALCULATION_VERSION ? record.payload : null;
}

/**
 * A filing's income statement calculation, read from EDGAR once and kept by accession (a filed linkbase never changes).
 * A filing without one, or whose `MetaLinks.json` cannot be read, gives null and is read through its statement rows;
 * only an SEC access pause stops the caller. An unreadable file is asked for again on the next parse.
 */
export async function filingCalculation(db: D1Database, read: (url: string) => Promise<Response>, documentUrl: string, accession: string): Promise<IncomeCalculation | null> {
  const stored = await storedCalculation(db, accession);
  if (stored) return stored.calculation;
  const folder = documentUrl.slice(0, documentUrl.lastIndexOf('/') + 1);
  let calculation: IncomeCalculation | null;
  try {
    const response = await read(folder + 'MetaLinks.json');
    if (Number(response.headers.get('content-length')) > 12_000_000) return null;
    calculation = parseIncomeCalculation(await response.json());
  } catch (error) {
    if (error instanceof Error && error.message === 'SEC_ACCESS_PAUSED') throw error;
    return null;
  }
  await new D1SecRepository(db).setCache<StoredCalculation>(cacheKey(accession), { version: CALCULATION_VERSION, accession, calculation }, new Date().toISOString());
  return calculation;
}
