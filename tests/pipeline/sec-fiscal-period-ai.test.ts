import assert from 'node:assert/strict';
import test from 'node:test';
import { fiscalPeriodInput, validateAiFiscalPeriod } from '../../workers/pipeline/src/sec/fiscal-period-ai.ts';
import type { SecFiling } from '../../shared/analysis-contract/report.ts';
const filing = { form: '10-Q', reportDate: '2026-08-31', accessionNumber: 'orcl', documentUrl: 'https://sec.test/orcl' } as SecFiling;
const quote = 'During the first quarter of fiscal 2027, we received prepayments.';
const value = { fiscalYear: 2027, fiscalPeriod: 'Q1', periodEnd: filing.reportDate, evidenceQuote: quote, conflictExplanation: 'DEI says 2026; the current-quarter source explicitly says fiscal 2027.' };
test('accepts grounded model identification even when DEI is inconsistent', () => {
  const result = validateAiFiscalPeriod(value, filing, fiscalPeriodInput(quote));
  assert.equal(result?.fiscalYear, 2027);
  assert.equal(result?.source, 'ai_source_review');
  assert.equal(result?.conflictExplanation, value.conflictExplanation);
});
test('rejects invented quotations, wrong periods, missing answers and annual/quarter confusion', () => {
  assert.equal(validateAiFiscalPeriod(value, filing, ['unrelated text']), null);
  assert.equal(validateAiFiscalPeriod({ ...value, periodEnd: '2025-08-31' }, filing, [quote]), null);
  assert.equal(validateAiFiscalPeriod(null, filing, [quote]), null);
  assert.equal(validateAiFiscalPeriod(value, { ...filing, form: '10-K' }, [quote]), null);
  assert.equal(validateAiFiscalPeriod({ ...value, fiscalPeriod: 'FY' }, { ...filing, form: '10-K' }, [quote])?.fiscalPeriod, 'FY');
});
