import { readdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.name === 'node_modules') continue;
    if (entry.isDirectory()) { await scan(path); continue; }
    if (!/\.(ts|tsx)$/.test(path)) continue;
    const source = await readFile(path, 'utf8');
    assert.doesNotMatch(source, /(?:FROM|INTO|UPDATE)\s+["`]?portfolio_(?:state|history)\b/i, `${path} directly accesses portfolio storage`);
    assert.doesNotMatch(source, /(?:from\s+|import\s*\()["'][^"']*(?:portfolio-store|ibkr-flex|data\/portfolio-snapshot\.json)["']/, `${path} bypasses the portfolio API`);
  }
}
for (const directory of ['app', 'lib', 'worker', 'packages']) await scan(directory);
const app = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
const sync = JSON.parse(await readFile('workers/sec-cron/wrangler.jsonc', 'utf8'));
const syncDatabase = sync.d1_databases.find(binding => binding.binding === 'DB').database_id;
assert.ok(!app.d1_databases.some(binding => binding.database_id === syncDatabase), 'App is bound to the sync database');
assert.ok(app.services.some(binding => binding.binding === 'PORTFOLIO_DATA_SERVICE' && binding.service === sync.name));
assert.ok(!sync.services?.some(binding => binding.service === app.name), 'Sync depends on the app');
console.log('Portfolio storage is owned by the sync worker; app reads use its API.');
