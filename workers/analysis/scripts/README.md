# Spontra Analysis scripts

Run these commands from the repository root with dependencies installed and Node.js >=22.13.0.
Each script's source describes its options and inputs.

| Script | Invocation | Access and required environment |
| --- | --- | --- |
| `backfill-insider-ledger.ts` | `node --experimental-strip-types workers/analysis/scripts/backfill-insider-ledger.ts --tickers NVDA` | Fills the by-person insider ledger (`insider_transactions`, `insider_persons`) with a company's whole Form 4 history read from EDGAR; another issuer's filings are left out (B1). Requires `SEC_USER_AGENT` or `--user-agent`. Dry run by default: writes a SQL file (`--out`) and nothing to D1. `--apply` runs the file through Wrangler against remote D1 (`--local` for the local database) and needs Wrangler authentication. `--since`, `--max` and `--cik` narrow the read. |
| `check-fundamentals-fresh.ts` | `node --experimental-strip-types workers/analysis/scripts/check-fundamentals-fresh.ts --tickers GOOGL,NBIS` | Read-only public HTTP freshness check; `--origin` overrides the public site. No environment variables required. |
| `check-migrations.ts` | `npm run analysis:check:migrations` | CI gate comparing local migration files with the remote D1 ledger via SELECT; no writes. Requires Wrangler authentication and access to the configured account. Optional overrides: `SEC_WRANGLER_CONFIG`, `SEC_WRANGLER_BIN` (legacy aliases: `SEC_WEB_WRANGLER_CONFIG`, `SEC_WEB_WRANGLER_BIN`). |
| `clean-foreign-insider.ts` | `node --experimental-strip-types workers/analysis/scripts/clean-foreign-insider.ts --tickers BRK.B` | Maintenance preview: reads D1 and SEC documents; no writes by default. Requires `SEC_USER_AGENT` or `--user-agent` with SEC contact information, plus Wrangler authentication for D1. `--source api` uses public HTTP reads; `--local` selects local D1. Adding `--apply` with D1 writes publications/cache entries and a temporary SQL file. |
| `segment-basis-dry-run.ts` | `node --experimental-strip-types workers/analysis/scripts/segment-basis-dry-run.ts --tickers MSFT,SPCX` | Read-only public HTTP segment comparison; no environment variables required. `--source d1` uses SELECTs instead and requires Wrangler authentication for remote D1; `--local` selects local D1. |
| `valuation-dry-run.ts` | `node --experimental-strip-types --no-warnings workers/analysis/scripts/valuation-dry-run.ts --data-dir /path/to/data --ticker ORCL` | Offline comparison of valuation priors and published drivers using saved input files; no environment variables required. Prints to stdout; `--out ORCL.md` and `--json ORCL.json` write/overwrite local files. See its header for the data directory layout. |

Remote D1 commands use Wrangler login or `CLOUDFLARE_API_TOKEN` with access to the configured account.
