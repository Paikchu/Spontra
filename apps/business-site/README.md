# Spontra Read API Gateway & Preview Host (`spontra-business-map`)

Headless read-only API gateway for the iOS client (`SpontraApp`) plus the minimal signed report preview host (`/article-preview` and `/artifact-frame`) used by Spontra Analysis visual QA and admin translation previews. All public Business Map and search web pages (`/`, `/companies/*`, `/research/*`, `/agents/*`) have been removed and return `404`.

## Layout

| Path | What it holds |
| --- | --- |
| `src/` | Minimal signed preview shell (`ArtifactPreviewPage.tsx`, `ArtifactFrame.tsx`, `ArtifactLanguage.tsx`) and sandboxed `/artifact-frame` runtime (`src/artifact-frame/`). |
| `public/spontra-ios/` | iOS App Store privacy policy and support page (`/spontra-ios/`). |
| `public/_headers` | CSP and security headers per path. |
| `worker/index.ts` | The Worker: `/api/business/v1/*` read routes, edge caching, rate limits, and gated preview asset routing. |
| `worker/home-model.ts` | Home digest schema parser/validator. |

Shared utilities come from `packages/web/`; contracts and verification shared with the backend come from `shared/analysis-contract/` and `shared/analysis-runtime/`.

## Data

- Reads go to Spontra Analysis over the `SPONTRA_ANALYSIS` Service Binding to its `MapReads` named entrypoint. A named entrypoint is unreachable from the public internet, so the binding is the credential and the gateway keeps no key.
- API routes: `/api/business/v1/home`, `/findings`, `/tickers/:ticker`, `/research`, `/artifact-preview/:token`, and `/api/business/v1/companies/:ticker` with `/opening`, `/revision`, `/capital`, `/findings`, `/fundamentals`, `/events`, `/insiders`, `/filings`, `/filings/:accession`, `/items/:accession`, `/market-daily`, and `/valuation` (with versions and evidence).
- Public reads are limited per IP (`PUBLIC_READ_LIMIT`, 300/min) and cached at the edge. `global_fetch_strictly_public` keeps any stray global fetch on public routing.

## Local development

```bash
npm run dev    # 127.0.0.1:4188; /api proxies to BUSINESS_SITE_API or 127.0.0.1:8788
```

## Validation

```bash
npm run business-site:typecheck
npm run business-site:build
npm run business-site:check   # deploy dry run
```

## Release

Push verified code to `origin/main` per `AGENTS.md`; never deploy locally. The gateway-and-admin build deploys this Worker.
