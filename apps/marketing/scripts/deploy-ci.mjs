// Production publication belongs to the origin/main automatic Git build.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

if (!process.env.CI) throw new Error('Marketing deployment is restricted to the Git main CI build.');
const branch = process.env.GITHUB_REF_NAME || process.env.CF_PAGES_BRANCH || process.env.WORKERS_CI_BRANCH;
if (branch && branch !== 'main') throw new Error('Marketing production deployment requires main.');
const config = JSON.parse(readFileSync(new URL('../site.config.json', import.meta.url), 'utf8'));
const origin = process.env.SITE_ORIGIN || config.canonicalOrigin;
if (!origin.startsWith('https://')) throw new Error('Marketing production origin must use HTTPS.');

function run(args, env = process.env) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env });
  if (result.error || result.status !== 0) throw new Error('Marketing CI build/publication failed.');
}
run(['apps/marketing/scripts/build.mjs']);
const env = { ...process.env };
delete env.WRANGLER_CI_OVERRIDE_NAME;
delete env.WRANGLER_CI_MATCH_TAG;
run(['node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', 'apps/marketing/wrangler.jsonc', '--name', 'spontra-marketing', '--keep-vars'], env);
