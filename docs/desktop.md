# Spontra desktop

Tauri 2 application for macOS (Apple Silicon / Intel) and Windows x64. The desktop bundles local React assets and reads the existing Cloudflare service. Linux, offline data synchronization, local agents, public accounts and automatic updates are outside this release.

## Run and build

Install Node.js 22.13+ and Rust stable. On macOS install Xcode command-line tools; on Windows install the Microsoft C++ build tools and WebView2. From the repository root:

```sh
npm ci
npm run desktop:dev
npm run desktop:check
npm run desktop:build
npm run desktop:boundary
npm run desktop:test
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run desktop:package -- --bundles app,dmg
```

On Windows use `npm run desktop:package -- --bundles nsis`. The root Web build remains `npm run build`; neither desktop build nor packaging deploys a Worker. `desktop:dev` runs Vite and the native app; `npm run dev:web --workspace @spontra/desktop` only starts the frontend, which requires native IPC (the Playwright tests mock it explicitly).

Installers are under `apps/desktop/src-tauri/target/release/bundle`. GitHub Actions builds both Mac architectures and Windows x64 on pushes to main. Download the matching artifact from the **Desktop installers** workflow. Artifact access follows the repository's GitHub permissions; the repository is public, so artifacts must never include credentials or private data. Manual upgrades replace the application while preserving the application identifier and local preferences.

## Desktop connection

The release app has one fixed API origin: `https://spontra.max-zhangyuchen.workers.dev`. It only permits an explicit set of relative API routes and GET/PUT methods. Redirects are refused. Timeout is 25 seconds, request bodies are limited to 64 KiB and responses to 16 MiB. Aborted frontend reads are canceled through native IPC.

Configure an independently generated 32–512 character ASCII `DESKTOP_ACCESS_TOKEN` as an **encrypted build variable on the main application's Cloudflare build trigger**. It is not a Pipeline or IBKR credential. The Git-only CI deployment entry point writes a temporary mode-0600 secret file and passes it to the existing Wrangler deployment, then removes it. Existing migration and sec-cron deployment steps are preserved. No local deployment commands are part of this workflow. Missing credentials keep the desktop API disabled (503); invalid credentials return 401.

The first-run connection screen validates the credential against `/api/desktop/v1/connection` before saving it in macOS Keychain or Windows Credential Manager. The frontend never reads stored credentials. Changing the encrypted build variable and pushing a verified main commit rotates access; existing desktop sessions then ask for a new credential. Settings can remove the stored credential. This secures the new desktop API only: it does not add authentication to previously public Web routes or isolate multiple users.

Debug builds use a separate keychain service. For local native testing only, `SPONTRA_DESKTOP_DEV_ORIGIN=http://127.0.0.1:PORT` can be supplied while building/running a debug app. Only loopback HTTP is accepted; release binaries ignore this option. Local backend configuration must supply a disposable test token. The packaged release never contains a token.

## Shared boundaries

- `packages/ui` owns the extracted Today surfaces, navigation context and shared style entry; the other existing screens are reused through its exports.
- `packages/client` owns the request/platform adapter, serializable contracts, shared portfolio/report projections and refresh events.
- `/api/desktop/v1` exposes portfolio, stock context, plans, quotes, calendar, search, research and analysis reads through existing server functions. Snapshot responses include `source` and `asOf`; data unavailability is not silently rendered as an empty account.
- Web retains server rendering and its existing same-origin write check. Desktop plan writes require the desktop bearer credential and use the same validation/store. No client imports D1, Cloudflare runtime, personal portfolio JSON or server credentials; Vite fails on such imports and the output scanner checks packaged resources.
- Business data stays in memory; only theme/language, read IDs and window geometry persist. The research feed refreshes while the document is visible. Refreshing does not remount editors. External HTTP(S) links open in the system browser; shared report URLs retain their published date/version on the public HTTPS origin.

## Verification and signing

The browser tests use synthetic data and mocked IPC, and cover connection errors, navigation, drafts/save behavior, report version links, clipboard/external links, reconnect and 1024/1280/1600 pixel layouts. They do not prove native IPC or Windows installer behavior. Run native installation, Chinese input, clipboard, window restoration and upgrade checks on each platform separately.

The workflow supports optional macOS `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, and notarization credentials `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`. Windows uses `WINDOWS_CERTIFICATE` (base64 PFX) and `WINDOWS_CERTIFICATE_PASSWORD`. Without signing credentials, artifacts are labelled `unsigned-test`; local macOS ad-hoc signing is not Developer ID signing or notarization. Do not present these packages as publicly trusted releases.

Existing baseline checks currently include a stale cron assertion in `sec-integration.test.ts` and three stale source/style assertions in `rendered-html.test.mjs` (product description, overview grid and option indentation). These are separate from the desktop tests and must be reported when running the complete suites.
