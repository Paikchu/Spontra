# SP-21 implementation and validation

Implemented on `codex/SP-21` in `/Users/max/Developer/Spontra/.worktrees/SP-21`, based on deployed `origin/main` commit `a59457320a420d3f6cfb0d4eeeb0297d04033cff`. The original checkout and its pending user changes were preserved. Initial implementation was released after explicit user authorization as `1c776d1993b8389888b65b248b9d40a86a6dbc89`; both Cloudflare automatic builds succeeded, and public HTML served the matching bundle. Local browser validation below predates that release.

## Implementation

- Extend the existing company-agnostic business explainer's bounded web search, model synthesis and independent review with evidence-backed product offerings: product name, optional product line, plain-language introduction and optional charging claim. Unknown lines or modes stay unknown. Rejected mappings are removed. Sources remain in the public contract; no product revenue values exist.
- Increment the explainer prompt fingerprint so existing publications regenerate through the established background sweep. Reads and selection never start AI jobs. The existing one-run-per-tick and weekly failed-run retry bounds remain.
- Selecting a Sankey business adds product → product line → selected business connections. Shared lines appear once; dashed constant-width links encode qualitative ownership, while existing revenue bands retain their actual amounts. Charging labels sit on product relationships.
- Animate expansion and camera recentering; automatically show every added product and selected revenue strip. Drag to pan, use ± to zoom, and use “适应画布” for the complete statement. Repeated selection, the close control, All Businesses and Escape return to the original view. Quarter selection resets the camera. Nonproportional accounting layouts use the same product branches in a separate qualitative canvas with pan, zoom and fit controls; their original signed/financial/insurance accounting view remains below.
- Retain the deployed shadcn components. Remove product tags and redundant AI footer; replace “怎么运作” with “产品介绍”. New introductions describe what each product does. Other customer, business charging and relationship fields retain their content.

## Evidence and acceptance

Browser: **local Google Chrome**, headed, driven by Playwright CLI. Preview: `http://127.0.0.1:4188`. Local API server at port 8788 returns saved public snapshots or explicitly synthetic test responses; this preview is not production.

Public source snapshots were fetched on 2026-10-05 from the deployed `/api/business/v1/companies/ORCL` and `/AAPL` endpoints. URLs and SHA-256 hashes are in `output/playwright/public-data-provenance.json`.

| Check | Result | Evidence type |
| --- | --- | --- |
| Oracle business hierarchy, real financial amounts, old explainer compatibility | Pass | Actual public snapshot; no new AI products asserted |
| Apple geographic revenue structure, absence of product mapping | Pass | Actual public snapshot; no Oracle fallback |
| Repeated selection, close, business switch, quarter switch, Escape | Pass | Chrome interaction assertions on Oracle real data |
| Zoom, drag pan, fit complete canvas | Pass | Chrome interaction assertions |
| Nonproportional/signed fallback retains product relationships and no invented widths | Pass | Synthetic negative-net Apple variation; same product/line/mode and viewport assertions |
| Product nodes, one shared line, known and unknown charging labels | Pass | Chrome assertions on **clearly labelled synthetic offerings** for Oracle and Apple |
| All added product cards inside SVG viewport | Pass | Actual browser bounding-box assertions for both fixtures |
| Transition frame sample | Pass | Local Chrome: 29 sampled frame intervals, mean 8.6 ms, max 16.7 ms; hardware-specific observation, not a claim about all devices |
| Product selection adds no API reads | Pass | Browser resource-count comparison before/after close and reopen; development StrictMode initial reads are not mistaken for interaction calls |
| Removed tags and AI footer | Pass | Browser DOM assertions |
| Loading, empty publication, HTTP 503, retry remains usable | Pass | Synthetic delayed/empty/failing API, browser snapshots and screenshots |
| Novice comprehension | Implementation reviewed | Fixture examples describe remote computers, storing files, phone use and tablet use without unexplained acronyms; actual generated descriptions remain pending |
| New AI search → generation → evidence review → published product output | **Not verified** | No fixture is represented as a real model result |

Screenshots in `output/playwright/`:

- `ORCL-real-products.png`: actual Oracle old explanation, new structure explicitly unknown.
- `AAPL-real-no-products.png`: actual Apple regional business and missing product mapping.
- `ORCL-structured-fixture.png`, `AAPL-structured-fixture.png`: names visibly prefixed with `[测试夹具]`; real financial snapshot with synthetic product nodes only.
- `signed-fallback-fixture.png`: synthetic negative-net Apple variation; not a real Apple loss.
- `loading-fixture.png`, `empty-fixture.png`, `failure-fixture.png`: synthetic edge states.

Browser assertion source is retained as `oracle-interactions.js`, `product-structure-check.js` `fallback-canvas-check.js` and `animation-check.js`. These are CLI snippets, not production code or Playwright test suites.

## Automated checks

Passed:

- `npm run typecheck`
- `npm run business-site:typecheck`
- `npm run typecheck:pipeline`
- `npm run check:pipeline:boundary`
- `node --experimental-strip-types --test tests/pipeline/business-explainer.test.ts` — 10 tests including ownership evidence regression
- `npx tsx --tsconfig tsconfig.test.json --test tests/business-site.test.ts tests/business-flow.test.tsx` — 37 tests
- `npm run business-site:build`
- `npm run build`
- `git diff --check`

## Remaining acceptance

Automatic approval review rejected a combined command that would read `.env.local` and `workers/pipeline/.dev.vars` to inspect configured credential field names, because those files can contain API keys and reading them is not necessary for browser validation. The command did not run. No alternate path was used to obtain those secrets.

Safe follow-up: in an already authorized staging/runtime environment with credentials supplied by that environment, run the existing background BusinessExplainer workflow against this branch for Oracle and Apple. Verify actual offerings, each product/line assignment and charging citation against the fetched sources, review the generated text from a novice perspective, then render the resulting public response. This does not require copying or printing keys into the chat or local files. Production publication was explicitly authorized subsequently and follows the GitHub-main-only deployment process.

The proportional Sankey path was covered with Oracle and Apple, and the shared qualitative fallback product canvas was covered with a synthetic negative-net variation. Actual financial/insurance issuer data and newly generated AI outputs remain additional acceptance items; no fixture establishes real issuer product membership or pricing.


## Production data acceptance correction

Actual Autodesk v2 generation completed, but failed content acceptance: it placed Flow Production Tracking under Manufacturing using a company-wide cloud product list. Its official product page describes film, animation and game production management (https://www.autodesk.com/products/flow-production-tracking/overview). No model completion is treated as factual validation.

The v4 correction requires each generated offering to carry a short verbatim `membership` passage citing the specific business and product together. Normalization verifies the passage exists in its cited fetched material and mentions both entities; independent review must assess actual ownership rather than co-occurrence. The passage and source IDs remain in the public data layer. Unsupported mappings are dropped; no product-name blacklist or issuer-specific override exists. Previously generated structured offerings lacking membership evidence are withheld by the public reader, and an empty reviewed list no longer falls back to a company-wide product list. Original explanations without the offerings field retain legacy compatibility.

Regression verifies a real business/product passage passes, a company-wide product list fails, a fabricated mapping quote fails, evidence survives the public parser, and legacy structured offerings without evidence are withheld. Related 37 frontend/accounting tests, 10 explainer tests, all type checks, boundary check, application/site builds and Pipeline dry-run passed again. One incorrectly configured test command omitted `tsconfig.test.json` and failed with React undefined; the correctly configured runner passed all 37 tests.

Native computer use currently resolves Chrome to the unrelated Xiaohongshu window. No actions were taken there. The requested independent business-map window must be foregrounded before native animation verification; this acceptance remains pending.

Real v3 step inspection found the prior coarse review removed all offerings when only HCM/CX descriptions were unsupported, losing a supported ERP mapping. v4 requires review issues to identify the normalized product ID and removes only that product. Unknown or missing product IDs retain the conservative whole-field rejection. The v3 Oracle run was terminated after this finding; Autodesk was terminated while queued, before model execution. A regression verifies one rejected product leaves its verified sibling intact. No business aliases were invented to relax ownership matching; unsupported acronym-only passages remain withheld.
