/** Only Cloudflare's Git build may deploy. Never run this entry point locally. */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { migrateLegacyPortfolio, migrationDatabase, readMigration, markPortfolioActivation, unfreezeLegacyPortfolio } from './portfolio-migration.ts';
if (!process.env.CI) throw new Error('Deployment is restricted to the Git main CI build.');
const credential = process.env.DESKTOP_ACCESS_TOKEN;
const portfolioToken = process.env.PORTFOLIO_READ_TOKEN;
const portfolioSiteToken = process.env.PORTFOLIO_SITE_READ_TOKEN;
const siteReadToken = process.env.BUSINESS_SITE_READ_TOKEN;
if (siteReadToken && !/^[!-~]{24,512}$/.test(siteReadToken)) throw new Error('Invalid business map read credential configuration.');
if (!portfolioToken || !/^[!-~]{32,512}$/.test(portfolioToken)) throw new Error('Set PORTFOLIO_READ_TOKEN in the main Git build secrets before releasing.');
if (portfolioSiteToken && !/^[!-~]{32,512}$/.test(portfolioSiteToken)) throw new Error('Invalid portfolio Site read credential configuration.');
if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error('Cloudflare CI API credential is required for portfolio migration.');
const appConfig = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
const syncConfig = JSON.parse(readFileSync('workers/sec-cron/wrangler.jsonc', 'utf8'));
const source = migrationDatabase(appConfig.account_id, appConfig.d1_databases.find(binding => binding.binding === 'DB').database_id, process.env.CLOUDFLARE_API_TOKEN);
const target = migrationDatabase(syncConfig.account_id, syncConfig.d1_databases.find(binding => binding.binding === 'DB').database_id, process.env.CLOUDFLARE_API_TOKEN);
let migrationStarted = false;
let activationStarted = false;
if (credential && !/^[!-~]{32,512}$/.test(credential)) throw new Error('Invalid desktop access credential configuration.');
const directory = mkdtempSync(join(tmpdir(), 'spontra-deploy-'));
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: 'inherit', env });
  if (result.error || result.status !== 0) throw new Error(`CI deployment step failed: ${command}`);
}
async function removeRetiredSecret(worker, name) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${appConfig.account_id}/workers/scripts/${worker}/secrets`;
  const headers = { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` };
  const listed = await fetch(url, { headers });
  if (!listed.ok) throw new Error(`Cannot verify retired credentials for ${worker}`);
  const secrets = await listed.json();
  if (!secrets.result.some(secret => secret.name === name)) return;
  const removed = await fetch(`${url}/${name}`, { method: 'DELETE', headers });
  await removed.body?.cancel();
  if (!removed.ok) throw new Error(`Cannot retire ${name} from ${worker}`);
  console.log(JSON.stringify({ event: 'retired-worker-credential', worker, name }));
}
try {
  run('npm', ['run', 'check:portfolio:boundary']);
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
  const path = join(directory, 'app-secrets.json');
  writeFileSync(path, JSON.stringify({ PORTFOLIO_READ_TOKEN: portfolioToken, ...(credential ? { DESKTOP_ACCESS_TOKEN: credential } : {}) }), { mode: 0o600 });
  args.push('--secrets-file', path);
  const syncSecrets = join(directory, 'sync-secrets.json');
  writeFileSync(syncSecrets, JSON.stringify({ PORTFOLIO_READ_TOKEN: portfolioToken, ...(portfolioSiteToken ? { PORTFOLIO_SITE_READ_TOKEN: portfolioSiteToken } : {}) }), { mode: 0o600 });
  // Publish the new destination before the main app starts redirecting to it.
  const adminEnv = { ...process.env };
  delete adminEnv.WRANGLER_CI_OVERRIDE_NAME;
  delete adminEnv.WRANGLER_CI_MATCH_TAG;
  run(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', 'apps/admin/wrangler.jsonc', '--name', 'spontra-admin', '--keep-vars'], adminEnv);
  run('npm', ['run', 'sec-cron:migrate:ci']);
  const previousMigration = await readMigration(target);
  activationStarted = Boolean(previousMigration && previousMigration.phase !== 'copied');
  migrationStarted = true;
  const migration = await migrateLegacyPortfolio(source, target);
  activationStarted ||= migration.status === 'already_active';
  console.log(JSON.stringify({ event: 'portfolio-migration', ...migration }));
  // Persist intent before deploying: an interrupted/ambiguous release must never recopy old data.
  activationStarted = true;
  await markPortfolioActivation(target, 'activating');
  run(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', 'workers/sec-cron/wrangler.jsonc', '--name', 'spontra-max-data-sync', '--keep-vars', '--secrets-file', syncSecrets], adminEnv);
  const hasSavedPortfolio = (await target.query("SELECT id FROM portfolio_state WHERE id = 'current'")).length > 0;
  const response = await fetch('https://spontra-max-data-sync.max-zhangyuchen.workers.dev/api/v1/portfolio', {
    headers: { authorization: `Bearer ${portfolioToken}` }, redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Portfolio read API verification failed (HTTP ${response.status})`);
  const body = await response.json();
  if (body.portfolio === undefined || (hasSavedPortfolio && !body.portfolio)
    || response.headers.get('cache-control') !== 'private, no-store'
    || !['current', 'delayed', 'uninitialized'].includes(body.syncStatus)
    || (body.portfolio && (body.portfolio.source || body.portfolio.capitalFlows || !body.reportDate || !body.syncedAt))) {
    throw new Error('Portfolio read API contract verification failed');
  }
  await markPortfolioActivation(target, 'active');
  run(process.execPath, args);
  await removeRetiredSecret(appConfig.name, 'PORTFOLIO_SYNC_KEY');
  await removeRetiredSecret(syncConfig.name, 'MAX_SITE_BYPASS_TOKEN');
  // Independent public business map: shares public reads, not ledger bindings or secrets.
  const siteEnv = { ...process.env };
  delete siteEnv.WRANGLER_CI_OVERRIDE_NAME;
  delete siteEnv.WRANGLER_CI_MATCH_TAG;
  // The map reads the pipeline over its binding with its own credential; CI writes it when the build holds one, else the stored secret stays (--keep-vars).
  const siteArgs = ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', 'apps/business-site/wrangler.jsonc', '--keep-vars'];
  if (siteReadToken) {
    const siteSecrets = join(directory, 'site-secrets.json');
    writeFileSync(siteSecrets, JSON.stringify({ EARNING_REPORT_READ_TOKEN: siteReadToken }), { mode: 0o600 });
    siteArgs.push('--secrets-file', siteSecrets);
  }
  run(process.execPath, siteArgs, siteEnv);
  // Public marketing website: static assets only, published by the same main build.
  run('npm', ['run', 'marketing:deploy:ci']);
} catch (error) {
  if (migrationStarted && !activationStarted) {
    const latest = await readMigration(target);
    if (!latest || latest.phase === 'copied') await unfreezeLegacyPortfolio(source);
  }
  throw error;
} finally { rmSync(directory, { recursive: true, force: true }); }
