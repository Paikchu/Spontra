# Deterministic filing reread and republication

Rereading an earnings 8-K or a periodic filing now runs through `identify → reread → republish → complete`. It does not start an AI workflow. No migration, new action, or proxy route is required.

## Admin API

The existing authenticated, same-origin admin proxy accepts:

```http
POST /api/admin/financials/companies/GOOGL/actions
Content-Type: application/json
```

```json
{
  "action": "reread",
  "requestId": "b59d7989-5e48-4c15-9afd-3f45f762235a",
  "accessionNumber": "0001652044-26-000018"
}
```

That example rereads the FY2025 10-K and then republishes. After the task reaches a terminal state, reread the Q4 earnings release to obtain the directly reported split and diluted EPS:

```json
{
  "action": "reread",
  "requestId": "1a774ba4-a569-49e9-8cac-60edb03cd662",
  "accessionNumber": "0001652044-26-000012"
}
```

Use the same `requestId` to redeliver the same request, and a new UUID for a new operation. Read status at `GET /api/admin/financials/tasks/{requestId}`. The internal Analysis routes have the same suffix under `/admin/financials/…`. There is no separate `action: "republish"`; successful rereads automatically queue that stage, even when a better existing quarter wins the history ranking.

A failed/partial task can use the existing retry action:

```json
{
  "action": "retry",
  "requestId": "4483494b-5c97-4b41-8b97-762973f59180",
  "retryTaskId": "b59d7989-5e48-4c15-9afd-3f45f762235a"
}
```

## Rules

- Q4 split-versus-placeholder ranking allows a difference of `max(1,000,000 / scale, 0.0001 × max(abs(totalA), abs(totalB)))`. Currency, scale, and both period boundaries must match. This accommodates independently rounded FY/9M and earnings-release totals. It does not relax the existing quarter reconciliation validator or change Q1–Q3 ranking.
- The directly reported consolidated total is retained. A `rounding` revenue adjustment records its signed difference from the verified split, operand provenance, and formula. Repeated reconciliation updates that adjustment instead of duplicating it.
- Product/service-axis facts and consolidated income-statement revenue lines cannot establish reportable segments. Business-segment-axis evidence remains authoritative. Whole-company single-segment disclosure, or the latest consolidated issuer's standard reportable-segment count, authorizes `single_reportable_segment`. Generic accounting-standard examples and subsidiary counts do not. Existing product children beneath verified segments remain supported.
- An 8-K split requires matching names from periodic reportable-segment evidence. Product-only anchors cannot authorize it. Diluted EPS comes independently from the GAAP quarterly income statement and reaches public fundamentals, including issuers identified through maintenance/history before `sec_filings` ingestion.
- Maintenance reread handles at most one filing per invocation, retaining its facts and remaining filings in a task-scoped `sec_cache` checkpoint. It renews the live lease at I/O/checkpoint boundaries. History writes are fenced by task ID, lease token, status, and expiry. Expired running data tasks are automatically retried with the checkpoint, up to three attempts per unfinished step; exhausted tasks expose `LEASE_EXPIRED`. Cancellation is never retried.
- Republication rebuilds revenue presentation against the current stored complete statement pair; it preserves the statement amounts and validates the result. The immutable version, current pointer, and company/fundamentals/capital revisions commit in one batch. Known share-class aliases also receive revisions. The request ID determines the immutable version ID, making retries idempotent.
- Reread archive writes suppress `filing.archived` and `archive.superseded` events. Republication also bypasses the outbox. This prevents indirect model workflows while retaining archive audit data and superseded-object records.

## Local verification

```sh
node --experimental-strip-types --no-warnings workers/analysis/test/b10-followups.test.ts
npm test
npm run typecheck
node node_modules/typescript/bin/tsc --noEmit -p workers/analysis/tsconfig.json
npm run check
npm run lint
node --experimental-strip-types --no-warnings /workspace/b10-followups/verify.ts --reread
```

The external verification script uses only the supplied exhibits/annual and quarterly filings, synthetic covers carrying their local Exhibit 99.1 links, and an in-memory cache. It makes no HTTP requests or Cloudflare D1 writes. It compares all ten Q4 results, Q1–Q3 revenue preservation, and the public diluted-EPS series. `--cached-facts` optionally reuses this script's own parsed files for its preliminary comparison; actual reread still parses the local documents.

## Limits

- A complete statement pair must already exist. Without it, republication explicitly returns partial (`REPUBLICATION_NO_COMPLETE_STATEMENTS`); revenue history cannot invent a complete income statement.
- A material disagreement with the stored statement revenue prevents republication (`REPUBLICATION_REVENUE_CONFLICT`). No accounting line is fabricated to close it.
- The supplied BRK.B earnings exhibit has no usable quarterly diluted EPS; it remains missing. Some releases have no table matching reportable segments; verified FY−9M segment revenue is retained.
- Existing terminal failed tasks are not reopened. Their existing retry action starts a new bounded task. The deployment of this code and any live maintenance requests remain outside this local change.
