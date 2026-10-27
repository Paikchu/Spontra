// Run with BUSINESS_SITE_FIXTURES=1 Vite on :4188, then node this file.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { sessionStorage.setItem('bv-tour-auto', '1'); localStorage.removeItem('bv-tour-done'); });
  for (const width of [1440, 1024, 960, 390, 320]) {
    for (const lang of ['en', 'zh-CN']) {
      for (const light of [false, true]) {
      await page.setViewportSize({ width, height: 600 });
      await page.goto(`http://127.0.0.1:4188/companies/ACME?lang=${lang}`);
      await page.locator('.tour-layer[open]').waitFor();
      await page.evaluate(light => document.documentElement.classList.toggle('light', light), light);
      assert.match(await page.locator('#company-tour-text').innerText(), lang === 'en' ? /What this quarter earned/ : /这一季赚了多少/);
      for (let step = 0; step < 3; step++) {
        await page.waitForTimeout(220);
        assert.ok(await page.evaluate(() => {
          const c = document.querySelector('.tour-card').getBoundingClientRect();
          const h = document.querySelector('.tour-hole')?.getBoundingClientRect();
          return c.top >= 0 && c.bottom <= innerHeight && c.left >= 0 && c.right <= innerWidth
            && (!h || h.top >= 0 && h.bottom <= innerHeight && (h.bottom <= c.top || h.top >= c.bottom));
        }), `${width}/${lang}/step ${step}`);
        for (let n = 0; n < 6; n++) {
          await page.keyboard.press('Tab');
          assert.ok(await page.evaluate(() => !!document.activeElement.closest('.tour-layer')));
        }
        await page.locator('.tour-next').click();
      }
      await page.locator('.tour-layer').waitFor({ state: 'detached' });
    }
  }
  }
  // A real button gets native Space activation; / must not open search underneath.
  await page.goto('http://127.0.0.1:4188/companies/ACME?lang=en');
  await page.locator('.tour-layer[open]').waitFor();
  await page.keyboard.press('/');
  assert.equal(await page.locator('.search-dialog[open]').count(), 0);
  await page.locator('.tour-skip').focus();
  await page.keyboard.press('Space');
  await page.locator('.tour-layer').waitFor({ state: 'detached' });
  // A native modal opened during the delay owns focus and Escape.
  await page.goto('http://127.0.0.1:4188/companies/ACME?lang=en');
  await page.locator('[data-tour="stats"]').waitFor();
  await page.evaluate(() => document.querySelector('.privacy-dialog').showModal());
  await page.waitForTimeout(850);
  assert.equal(await page.locator('.tour-layer[open]').count(), 0);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.privacy-dialog[open]').count(), 0);
  // Each lens can load before the auto-open timer; no targetless tour may appear.
  for (const query of ['finding=capex', 'event=e-8k', 'report=0001-26-000002', 'check=cash-conversion']) {
    await page.goto(`http://127.0.0.1:4188/companies/ACME?lang=en&${query}`);
    await page.locator('.lens-stage').first().waitFor();
    await page.waitForTimeout(850);
    assert.equal(await page.locator('.tour-layer[open]').count(), 0, query);
  }
  await page.goto('http://127.0.0.1:4188/companies/ACME?lang=en');
  await page.locator('.tour-layer[open]').waitFor();
  // Simulate a programmatic lens transition while the modal owns pointer input.
  await page.locator('.finding-row').first().evaluate(button => button.click());
  await page.locator('.tour-layer').waitFor({ state: 'detached' });
  assert.equal(await page.locator('[data-tour="stats"]').count(), 0);
  await page.goto('http://127.0.0.1:4188/companies/ACME?lang=en');
  await page.locator('.tour-layer[open]').waitFor();
  await page.locator('.tour-skip').click();
  // Target removal while open closes the tour and disconnects observers/listeners.
  await page.locator('.rail-tour').evaluate(button => button.click());
  await page.locator('.tour-layer[open]').waitFor();
  await page.evaluate(() => document.querySelector('[data-tour="stats"]').remove());
  await page.locator('.tour-layer').waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  console.log('Tour browser regressions passed: 5 widths × 2 languages × 2 themes, positioning, Tab, Space, modal ownership, target removal.');
} finally { await browser.close(); }
