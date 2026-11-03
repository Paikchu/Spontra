/** Offline regression review using saved company API responses, never a production API.
 * Start npm run dev, then:
 * GUIDANCE_FIXTURES=/path/to/snapshots GUIDANCE_URL=http://127.0.0.1:4188 node apps/business-site/test/guidance-layout.browser.mjs
 * Snapshot names: c_AMZN.json, c_MSFT.json, c_NVDA.json (complete-business-flow.v1).
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const directory = process.env.GUIDANCE_FIXTURES;
assert.ok(directory, 'Set GUIDANCE_FIXTURES to the directory of offline company snapshots');
const snapshots = Object.fromEntries(['AMZN', 'MSFT', 'NVDA'].map(t => [t, JSON.parse(readFileSync(`${directory}/c_${t}.json`, 'utf8'))]));
// Some saved companies have no guidance publication. Exercise the same marks with
// representative next-quarter ranges derived from their own reported amounts.
for (const [ticker, snapshot] of Object.entries(snapshots)) {
  if (snapshot.guidance) continue;
  const quarter = snapshot.flow.quarters[0];
  const next = new Date(`${quarter.periodEnd}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 3);
  snapshot.guidance = { ...snapshots.AMZN.guidance, ticker, items: ['revenue', 'operating_income'].map(metric => {
    const template = snapshots.AMZN.guidance.items.find(i => i.metric === metric && i.horizon === 'quarter');
    assert.ok(template, `AMZN snapshot needs ${metric} guidance as a schema template`);
    const value = Number(quarter.figures[metric === 'revenue' ? 'revenue' : 'operating'].value);
    return { ...template, id: `review-${metric}`, periodEnd: next.toISOString().slice(0, 10),
      issuedAt: quarter.reportedAt, low: value * 1.1, high: value * 1.2, actual: null };
  }) };
}
const base = process.env.GUIDANCE_URL ?? 'http://127.0.0.1:4188';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'Review server must be local');
const output = process.env.GUIDANCE_OUTPUT ?? '/tmp/task1101-guidance';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  for (const width of [1280, 1440]) for (const locale of ['en', 'zh-CN']) for (const ticker of Object.keys(snapshots)) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== new URL(base).origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const body = url.pathname.endsWith('/opening') ? { revisions: {}, resources: {
        company: { status: 200, body: snapshots[ticker] },
        ...Object.fromEntries(['capital', 'findings', 'fundamentals', 'events', 'filings', 'valuation'].map(name => [name, { status: 200, body: { status: 'unavailable' } }])),
      } } : url.pathname.endsWith('/revision') ? { revisions: {} } : { status: 'unavailable', companies: [] };
      return route.fulfill({ json: body });
    });
    await page.goto(`${base}/companies/${ticker}?lang=${locale}`);
    await page.locator('.fc-guide-next').first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(800);
    const result = await page.evaluate(() => {
      const rect = e => e.getBoundingClientRect();
      const overlaps = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
      const labels = [...document.querySelectorAll('.fc-label')].map(rect);
      const cards = [...document.querySelectorAll('.fc-guide-next')];
      const boxes = cards.map(rect);
      const total = rect(document.querySelector('.biz-total'));
      const guide = rect(document.querySelector('.biz-guide'));
      const delta = document.querySelector('.biz-total-delta');
      return { railBelow: guide.top >= total.bottom - 1,
        growthClear: !delta || !overlaps(rect(delta), guide),
        collisions: boxes.flatMap((b, i) => [...labels.filter(l => overlaps(b, l)).map(() => `label:${i}`), ...boxes.slice(i + 1).filter(c => overlaps(b, c)).map(() => `card:${i}`)]),
        markers: cards.filter(c => c.hasAttribute('data-marker')).length,
        guidance: cards.length };
    });
    assert.deepEqual(errors, [], `${ticker} ${width} ${locale} render errors`);
    assert.equal(result.railBelow, true, `${ticker} ${width} ${locale} guidance must be on second line`);
    assert.equal(result.growthClear, true);
    assert.deepEqual(result.collisions, [], `${ticker} ${width} ${locale} overlapping labels/cards`);
    const marker = page.locator('.fc-guide-next[data-marker] a').first();
    if (await marker.count()) {
      assert.ok(await marker.getAttribute('aria-label'));
      await marker.focus();
      await page.locator('.fc-tip').waitFor();
      await page.keyboard.press('Escape');
      await page.locator('.fc-tip').waitFor({ state: 'hidden' });
      await marker.blur();
    }
    await page.screenshot({ path: `${output}/${ticker}-${width}-${locale}.png` });
    console.log(`${ticker} ${width} ${locale}: ${result.guidance} guidance marks, ${result.markers} compact; no overlap`);
    await page.close();
  }
} finally { await browser.close(); }
