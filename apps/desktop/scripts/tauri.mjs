// GitHub supplies missing optional secrets as empty strings. Tauri interprets
// an empty signing identity as a requested identity, so omit empty credentials.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const env = { ...process.env };
for (const name of ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID']) {
  if (!env[name]) delete env[name];
}
const result = spawnSync(process.execPath, [require.resolve('@tauri-apps/cli/tauri.js'), ...process.argv.slice(2)], { env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
