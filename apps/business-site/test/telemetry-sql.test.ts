import assert from 'node:assert/strict';
import test from 'node:test';
import { sqlRepository, summarize, type StoredEvent } from '../src/telemetry.ts';

test('SQLite aggregates match the in-memory model for every range', async t => {
  let sqlite;
  try { sqlite = await import('node:sqlite'); } catch { t.skip('requires Node 22 node:sqlite'); return; }
  const db = new sqlite.DatabaseSync(':memory:');
  const repo = sqlRepository({ exec(query, ...args) { const rows = db.prepare(query).all(...args); return { toArray: () => rows as never }; } });
  const now = Date.UTC(2026, 9, 27, 15, 30);
  const rows: StoredEvent[] = [];
  for (let i = 0; i < 100; i++) {
    rows.push({ received: now - i * 3_600_000, name: i % 3 ? 'page_view' : 'search_submit', path: '/companies/META', sid: `11111111-1111-4111-8111-${String(i % 5).padStart(12, '0')}`, lang: 'en', theme: 'dark', props: i % 3 ? {} : { q: 'zzzz', results: 0 } });
  }
  rows.push({ ...rows[0]!, received: now, name: 'tour_start' }, { ...rows[0]!, received: now, name: 'tour_done' });
  rows.push(
    { ...rows[0]!, received: now + 1, name: 'page_view' },
    { ...rows[0]!, received: now - 40 * 86_400_000, name: 'page_view' },
    { ...rows[0]!, received: now, name: 'finding_expand' },
    { ...rows[0]!, received: now, name: 'error_shown' },
    { ...rows[0]!, received: now, name: 'page_view', path: '/companies/BRK.B', props: { ticker: 42 } },
    ...['z', '中', 'A', 'a'].map(q => ({ ...rows[0]!, received: now, name: 'search_submit' as const, props: { q, empty: 1 } })),
  );
  for (const row of rows) repo.add(row);
  for (const range of ['24h', '7d', '4w'] as const) assert.deepEqual(repo.summary!(range, now), summarize(rows, range, now));
  db.close();
});
