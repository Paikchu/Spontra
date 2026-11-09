# Spontra Desktop

A Tauri 2 app around `apps/business-site`, built in its `desktop` Vite mode. It runs no collection or model work; every figure comes from the published site through a local proxy. The design and its measurements are in [docs/desktop-frontend-solution.md](../../docs/desktop-frontend-solution.md).

## Layout

| Path | What it holds |
| --- | --- |
| `src-tauri/src/proxy.rs` | The `spontra-api` scheme: routes, the reader's cookie, what is kept on disk |
| `src-tauri/src/cache.rs` | Responses on disk, their freshness and the size limit |
| `src-tauri/src/links.rs` | `spontra://` addresses |
| `src-tauri/src/launch.rs` | Launch timings, written to a local file only |
| `src-tauri/src/lib.rs` | Window, menu, plugins, updates |
| `../business-site/src/desktop/` | The boot script: transport, last page, theme, links, shortcuts |
| `../business-site/desktop-shell.vite.ts` | Turns the site's `_headers` into the app's meta policies |

## Commands

```bash
npm run desktop:dev     # the app against the Vite dev server
npm run desktop:build   # needs TAURI_SIGNING_PRIVATE_KEY for the update artifacts
```

Check a build inside its real webview, and measure one:

```bash
cd apps/desktop && npx tauri build --debug --bundles app --features selftest --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

```bash
node --experimental-strip-types --no-warnings scripts/desktop-selftest.ts --app apps/desktop/src-tauri/target/debug/bundle/macos/Spontra.app
```

```bash
npm run desktop:perf -- --app apps/desktop/src-tauri/target/release/bundle/macos/Spontra.app --runs 7
```

`SPONTRA_SITE_ORIGIN` at build time points the app at another site. The `selftest` feature never ships.

## Release

Push a tag `desktop-v<version>` matching `version` in `src-tauri/tauri.conf.json`; `.github/workflows/desktop-release.yml` builds, signs and publishes. Never upload a local build. The repository needs these secrets:

| Secret | Use |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Signs the update artifacts; the public half is in `tauri.conf.json` |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` | Developer ID signing |
| `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_CONTENT` | Notarization |

The Apple secrets are optional. Without `APPLE_CERTIFICATE` the macOS app is signed ad hoc and not notarized, so Gatekeeper blocks its first launch until the user allows it in System Settings → Privacy & Security.

A new version downloads in the background ten seconds after launch and is installed when the app quits.
