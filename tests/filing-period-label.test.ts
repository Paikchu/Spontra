import assert from 'node:assert/strict';
import test from 'node:test';
import { formatFilingPeriodLabel } from '../lib/earning-report/web/filing-period-label.ts';
import type { PublicSecFiling } from '../shared/analysis-contract/filings.ts';
const filing = { form: '10-Q', reportDate: '2026-08-31', fiscalPeriod: { fiscalYear: 2027, fiscalPeriod: 'Q1', periodEnd: '2026-08-31' } } as PublicSecFiling;
test('uses SEC fiscal focus, and distinguishes annual reports from Q4', () => {
  assert.equal(formatFilingPeriodLabel(filing), 'FY2027 Q1');
  assert.equal(formatFilingPeriodLabel({ ...filing, form: '10-K', fiscalPeriod: { ...filing.fiscalPeriod!, fiscalPeriod: 'FY' } }), 'FY2027 全年');
});
test('never derives labels from prose, dates, or other filings', () => {
  assert.equal(formatFilingPeriodLabel({ ...filing, fiscalPeriod: null }), '财季待确认');
  assert.equal(formatFilingPeriodLabel({ ...filing, reportDate: '2026-11-30' }), '财季待确认');
  assert.equal(formatFilingPeriodLabel({ ...filing, form: '8-K' }), '8-K');
});
