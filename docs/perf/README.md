# Business site load performance

Two measurements, one main metric: **content**, the time until the main content is first on screen (the company flow chart, or the first row of the home table). First contentful paint alone flatters the site, because the first paint is a skeleton.

## Field

The site reports one `web_vitals` event per page load when the page is first hidden: `ttfb`, `fcp`, `lcp`, `cls` (thousandths), `inp`, `content` (ms). The event keeps the path the page was loaded on; moves inside the app are not page loads. A load that started in a background tab sends nothing. The admin usage board shows the p75 of each metric per landing route (home, company) for the selected range.

Code: `apps/business-site/src/vitals.ts` (collection and the `bv:content` mark), `apps/business-site/src/telemetry.ts` (`summarizeVitals`).

## Lab

```bash
npm run perf:lab -- --runs 7 --profile slow,fast --out docs/perf/<name>.json
```

Each load gets a fresh headless Chrome with an empty cache. `slow` is 150 ms round trip, 1.6 Mbps down, 750 Kbps up and 4x CPU slowdown; `fast` is unthrottled. Pages alternate within each round. `--base` points at another deployment, `--pages` takes a comma-separated list, `--lang` sets the browser locale (default `en-US`). Telemetry requests are blocked so lab loads stay out of the field numbers.

Report a change only when its medians move clearly beyond the run-to-run spread in `samples`; compare runs taken from the same machine and network.

## Baseline

`baseline-2026-11-06.json`: production before any P1–P6 change.
