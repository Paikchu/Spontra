# Public business map

Independent Vite/React frontend and Cloudflare Worker; existing Spontra routes remain intact.

- Public entry: `/companies/ORCL`; `/` is company selection. No portfolio or other tabs.
- Reuses `BusinessFlow`, `FinancialSankey`, their stylesheet, model, graph validation and versioned public flow contract directly from this repository. No duplicate diagram implementation.
- Only API: `GET /api/business/v1/companies/:ticker`. Fixed public upstream origin; no user-supplied URL or query, no cookie/auth forwarding. The SEC flow is schema-validated and unknown fields are stripped at every level. No company analysis envelope, private research, run state, portfolio, IBKR or generation routes are returned.
- Curated public company descriptions and flow segment explanations provide business reading. AI report paragraphs are deliberately not exposed by this first public endpoint.
- SEC fundamentals can supply partial same-company flow when a published full flow is absent. Unknown values stay missing. Financial/insurance, losses, negative expense reversals and incomplete statements use the existing disclosed-detail fallback.
- Uses `global_fetch_strictly_public` so the fixed public upstream follows Cloudflare public routing instead of bypassing the other Worker. No database, Service Binding, credential or scheduled task. Rate-limit binding: 60 requests/minute per IP. Missing limiter fails closed. Successful public output is cached for 60 seconds. SEC refresh remains in the existing backend, not page visits.
- Two small shared dependencies required by this public migration: safe fallback SEC accession lookup (CIK cannot be inferred from accession), and reject negative individual expense reversals before Sankey grouping. Other pending project-audit changes are excluded.

## Validation

`npm run business-site:typecheck`, `npm run business-site:build`, `npm run business-site:check` (dry run), and `tsx --tsconfig tsconfig.test.json --test tests/business-site.test.ts tests/business-flow.test.tsx`.

Local Worker preview: `wrangler dev --config apps/business-site/wrangler.jsonc`. Older local workerd may require `--compatibility-date 2026-09-04` for preview only.

## Release

Push verified code to `origin/main`, following AGENTS.md. Existing Cloudflare Git CI builds/deploys the new app as a separate `spontra-business-map` Worker after the original application. Never deploy locally. CI name overrides are removed for the new Worker so it cannot replace the Spontra Worker. Assets and configuration are independent, while the release trigger currently shares the established main CI. A dedicated Git build target can be configured later without changing frontend/backend boundaries.

Initial complete-flow coverage: ORCL, actual public SEC quarters. Other companies depend on current backend availability; this does not assert universal extraction coverage. No fixture is imported by production code.
