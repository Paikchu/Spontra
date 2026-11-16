/** Local publication journey with real Miniflare D1/R2 and injected interruption. Never contacts production. */
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { saveVersion, readArtifactVersion } from '../workers/analysis/src/artifact/store.ts';

const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'acceptance', modules: true, script: 'export default {fetch(){return new Response("local acceptance")}}', compatibilityDate: '2026-01-01', d1Databases: ['DB'], r2Buckets: ['SEC_FILINGS'] }] }));
const evidence = [];
try {
  const db = await mf.getD1Database('DB'), bucket = await mf.getR2Bucket('SEC_FILINGS');
  const schema = await readFile(new URL('../workers/analysis/migrations/0049_analysis_artifacts.sql', import.meta.url), 'utf8');
  await db.exec(schema.replace(/--[^\n]*/g, '').replace(/\n/g, ' '));
  const document = title => ({ schema: 'analysis-artifact.v1', kind: 'filing-report', ticker: 'SYNTH', subject: 'acceptance-only', lang: 'en', title,
    blocks: [{ id: 'lead', html: `<h2>${title}</h2><p>Synthetic publication fixture; never production.</p>`, sources: [], state: 'ready' }], charts: [], sources: [] });
  const env = { DB: db, SEC_FILINGS: bucket };
  const old = await saveVersion(env, document('Last reviewed version'), '', 'published', 'local-old');
  const id = 'filing-report:SYNTH:acceptance-only';
  await db.prepare('UPDATE analysis_artifacts SET published_version=?, published_hash=? WHERE artifact_id=?').bind(old.version, old.hash, id).run();
  // Simulate an index transaction outage after object storage succeeded.
  const interrupted = { ...env, DB: { prepare: db.prepare.bind(db), batch: async () => { throw new Error('injected index outage'); } } };
  await assert.rejects(saveVersion(interrupted, document('Interrupted candidate'), '', 'draft', 'local-failed'), /injected index outage/);
  const pointer = await db.prepare('SELECT published_version FROM analysis_artifacts WHERE artifact_id=?').bind(id).first();
  assert.equal(pointer.published_version, old.version);
  assert.equal((await readArtifactVersion(env, id, old.version)).document.title, 'Last reviewed version');
  evidence.push({ check: 'object-written/index-failed', result: 'old complete version remains readable' });
  // Both writers observe the same version number before either D1 batch; R2 object bodies must not collide.
  let writes = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const racing = { ...env, SEC_FILINGS: { get: bucket.get.bind(bucket), put: async (...args) => { await bucket.put(...args); if (++writes === 2) release(); await barrier; } } };
  const results = await Promise.allSettled([
    saveVersion(racing, document('Concurrent candidate A'), '', 'draft', 'local-a'),
    saveVersion(racing, document('Concurrent candidate B'), '', 'draft', 'local-b'),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const winner = results.find(r => r.status === 'fulfilled').value;
  const stored = await readArtifactVersion(env, id, winner.version);
  assert.equal(stored.hash, winner.hash);
  assert.equal(stored.html, winner.html);
  assert.equal((await readArtifactVersion(env, id, old.version)).document.title, 'Last reviewed version');
  evidence.push({ check: 'concurrent-version-allocation', result: 'one indexed winner, exact matching bytes, old version unchanged' });
  console.log(JSON.stringify({ environment: 'local Miniflare only', modelCalls: 0, evidence }, null, 2));
} finally { await mf.dispose(); }
