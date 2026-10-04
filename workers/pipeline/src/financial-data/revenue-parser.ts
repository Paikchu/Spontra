import type {RevenueHistoryLeaf, RevenueHistoryLineage, RevenueHistoryQuarter} from '../../../../shared/analysis-contract/revenue-history.ts';
import {historyQuarterFrom, mergeHistory, validHistoryQuarter} from '../../../../shared/analysis-runtime/financial-data/history.ts';
import {parseSecBusinessFlow, type BusinessFact, type ParsedBusinessQuarter} from '../../../../shared/analysis-runtime/financial-data/business-flow-parser.ts';
import {parseSecEarningsRelease} from '../../../../shared/analysis-runtime/financial-data/business-flow-release.ts';
import {extractDisclosedQuarters, extractVerifiedCurrentQuarters, readReportedFacts, type DocumentSource} from './parser.ts';

export const REVENUE_PARSER_VERSION = 'sec-revenue-history.v2';
type HistorySource = RevenueHistoryQuarter['source'];
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, Math.max(Math.abs(a), Math.abs(b)) * 1e-9);
const clean = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#(?:x([\da-f]+)|(\d+));/gi, (_, hex, dec) => String.fromCodePoint(parseInt(hex ?? dec, hex ? 16 : 10))).replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
const months: Record<string, number> = {january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12};

/** Revenue is independently complete even when an expense or net-income fact is unavailable. */
function fromRevenueProfile(parsed: ParsedBusinessQuarter, source: HistorySource): RevenueHistoryQuarter | null {
  if (!parsed.coverage.revenueSplitComplete || !parsed.financials.revenue || parsed.issues.some(issue => /revenue/i.test(issue))) return null;
  const lineage = (fact: BusinessFact): RevenueHistoryLineage[] => [{accession: fact.lineage.accession, url: fact.lineage.sourceUrl, concept: fact.lineage.tag, contextId: fact.lineage.contextId, periodStart: fact.lineage.start, periodEnd: fact.lineage.end, dimensions: fact.lineage.dimensions, parserVersion: REVENUE_PARSER_VERSION}];
  const groups = new Map<string, RevenueHistoryLeaf[]>();
  for (const leaf of parsed.revenues) {
    const canonical = leaf.id === 'SalesRevenueServicesNet1' ? 'SalesRevenueServicesNet' : leaf.id;
    const id = ['CloudApplications', 'CloudInfrastructure', 'CloudRevenues', 'cloud'].includes(canonical) ? 'cloud' : ['SoftwareLicense', 'SoftwareSupport', 'SoftwareRevenues', 'software'].includes(canonical) ? 'software' : canonical === 'hardware' ? 'HardwareRevenues' : canonical === 'services' ? 'SalesRevenueServicesNet' : canonical;
    groups.set(id, [...(groups.get(id) ?? []), {id: canonical, name: leaf.label, value: String(leaf.fact.value), lineage: lineage(leaf.fact)}]);
  }
  const quarter: RevenueHistoryQuarter = {periodStart: parsed.start, periodEnd: parsed.end, currency: parsed.currency, scale: 1, revenue: String(parsed.financials.revenue.value), basis: 'reported', source,
    presentation: '该来源直接披露的季度收入分类；收入覆盖独立于利润和费用覆盖', lineage: lineage(parsed.financials.revenue),
    segments: [...groups].map(([id, leaves]) => ({id, name: id === 'cloud' ? '云服务' : id === 'software' ? '软件' : leaves[0].name, value: String(leaves.reduce((sum, leaf) => sum + Number(leaf.value), 0)), lineage: leaves.flatMap(leaf => leaf.lineage ?? []), ...(leaves.length > 1 ? {children: leaves} : {})}))};
  return validHistoryQuarter(quarter) ? quarter : null;
}

type TableRow = {label: string; cells: string[]; index: number; values: Array<{value: number; cell: number}>};
function tableRows(html: string): TableRow[] {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match, index) => {
    const cells = [...match[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => clean(cell[1]));
    const labelIndex = cells.findIndex(Boolean), values: TableRow['values'] = [];
    for (let cell = labelIndex + 1; cell < cells.length; cell++) {
      const raw = cells[cell].replace(/[$,\s]/g, '');
      // Keep explicit unknown cells in their column; never shift subsequent quarters left or invent zero.
      if (/^[—–-]$/.test(raw)) values.push({value: Number.NaN, cell});
      else if (/^\(?[+-]?\d+(?:\.\d+)?\)?$/.test(raw)) values.push({value: Number(raw.replace(/[()]/g, '')) * (raw.startsWith('(') || cells[cell + 1] === ')' ? -1 : 1), cell});
    }
    return {label: cells[labelIndex] ?? '', cells, index, values};
  });
}

/** Oracle's GAAP offerings table explicitly discloses Q1–Q4 for each fiscal year.
 * The fiscal year end comes from the same release's annual statement, not a ticker calendar.
 * Annual TOTAL and percentage columns are never projected as quarters. */
export function parseOracleOfferingsHistory(html: string, source: HistorySource): RevenueHistoryQuarter[] {
  const tables = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)], output: RevenueHistoryQuarter[] = [];
  const annualEnds = new Map<string, {month: number; day: number}>();
  for (const table of tables) {
    const preceding = clean(html.slice(Math.max(0, table.index! - 3500), table.index));
    if (!/CONDENSED CONSOLIDATED STATEMENTS OF OPERATIONS/i.test(preceding)) continue;
    const rows = tableRows(table[0]), revenueRow = rows.findIndex(row => /^REVENUES$/i.test(row.label));
    if (revenueRow < 0) continue;
    const header = rows.slice(0, revenueRow).map(row => row.cells.filter(Boolean).join(' ')).join(' ').match(/\bYear Ended\s+(\w+)\s+(\d{1,2}),([\s\S]*)/i);
    if (!header) continue;
    const month = months[header[1].toLowerCase()], day = Number(header[2]);
    for (const year of new Set(header[3].match(/\b20\d{2}\b/g) ?? [])) {
      if (month && day === new Date(Date.UTC(Number(year), month, 0)).getUTCDate()) annualEnds.set(year, {month, day});
    }
  }
  for (const [tableIndex, table] of tables.entries()) {
    const preceding = clean(html.slice(Math.max(0, table.index! - 1500), table.index));
    if (!/SUPPLEMENTAL ANALYSIS OF GAAP REVENUES/i.test(preceding) || !/\$ in millions/i.test(preceding)) continue;
    const rows = tableRows(table[0]), titleIndex = rows.findIndex(row => /^REVENUES BY OFFERINGS$/i.test(row.label));
    if (titleIndex < 0) continue;
    const header = rows.slice(0, titleIndex).map(row => row.cells.filter(Boolean).join(' ')).join(' ');
    const years = [...header.matchAll(/Fiscal\s+(20\d{2})/gi)].map(match => match[1]);
    const columns = [...header.matchAll(/\bQ[1-4]\b|\bTOTAL\b/gi)].map(match => match[0].toUpperCase());
    if (!years.length || new Set(years).size !== years.length || columns.join('|') !== years.map(() => 'Q1|Q2|Q3|Q4|TOTAL').join('|') || years.some(year => !annualEnds.has(year))) continue;
    let section = '', invalid = false;
    const amounts = new Map<string, TableRow>();
    const accepted = new Set(['cloud', 'software', 'software license', 'software support', 'hardware', 'services', 'total revenues', 'cloud applications', 'cloud infrastructure', 'total cloud revenues']);
    for (const row of rows.slice(titleIndex)) {
      if (/^(?:CLOUD )?REVENUES BY OFFERINGS$/i.test(row.label)) {section = row.label.toLowerCase(); continue;}
      if (/GROWTH RATES|GEOGRAPHIC REVENUES/i.test(row.label)) {section = ''; continue;}
      const key = row.label.toLowerCase();
      if (!section || !accepted.has(key)) continue;
      if (row.values.length !== columns.length || amounts.has(key)) {invalid = true; break;}
      amounts.set(key, row);
    }
    if (invalid || ['cloud', 'software', 'hardware', 'services', 'total revenues'].some(key => !amounts.has(key))) continue;
    for (const [group, year] of years.entries()) for (let quarter = 1; quarter <= 4; quarter++) {
      const column = group * 5 + quarter - 1, {month} = annualEnds.get(year)!;
      const endDate = new Date(Date.UTC(Number(year), month - (4 - quarter) * 3, 0));
      const end = endDate.toISOString().slice(0, 10), start = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth() - 2, 1)).toISOString().slice(0, 10);
      if (end > source.filedAt) continue;
      const leaf = (key: string, id: string, name: string): RevenueHistoryLeaf | null => {
        const row = amounts.get(key), amount = row?.values[column];
        if (!row || !amount || !Number.isFinite(amount.value) || amount.value < 0) return null;
        return {id, name, value: String(amount.value * 1e6), lineage: [{accession: source.accession, url: source.url, concept: `table:${row.label}`, contextId: `table-${tableIndex}:row-${row.index}:cell-${amount.cell}:FY${year}:Q${quarter}`, periodStart: start, periodEnd: end, dimensions: {}, parserVersion: REVENUE_PARSER_VERSION}]};
      };
      const cloud = leaf('cloud', 'cloud', '云服务'), software = leaf('software', 'software', '软件'), hardware = leaf('hardware', 'HardwareRevenues', '硬件'), services = leaf('services', 'SalesRevenueServicesNet', '服务'), total = leaf('total revenues', 'total', '总收入');
      if (!cloud || !software || !hardware || !services || !total) continue;
      const children = (keys: Array<[string, string, string]>, parent: RevenueHistoryLeaf) => {
        const leaves = keys.map(([key, id, name]) => leaf(key, id, name));
        return leaves.every((value): value is RevenueHistoryLeaf => !!value) && near(leaves.reduce((sum, value) => sum + Number(value.value), 0), Number(parent.value)) ? {children: leaves} : {};
      };
      const q: RevenueHistoryQuarter = {periodStart: start, periodEnd: end, currency: 'USD', scale: 1, revenue: total.value, basis: 'reported', source, lineage: total.lineage,
        presentation: `该附件 GAAP 收入补充表直接披露 FY${year} Q${quarter}；按附件展示口径，非累计相减`,
        segments: [{...cloud, ...children([['cloud applications', 'CloudApplications', '云应用'], ['cloud infrastructure', 'CloudInfrastructure', '云基础设施']], cloud)}, {...software, ...children([['software license', 'SoftwareLicense', '软件许可'], ['software support', 'SoftwareSupport', '软件支持']], software)}, hardware, services]};
      if (validHistoryQuarter(q)) output.push(q);
    }
  }
  return output;
}

/** Income-statement publication gates must not discard independently reconciled revenue disclosure. */
export function extractRevenueHistory(html: string, source: DocumentSource, form: string): {quarters: RevenueHistoryQuarter[]; issues: string[]} {
  if (html.length > 12000000) return {quarters: [], issues: ['DOCUMENT_TOO_LARGE']};
  const historySource: HistorySource = {accession: source.accession, url: source.url, filedAt: source.filedAt, form};
  const generic = extractDisclosedQuarters(html, source);
  const revenueConcepts = new Set(['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenuesNetOfInterestExpense']);
  // Read original direct-quarter revenue facts in isolation. A conflicting or unsupported
  // expense/net fact has no bearing on whether the revenue total and its split reconcile.
  const revenueFacts = readReportedFacts(html, source).facts.filter(fact => revenueConcepts.has(fact.tag.split(':').at(-1)!));
  const direct = extractVerifiedCurrentQuarters(source, revenueFacts);
  const quarters = [...generic.quarters, ...direct.quarters].map(quarter => historyQuarterFrom(quarter, historySource)).filter((quarter): quarter is RevenueHistoryQuarter => !!quarter);
  if (source.cik === '0001341439') {
    const inputs = {sourceUrl: source.url, accession: source.accession};
    const profiles = /<ix:nonFraction/i.test(html) ? parseSecBusinessFlow(html, inputs) : parseSecEarningsRelease(html, inputs);
    // A same-document, explicitly labelled quarter can be read even when another statement
    // mentions a recast. No cross-filing arithmetic or unreported reclassification is applied.
    quarters.push(...profiles.map(profile => fromRevenueProfile(profile, historySource)).filter((quarter): quarter is RevenueHistoryQuarter => !!quarter), ...parseOracleOfferingsHistory(html, historySource));
  }
  return {quarters: mergeHistory('X', [], quarters, source.filedAt).quarters, issues: quarters.length ? generic.issues.filter(issue => issue === 'RESTATEMENT_REVIEW_REQUIRED') : generic.issues};
}
