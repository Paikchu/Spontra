/** Only Cloudflare's Git build may deploy. Never run this entry point locally. */
import { spawnSync } from 'node:child_process';
if (!process.env.CI) throw new Error('Deployment is restricted to the Git main CI build.');
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: 'inherit', env });
  if (result.error || result.status !== 0) throw new Error(`CI deployment step failed: ${command}`);
}
// Validate both apps before either is released.
run('npm', ['run', 'business-site:typecheck']);
run('npm', ['run', 'admin:typecheck']);
run('npm', ['run', 'test:unit']);
run('npm', ['run', 'build']);
// Workers Builds names the connected Worker through these variables; each app deploys under its own config name.
const env = { ...process.env };
delete env.WRANGLER_CI_OVERRIDE_NAME;
delete env.WRANGLER_CI_MATCH_TAG;
const wrangler = 'node_modules/wrangler/bin/wrangler.js';
run(process.execPath, [wrangler, 'deploy', '--config', 'apps/admin/wrangler.jsonc', '--keep-vars'], env);
// The map reads the pipeline over a named-entrypoint binding; the binding is its credential, so no secret is written here.
run(process.execPath, [wrangler, 'deploy', '--config', 'apps/business-site/wrangler.jsonc', '--keep-vars'], env);
