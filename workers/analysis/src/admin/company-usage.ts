import type { BusinessMapUsage, CompanyTokenUsage } from '../../../../shared/analysis-contract/business-map-admin.ts';
import type { Layer } from '../../../../shared/analysis-contract/business-features.ts';
import { TASKS, type TaskName } from '../pipeline/registry.ts';

// Legacy ledger names resolve to the same tasks as current calls. The registry owns each task's layer.
const USAGE_TASK: Record<string, TaskName> = {
  'read-note': 'collect', presentation: 'presentation', translate: 'translate',
  'sec-analysis': 'sec-report', 'sec-report': 'sec-report', guidance: 'guidance', memory: 'memory', items: 'items', filing: 'filing-analysis',
  library: 'library', 'library-cards': 'library-cards', 'library-links': 'library-links',
  'library-links-review': 'library-links', 'business-tags': 'business-tags',
  business: 'company-analysis', 'company-analysis': 'company-analysis',
  findings: 'findings', lens: 'findings', analyst: 'analyst', checkup: 'checkup',
  tree: 'tree', explainer: 'explainer', valuation: 'valuation', 'valuation-research': 'valuation',
};

function layerForUsage(kind: string): Layer | null {
  const task = USAGE_TASK[kind];
  if (!task) return null;
  const scope = TASKS[task].scope;
  return scope === 'global' ? null : scope;
}

const empty = (): CompanyTokenUsage => ({ calls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, callsWithoutTokens: 0 });
type UsageGroup = CompanyTokenUsage & { kind: string; firstAt: string; lastAt: string };

/** All retained, company-attributed ledger rows, including failed attempts. No inference for unlabelled history. */
export async function readCompanyUsage(db: D1Database, ticker: string): Promise<BusinessMapUsage> {
  const { results } = await db.prepare(`SELECT kind, COUNT(*) calls,
    SUM(input_tokens) inputTokens, SUM(cached_tokens) cachedTokens, SUM(output_tokens) outputTokens,
    SUM(CASE WHEN input_tokens = 0 AND output_tokens = 0 THEN 1 ELSE 0 END) callsWithoutTokens,
    MIN(at) firstAt, MAX(at) lastAt
    FROM ai_usage WHERE ticker = ? GROUP BY kind`).bind(ticker).all<UsageGroup>();
  const result: BusinessMapUsage = {
    ticker, firstAt: null, lastAt: null,
    layers: { map: empty(), filings: empty(), findings: empty(), tree: empty(), valuation: empty() },
    unassigned: empty(),
  };
  for (const row of results) {
    const layer = layerForUsage(row.kind), total = layer ? result.layers[layer] : result.unassigned;
    total.calls += row.calls;
    total.inputTokens += row.inputTokens;
    total.cachedTokens += row.cachedTokens;
    total.outputTokens += row.outputTokens;
    total.callsWithoutTokens += row.callsWithoutTokens;
    if (!result.firstAt || row.firstAt < result.firstAt) result.firstAt = row.firstAt;
    if (!result.lastAt || row.lastAt > result.lastAt) result.lastAt = row.lastAt;
  }
  return result;
}
