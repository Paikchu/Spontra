# G0 baseline — 2026-11-16

Status: baseline objects identified; G0 not fully passed. No code/data mutation or paid research was performed. Full source requirements were read from `/workspace/spontra-requirements/CRWV-earnings-feedback.md` (v2, 58510 bytes) and `/workspace/spontra-requirements/Spontra-分阶段构建与可靠性验收.md` (30575 bytes). AGENTS.md requires real user simulation, no new unit tests. No repo .agents skills found.

## Code / deployment / schema

- Clean main at start: b1d73fcfbb11eaa829d2d4ea97f449cff98c4cf6. GitHub check-runs both success.
- Cloudflare GET deployments confirmed business-map deployment `4038af9b-3e2b-4dbf-b75b-4b8ba876659e`, 100% version `f48e21b3-a5c6-46b7-b1fb-113e9a26a36f`, created 2026-11-16T10:52:18Z.
- Analysis deployment `70f06f3f-d358-486c-96ea-e6b80b0621e8`, 100% version `b6cd385c-c3a3-4e02-b892-36598ae6a7b6`, created 10:51:49Z.
- Read-only D1 SELECT name, applied_at FROM d1_migrations ORDER BY id DESC LIMIT 5 confirmed 0059_retire_d1_filing_library.sql applied 2026-11-15 10:20:30; 0058/0057/0056/0055 also applied. Query meta changes=0, rows_written=0.
- Existing public contracts: analysis-api.v1, analysis-artifact.v1, findings.v1/findings-response.v1, valuation.v1/valuation-response.v1, home-digest.v1.

## Frozen public snapshots

Files in `/tmp/spontra-g0/`, fetched with read-only curl from https://businessview.info/api/business/v1/ . Python urllib returned 403 in this execution environment; curl succeeded, so that error is not evidence of report failure.

| Snapshot | Identity / SHA256 |
|---|---|
| crwv-response.txt | 10-Q 0001769628-26-000465 English, artifact v6, published 2026-11-15T10:03:03.643Z, artifact hash 74e07b8a521f5084c84b920ef82bf442ad993c945e4d9e35d9499098cb0a0179; response hash 93b96a3f4162489de98fd684edcdf99bf6d4be85c2328eb408a8be9ca03a3d52 |
| crwv-repeat.json | Same endpoint second read; full parsed JSON equals first, same artifact hash |
| crwv-zh.json | Same 10-Q v6 zh-CN, published 2026-11-15T10:11:17.958Z, artifact hash 2fbf4713f53f560134ea03098d54c30f5ae8527af1c5372f69a2b940d5e70391 |
| crwv-8k.json | 8-K 0001769628-26-000461 English v3, published 2026-11-11T08:55:25.226Z, artifact hash b81a23f1205f27558d63196cd18da3894a3f36de7b3cfc593a961c57187b4634 |
| crwv-findings.json | findings-response.v1 preparing; nested fingerprint 31ff5b4b57877fd6700b92b4edc59e69d0ab81ff8873ad3a82b22341829fc035, generated 2026-11-15T10:43:29.669Z, 6 leads, 0 legacy findings, dossiers {} |
| nbis-filings.json | filing-digests.v1; latest 6-K 0001104659-26-126238 and 0001104659-26-126008, filed2026-11-12, hasReport true. Response hash f366d33fa06e40181db44340f8008a61cae91ee1fdc0996dc84ab97dd779ebe1 |
| home-response.txt | home-digest.v1 ready, coverage11; response hash 9d7757ab8a1c4944b8e79909f6b7d6ad97ebc6bd9b6f7e6e4948ffca626cee70 |

## Confirmed defects / caveats

- Live Chinese 10-Q HTML contains `900万 资本开支` for 9M capex; visible source labels include `b0bd380亿9564a50d1edfad8f7d1f23` and `b0c510d10.0亿3cf05e0a954983c3d77a`. Source attributes preserve original IDs; visible text is corrupted.
- English artifact includes visible source hash anchors. Compatibility summary bullets=[], analystView='', filing analysisStatus=not_collected despite full artifact.
- DO NOT infer no Analyst articles from empty compatibility fields: read-only D1 query analysis_artifacts found six published dossiers under `c4ced974200f658b`: cash-funding-gap v5, leverage-interest-cover v7, receivables-working-capital v5, rpo-conversion-timing v7, gross-margin-cost-mix v4, capital-return-productivity v7, published 2026-11-16T00:12–00:13Z. These do not align with API snapshot's fingerprint / lead IDs. Root notified for pointer/context investigation.
- Existing company-analysis CRWV published v6 2026-11-15T10:12:34.926Z.
- NBIS listing establishes report availability, not independent audit of underlying 6-K attachment bytes. Need read underlying source materials before production financial claims.

## Existing controls / reusable mechanisms

- `workers/analysis/src/artifact/store.ts`: R2 immutable document then D1 batch; published pointer statements batched; previous published versions marked superseded and historically readable. Caveat: MAX(version)+1 allocation concurrency and pointer failure paths still need G1 fault simulation; source reading alone is not proof.
- `pipeline/registry.ts`: financials.published -> derived/memory/periodic analysis/company analysis; map/fundamentals -> extract/peers/valuation; extract.published + analysis.published -> findings; findings.published -> analyst + valuation. Preserve these consumers.
- `pipeline/workflow-task.ts`: fingerprint failure identity, 1h/6h/24h failed-input retry waits then dead-letter; workflow deadline24h. Queue retries additional configured layer; no new extra loop should be casually stacked.
- `durable-runs/tasks.ts`: step retries limit3. retry-policy model delays30s/90s/180s with jitter.
- `analyst/workflow.ts`: default daily300 turns, approved per-run override, atomic SQL counter reservation before turn, approved allowance exhausted -> NonRetryableError. Existing day/global feature units are not a dollar budget.
- `pipeline/scheduled-analysis.ts`: global/company enable switches. wrangler config transcript daily25; FINDINGS/ANALYST/TRANSLATION enabled defaults. Actual per-company admin switches / current usage still unverified.
- User authorization was updated during investigation: tokens with no monetary limit for this run's macro, AI cloud, CRWV/NBIS shadow. Root must set finite operational bounds and track actual costs. This agent made zero model calls. Earlier absent-budget gap is superseded by that authorization, not grounds to block code.

## G0 remaining evidence / passage status

Pass: exact code and deployed versions; migration version; named baseline report identities; reproducible same-report double read; source requirement identities; isolated snapshots outside repo/production.
Pending: fixture manifest with all golden expected outputs; fixed operational caps/concurrency/max repair attempts; selected human content reviewer and rollback owner; complete NBIS raw material identity and macro five-variable sources; browser baseline at required viewports; actual per-company switches and cost counters; published dossier-to-current-findings alignment. These gaps prevent declaring complete G0 passage and G1–G10 remain unexecuted by this agent. No production migration or new report publication was performed.

Wrangler CLI D1 read failed because CLOUDFLARE_API_TOKEN absent. This was NOT auto-review denial and was resolved for read-only inspection using authorized Cloudflare connector. No credential change needed.
