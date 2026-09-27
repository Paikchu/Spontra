/** Only Cloudflare's Git build may deploy. Never run this entry point locally. */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
if (!process.env.CI) throw new Error('Deployment is restricted to the Git main CI build.');
const credential = process.env.DESKTOP_ACCESS_TOKEN;
if (credential && !/^[!-~]{32,512}$/.test(credential)) throw new Error('Invalid desktop access credential configuration.');
const directory = mkdtempSync(join(tmpdir(), 'spontra-deploy-'));
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
  if (result.error || result.status !== 0) throw new Error(`CI deployment step failed: ${command}`);
}
try {
  run('npm', ['run', 'db:migrate:remote']);
  const args = ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', 'dist/server/wrangler.json', '--keep-vars'];
  if (credential) {
    const path = join(directory, 'desktop-secret.json');
    writeFileSync(path, JSON.stringify({ DESKTOP_ACCESS_TOKEN: credential }), { mode: 0o600 });
    args.push('--secrets-file', path);
  }
  run(process.execPath, args);
  run('npm', ['run', 'sec-cron:deploy']);
} finally { rmSync(directory, { recursive: true, force: true }); }
