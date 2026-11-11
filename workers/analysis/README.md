# Spontra Analysis

Worker `spontra-analysis`: SEC discovery and archiving, deterministic financial collection, every AI analysis, and the read APIs for the business map and the admin. It owns the analysis D1 `earning-report-analysis-sec-web` and the R2 bucket `earning-report-analysis-sec-filings`.

## Entry points

| Entry | Who reaches it | What it serves |
| --- | --- | --- |
| `MapReads` | Business map, Service Binding `SPONTRA_ANALYSIS` | Read API only, fixed identity `business-map` |
| `StageGateway` | Business map, Service Binding `SPONTRA_STAGE` | The stage: identities, conversations, `StageAgent` sockets |
| `AdminGateway` | Admin, Service Binding `SPONTRA_ANALYSIS` | `/admin/*` routes with a fresh admin session per request |
| Default `fetch` | Public internet | Read API; `/admin/*` needs a signed session |
| `scheduled` (`*/10`) | Cron | SEC discovery and reference closes only. The admin's 定时分析 switches (companies page: the column head for every company, each row for one company, whose own switch decides for it) silence discovery's events and task-version re-runs and hold runs already queued for the companies that are off; all of it goes out once a company is on again, and admin actions ignore it |
| `queue` | `spontra-pipeline-events`, `-tasks`, `-dlq` | Every other task |

A named entrypoint is unreachable from the public internet, so the binding is the credential.

## Source layout

| Path | Role |
| --- | --- |
| `src/sec-archive/` | The only EDGAR reader ([docs/sec-archive.md](../../docs/sec-archive.md)); everything else reads archived filings from D1 + R2 |
| `src/sec/`, `src/financial-data/`, `src/filing-library/` | Filing parsing, deterministic statements ([financial-data.md](financial-data.md)), the parsed filing library |
| `src/pipeline/`, `src/events/` | Event routing and task registry; SEC events (8-K, Form 4) |
| `src/findings/`, `lens/`, `analyst/`, `items/` | Findings, their lens documents, analyst dossiers, per-filing analysis |
| `src/business-explainer/`, `business-tree/`, `business-tags/`, `peers/` | Business dossiers, the mind map, two-level tags and peers |
| `transcripts/`, `valuation/`, `fundamentals/`, `translation/` | The transcript library, valuation, fundamentals, Chinese translations |
| `src/stage/` | The stage agent and reader reports |
| `src/web-search/` | Cached web search and page reads ([docs/web-search.md](../../docs/web-search.md)) |
| `src/read-api/`, `src/admin/` | Read routes and admin routes |
| `src/agent-loop.ts`, `tool-loop.ts`, `tools/`, `compose/`, `model-*.ts`, `ai-config.ts` | The shared model, tool and agent loop layer; `ai-config.ts` lists every model use and its reasoning level |
| `migrations/` | The full D1 migration history |
| `scripts/` | Hand-run ops scripts ([scripts/README.md](scripts/README.md)) |

Workflows (16) are declared in `wrangler.jsonc` and exported from `src/index.ts`. Companies come only from the admin whitelist and feature switches in D1; no Wrangler variable lists companies. All model calls go to DeepSeek through its Anthropic-compatible endpoint with `DEEPSEEK_API_KEY`.

Imports are limited to this directory, `shared/analysis-contract/` and `shared/analysis-runtime/` (`npm run check:analysis:boundary`).

## Local development

```bash
npx wrangler dev --config workers/analysis/wrangler.jsonc
```

Copy [`.dev.vars.example`](.dev.vars.example) to `.dev.vars`; real `.dev.vars*` files are ignored by Git.

## Validation

From the repository root:

```bash
npm run check:analysis:boundary
npm run analysis:typecheck     # type check
npm run analysis:check         # deploy dry run
```

## Release

Push to `origin/main` (see AGENTS.md); never deploy locally. CI runs `analysis:deploy`, which applies and verifies the D1 migrations before publishing the Worker with `--keep-vars`. Always pass `--config workers/analysis/wrangler.jsonc` to Wrangler for this Worker.
