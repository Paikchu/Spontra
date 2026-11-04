import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { readCompanyUsage } from '../src/admin/company-usage.ts';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0023_ai_usage.sql', import.meta.url), 'utf8'));
  const prepare = (sql: string, values: SQLInputValue[] = []) => ({
    bind: (...next: SQLInputValue[]) => prepare(sql, next),
    all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
  });
  const db = { prepare } as unknown as D1Database;
  const insert = (kind: string, input: number, output: number, cached = 0, ticker: string | null = 'TEST', at = '2026-11-04T00:00:00Z', outcome = 'ok') => {
    sqlite.prepare(`INSERT INTO ai_usage (at,ticker,kind,stage,provider,model,input_tokens,cached_tokens,output_tokens,outcome)
      VALUES (?,?,?,?,'deepseek','test-model',?,?,?,?)`).run(at, ticker, kind, kind, input, cached, output, outcome);
  };
  return { db, sqlite, insert };
}

test('company totals cover the five task layers, retain older and failed calls, and never add cached input twice', async () => {
  const { db, sqlite, insert } = database();
  try {
    insert('read-note', 100, 10, 40, 'TEST', '2025-01-01T00:00:00Z');
    insert('translate', 30, 5);
    insert('sec-analysis', 200, 20);
    insert('library', 50, 5);
    insert('library-links-review', 70, 7);
    insert('business-tags', 10, 1);
    insert('items', 30, 3, 0, 'TEST', '2026-11-04T00:00:00Z', 'error');
    insert('business', 60, 6);
    insert('company-analysis', 40, 4);
    insert('lens', 10, 1);
    insert('checkup', 20, 2);
    insert('tree', 400, 40);
    insert('explainer', 50, 5);
    insert('valuation', 500, 50);
    insert('valuation-research', 60, 6);
    insert('stage', 5, 2);
    insert('future-task', 3, 1);
    insert('tree', 99999, 99999, 0, 'OTHER');
    insert('sec-analysis', 99999, 99999, 0, null);
    const usage = await readCompanyUsage(db, 'TEST');
    const amounts = Object.fromEntries(Object.entries(usage.layers).map(([layer, row]) => [layer, [row.inputTokens, row.outputTokens]]));
    assert.deepEqual(amounts, { map: [130, 15], filings: [360, 36], findings: [130, 13], tree: [450, 45], valuation: [560, 56] });
    assert.equal(usage.layers.map.cachedTokens, 40);
    assert.equal(usage.layers.map.inputTokens + usage.layers.map.outputTokens, 145);
    assert.equal(usage.unassigned.inputTokens + usage.unassigned.outputTokens, 11);
    assert.equal(usage.firstAt, '2025-01-01T00:00:00Z');
  } finally { sqlite.close(); }
});

test('no history and calls without token counts remain distinguishable; failed ledger reads reject', async () => {
  const { db, sqlite, insert } = database();
  try {
    const empty = await readCompanyUsage(db, 'TEST');
    assert.equal(empty.firstAt, null);
    assert.ok(Object.values(empty.layers).every(row => row.calls === 0));
    insert('tree', 0, 0, 0, 'TEST', '2026-11-04T00:00:00Z', 'timeout');
    const missing = await readCompanyUsage(db, 'TEST');
    assert.equal(missing.layers.tree.calls, 1);
    assert.equal(missing.layers.tree.callsWithoutTokens, 1);
    sqlite.exec('DROP TABLE ai_usage');
    await assert.rejects(readCompanyUsage(db, 'TEST'), /no such table/);
  } finally { sqlite.close(); }
});
