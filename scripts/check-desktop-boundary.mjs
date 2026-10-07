import { readdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = new URL('../apps/desktop/dist/', import.meta.url);
async function scan(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) { await scan(url); continue; }
    assert.ok(!/portfolio-snapshot|\.env|\.map$/.test(entry.name), `Private/build-only file: ${entry.name}`);
    if (!/\.(js|json|html|css)$/.test(entry.name)) continue;
    const text = await readFile(url, 'utf8');
    assert.doesNotMatch(text, /cloudflare:workers|EARNING_REPORT_READ_TOKEN|IBKR_FLEX_TOKEN|PORTFOLIO_SYNC_KEY|PORTFOLIO_READ_TOKEN|PORTFOLIO_DATA_SERVICE|spontra-max-data-sync-db|DESKTOP_ACCESS_TOKEN|investment-record-db/);
  }
}
await scan(root);
console.log('Desktop bundle contains no forbidden server bindings or snapshot assets.');
