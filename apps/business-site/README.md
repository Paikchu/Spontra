# Public business map

Independent Vite/React frontend and Cloudflare Worker; existing Spontra routes remain intact.

- Public entry: `/companies/ORCL`; `/` is company selection. No portfolio or other tabs.
- Two-pane layout, no pan/zoom canvas: the business list (revenue tree, share, QoQ, sourced business notes) on the left; the full revenue → profit Sankey fitted to the right pane. Selecting a business traces its own slice through each parent band into total revenue, with a flowing animation and its share of revenue. Costs and profit are never allocated to a business. Selection is kept in `?business=`.
- `FlowChart` renders from the shared graph (`financialGraph`) and layout (`layoutInfographic`, with one-line label geometry and a type scale solved per pane so labels stay legible). Signed, financial and insurance statements fall back to the shared `FinancialSankey` bridge. Business hues are a validated four-slot palette assigned per business, stable across quarters; further top-level businesses use a neutral tone.
- Below the Sankey, an eight-quarter revenue trend from the pipeline's `history` field: stacked by business for 全部业务, morphing into the selected business (its children stacked) with staggered height transitions. Quarters disclosed under another business presentation show company revenue or an explicit gap; fourth quarters derived as full year minus nine months are labelled.
- The rail is a floating rounded card inset from the page edges. Its pinned top holds the company mark (ticker plus logo), a search button and the theme toggle; the business list scrolls beneath. Search opens a centered native modal dialog (also ⌘K / Ctrl+K or `/`) that takes a ticker and lists companies recently opened in this browser (only ones the API answered for). Below 960px the rail dissolves into a top bar and sticky business chips.
- The company mark shows the ticker and its logo from the same public image host the main app uses (`images.financialmodelingprep.com`, the only external origin in CSP `img-src`, no referrer); a ticker monogram remains when it fails.
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
