/** Only Cloudflare's Git build may deploy. Never run this entry point locally. */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
if (!process.env.CI) throw new Error('Deployment is restricted to the Git main CI build.');
const credential = process.env.DESKTOP_ACCESS_TOKEN;
if (credential && !/^[!-~]{32,512}$/.test(credential)) throw new Error('Invalid desktop access credential configuration.');
const directory = mkdtempSync(join(tmpdir(), 'spontra-deploy-'));
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: 'inherit', env });
  if (result.error || result.status !== 0) throw new Error(`CI deployment step failed: ${command}`);
}
try {
  // Validate the independent app before any production release steps.
  run('npm', ['run', 'business-site:typecheck']);
  run('npm', ['run', 'business-site:test']);
  run('npm', ['run', 'business-site:build']);
  run('npm', ['run', 'marketing:build']);
  run('npm', ['run', 'admin:typecheck']);
  run('npm', ['run', 'admin:test']);
  run('npm', ['run', 'admin:build']);
  run('npm', ['run', 'db:migrate:remote']);
  const args = ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', 'dist/server/wrangler.json', '--keep-vars'];
  if (credential) {
    const path = join(directory, 'desktop-secret.json');
    writeFileSync(path, JSON.stringify({ DESKTOP_ACCESS_TOKEN: credential }), { mode: 0o600 });
    args.push('--secrets-file', path);
  }
  // Publish the new destination before the main app starts redirecting to it.
  const adminEnv = { ...process.env };
  delete adminEnv.WRANGLER_CI_OVERRIDE_NAME;
  delete adminEnv.WRANGLER_CI_MATCH_TAG;
  run(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', 'apps/admin/wrangler.jsonc', '--name', 'spontra-admin', '--keep-vars'], adminEnv);
  run(process.execPath, args);
  run('npm', ['run', 'sec-cron:deploy']);
  // Independent public business map: shares public reads, not ledger bindings or secrets.
  const siteEnv = { ...process.env };
  delete siteEnv.WRANGLER_CI_OVERRIDE_NAME;
  delete siteEnv.WRANGLER_CI_MATCH_TAG;
  run(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', 'apps/business-site/wrangler.jsonc', '--keep-vars'], siteEnv);
  // Public marketing website: static assets only, published by the same main build.
  run('npm', ['run', 'marketing:deploy:ci']);
} finally { rmSync(directory, { recursive: true, force: true }); }
