import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPANY_LAYER_STATUS_LABELS, type BusinessMapCompany } from '../../../shared/analysis-contract/business-map-admin.ts';
import type { FinancialMaintenanceTask } from '../../../shared/analysis-contract/financial-maintenance.ts';
import { companyLayerStatuses } from '../src/admin/company-status.ts';

const feature = (): BusinessMapCompany['features']['filings'] => ({ on: true, publishedAt: null, run: null, progress: [], failure: null });
function source(): Parameters<typeof companyLayerStatuses>[0] {
  return { dataEnabled: true, task: null, collection: null,
    publication: { status: 'preparing', outdated: false, reasons: [], periods: [] },
    features: { filings: feature(), findings: feature(), tree: feature(), valuation: feature() } };
}
const settings = () => ({ automaticCollection: true, generation: { filings: true, findings: true, tree: true, valuation: true } });
const task = (status: FinancialMaintenanceTask['status'], updatedAt: string): FinancialMaintenanceTask => ({
  id: 'task', ticker: 'TEST', action: 'extract', status, stage: 'complete', createdAt: updatedAt, updatedAt, completedAt: updatedAt,
  errorCode: null, issues: [], progress: { completed: 1, total: 1 }, canRetry: false, canCancel: false, accessionNumber: null,
});

test('feature status follows backend work through pending, queue, execution, publication and failure', () => {
  const company = source(), generation = settings();
  const state = () => companyLayerStatuses(company, generation).tree;
  assert.equal(state().code, 'pending');
  company.features.tree.run = 'queued';
  assert.equal(state().code, 'queued');
  company.features.tree.publishedAt = '2026-11-03T00:00:00Z';
  company.features.tree.run = 'running';
  assert.equal(state().code, 'running');
  generation.generation.tree = false;
  assert.equal(state().code, 'running');
  company.features.tree.run = null;
  assert.equal(state().code, 'paused');
  generation.generation.tree = true;
  assert.equal(state().code, 'ready');
  company.features.tree.on = false;
  assert.equal(state().code, 'disabled');
  company.features.tree.failure = { at: '2026-11-04T00:00:00Z', detail: 'Provider refused' };
  assert.equal(state().code, 'failed');
  for (const value of Object.values(companyLayerStatuses(company, generation))) assert.equal(value.label, COMPANY_LAYER_STATUS_LABELS[value.code]);
});

test('financial status prioritizes active work, and newer successful collection supersedes an old failed task', () => {
  const company = source(), generation = settings();
  const state = () => companyLayerStatuses(company, generation).map.code;
  assert.equal(state(), 'pending');
  company.publication.status = 'ready';
  company.task = task('running', '2026-11-04T01:00:00Z');
  assert.equal(state(), 'running');
  company.task.status = 'queued';
  assert.equal(state(), 'queued');
  company.task.status = 'failed';
  assert.equal(state(), 'failed');
  company.collection = { status: 'succeeded', reasons: [], updatedAt: '2026-11-04T02:00:00Z', completed: 1, total: 1 };
  assert.equal(state(), 'ready');
  company.publication.outdated = true;
  assert.equal(state(), 'outdated');
  company.task = task('partial', '2026-11-04T03:00:00Z');
  assert.equal(state(), 'partial');
  generation.automaticCollection = false;
  assert.equal(state(), 'paused');
  company.dataEnabled = false;
  assert.equal(state(), 'disabled');
});
