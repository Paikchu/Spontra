# Business map

The public BusinessView site, Worker `spontra-business-map`: a Vite + React page and the Worker that serves it. Every figure, finding and analysis comes from Spontra Analysis; the site runs no collection or model work on page reads.

## Layout

| Path | What it holds |
| --- | --- |
| `src/` | The page: home (`Home.tsx`), company page (`CompanyPage.tsx`, `BusinessMap.tsx`), the Sankey, mind map, trend and metric panels, the rail, findings, lens, filings and events, insiders, valuation. `*-model.ts` files are the pure logic the components draw from; tests in `test/` cover them. |
| `src/stage/` | The stage agent on the company page. |
| `src/lens-frame/`, `lens-frame.html` | The same-origin frame that paints a finding's lens charts. |
| `public/html-frame.html` | The sandboxed frame for model-written chart HTML. |
| `public/_headers` | CSP and security headers per path. |
| `worker/index.ts` | The Worker: data routes, the stage door, caching and rate limits. |
| `worker/telemetry-store.ts` | `TelemetryStore`, the Durable Object behind `/api/business/v1/telemetry`. |

Shared UI comes from `packages/web/`; contracts and verification shared with the backend come from `shared/analysis-contract/` and `shared/analysis-runtime/`. Strings are localized in place with `messages(en, zh)` ([docs/i18n-conventions.md](../../docs/i18n-conventions.md)).

## Data

- Reads go to Spontra Analysis over the `SPONTRA_ANALYSIS` Service Binding to its `MapReads` named entrypoint. A named entrypoint is unreachable from the public internet, so the binding is the credential and the site keeps no key. Without the binding the data routes answer 503 and the shell still serves.
- Routes: `/api/business/v1/home`, `/findings`, `/tickers/:ticker`, `/telemetry`, and `/api/business/v1/companies/:ticker` with `/opening`, `/revision`, `/capital`, `/findings`, `/fundamentals`, `/events`, `/insiders`, `/filings`, `/filings/:accession`, `/items/:accession`, `/passages/:id` and `/valuation` (with versions and evidence) under it.
- The page re-validates every response against the shared contracts and withholds what does not verify (findings, highlights, lens documents, quotes).
- `/agents/*` reaches the stage over the second binding `SPONTRA_STAGE` (`StageGateway` entrypoint), same-origin only and limited per address (`AGENT_LIMIT`).
- Public reads are limited per IP (`PUBLIC_READ_LIMIT`, 300/min) and cached at the edge. `global_fetch_strictly_public` keeps any stray global fetch on public routing.

## Local development

```bash
npm run dev    # 127.0.0.1:4188; /api proxies to BUSINESS_SITE_API or 127.0.0.1:8788
```

## Validation

```bash
npm run business-site:typecheck
npm run test:business-site
npm run business-site:build
npm run business-site:check   # deploy dry run
```

## Release

Push verified code to `origin/main` per AGENTS.md; never deploy locally. The map-and-admin build deploys this Worker. A map deploy that lands before Spontra Analysis has published a new entrypoint fails its binding check and is redeployed by the next push.
