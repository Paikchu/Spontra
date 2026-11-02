# B10 production regression fixtures

- `jpm-publication.json`: unchanged `/workspace/b10-followups/data/jpm_prev.json`. Both quarters are necessary for the complete-publication validation gate.
- `jpm-history.json`: only 2026-09-30 from `data/jpm_hist.json`, with its total-only placeholder and provenance unchanged.
- `jpm-damaged-publication.json`: the unchanged `flow` from `/workspace/b10-followups/data/JPM.json`, formatted as JSON. Its 2026-09-30 quarter has already been downgraded to the placeholder. Tests use a representative `reread:728aac1c-damaged` version ID; the complete production ID is not in the supplied payload.

Tests use only local fixtures and in-memory SQLite with the repository migrations. They cover recovery from the latest non-reread version, issuer isolation, fallback, immutable versions, idempotency, cache revisions and the current-version fence. No production reads or writes and no network are required.

GOOGL's reported defect was a stale CDN response. The unrelated reread/history changes and their fixtures were removed; history and checkpoint versions remain unchanged.
