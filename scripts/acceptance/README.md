# Spontra Acceptance Scripts

Run these commands from the repository root with dependencies installed and Node.js >=22.13.0.

| Script | Invocation | Purpose |
| --- | --- | --- |
| `sec-material-acceptance.ts` | `node --experimental-strip-types scripts/acceptance/sec-material-acceptance.ts` | Verifies real L1/L2 SEC materials and filing reports against the acceptance Worker or proxy. |
| `sec-material-acceptance-worker.ts` | `npx wrangler dev --config scripts/acceptance/wrangler.acceptance.jsonc` | Isolated local Miniflare acceptance Worker for `sec-material-acceptance.ts`. |
| `sec-material-acceptance-proxy.ts` | `npx wrangler dev --config scripts/acceptance/wrangler.acceptance-proxy.jsonc` | Localhost proxy forwarding `/acceptance/*` to the remote `AdminGateway` Service Binding. |
