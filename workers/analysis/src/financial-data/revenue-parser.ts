import {SEC_DOCUMENT_MAX_BYTES} from '../../../../shared/analysis-runtime/financial-data/limits.ts';
import type {RevenueHistoryQuarter} from '../../../../shared/analysis-contract/revenue-history.ts';
import {historyQuarterFrom, mergeHistory} from '../../../../shared/analysis-runtime/financial-data/history.ts';
import {extractDisclosedQuarters, extractVerifiedCurrentQuarters, readReportedFacts, type DocumentSource} from './parser.ts';

export const REVENUE_PARSER_VERSION = 'sec-revenue-history.v8';
type HistorySource = RevenueHistoryQuarter['source'];
const clean = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#(?:x([\da-f]+)|(\d+));/gi, (_, hex, dec) => String.fromCodePoint(parseInt(hex ?? dec, hex ? 16 : 10))).replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();

/** Income-statement publication gates must not discard independently reconciled revenue disclosure. */
export function extractRevenueHistory(html: string, source: DocumentSource, form: string): {quarters: RevenueHistoryQuarter[]; issues: string[]} {
  if (html.length > SEC_DOCUMENT_MAX_BYTES) return {quarters: [], issues: ['DOCUMENT_TOO_LARGE']};
  const historySource: HistorySource = {accession: source.accession, url: source.url, filedAt: source.filedAt, form};
  const generic = extractDisclosedQuarters(html, source);
  const revenueConcepts = new Set(['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenuesNetOfInterestExpense', 'Revenue', 'RevenueFromContractsWithCustomers']);
  // Read original direct-quarter revenue facts in isolation. A conflicting or unsupported
  // expense/net fact has no bearing on whether the revenue total and its split reconcile.
  const revenueFacts = readReportedFacts(html, source).facts.filter(fact => revenueConcepts.has(fact.tag.split(':').at(-1)!));
  const direct = extractVerifiedCurrentQuarters(source, revenueFacts);
  const quarters = [...generic.quarters, ...direct.quarters].map(quarter => historyQuarterFrom(quarter, historySource)).filter((quarter): quarter is RevenueHistoryQuarter => !!quarter);
  // A report that never prints a quarter (an annual 20-F, a half-year 6-K, a pro forma, a cover amendment) is not a
  // quarter the parser failed to read. One that prints "three months ended" and still yields nothing is.
  const printsQuarter = /(?:three|3)\s+months\s+ended/i.test(clean(html));
  const issues = (quarters.length ? generic.issues.filter(issue => issue === 'RESTATEMENT_REVIEW_REQUIRED') : generic.issues)
    .map(issue => issue === 'NO_DIRECT_COMPARABLE_QUARTER' && !printsQuarter ? 'NO_QUARTERLY_PERIOD' : issue);
  return {quarters: mergeHistory('X', [], quarters, source.filedAt).quarters, issues};
}
