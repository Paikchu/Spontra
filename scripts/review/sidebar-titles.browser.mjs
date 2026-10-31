// Start Vite with BUSINESS_SITE_API pointing to the live API proxy, then run this file.
// Older production APIs require an /opening adapter (see the review output proxy).
// BASE_URL, OUTPUT_DIR and CHROME_PATH can override the local review defaults.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const output = process.env.OUTPUT_DIR ?? '/workspace/r1031/unified-fix2';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const results = [];
try {
  for (const width of [390, 1024, 1280, 1440]) for (const lang of ['en', 'zh']) for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('bv-tour-done', '1');
      sessionStorage.setItem('bv-tour-auto', '1');
    });
    await page.goto(`${process.env.BASE_URL ?? 'http://127.0.0.1:4188'}/companies/NVDA?lang=${lang === 'zh' ? 'zh-CN' : lang}&view=profit`);
    await page.locator('.insider-title').first().waitFor({ state: 'attached', timeout: 90000 });
    const expand = page.locator('.rail-toggle[aria-expanded="false"]');
    if (await expand.count()) await expand.click();
    await page.locator('.insider-title').first().waitFor();
    await page.evaluate(theme => document.documentElement.classList.toggle('light', theme === 'light'), theme);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1000);
    const metrics = await page.evaluate(() => {
      const rect = e => e.getBoundingClientRect();
      const visible = e => e.checkVisibility({ visibilityProperty: true }) && rect(e).width > 0 && rect(e).height > 0;
      const titles = [...document.querySelectorAll('.rail .stream-title, .rail .insider-title span')].filter(visible).map(e => ({
        text: e.textContent, className: e.className, clientWidth: e.clientWidth, scrollWidth: e.scrollWidth,
        textOverflow: getComputedStyle(e).textOverflow,
      }));
      const details = [...document.querySelectorAll('.rail .row-name, .rail .insider-title + .stream-meta')].filter(visible).map(e => ({
        text: e.textContent, className: e.className, clientWidth: e.clientWidth, scrollWidth: e.scrollWidth,
        clientHeight: e.clientHeight, scrollHeight: e.scrollHeight,
        textOverflow: getComputedStyle(e).textOverflow, lineClamp: getComputedStyle(e).webkitLineClamp,
      }));
      const insiders = [...document.querySelectorAll('.insider-title')].filter(visible).map(e => {
        const name = e.querySelector('.insider-name'), content = e.querySelector('.insider-content');
        const transaction = e.querySelector('.insider-transaction'), tags = e.querySelector('.insider-tags'), amount = e.querySelector('.insider-amount');
        const style = amount && getComputedStyle(amount);
        return {
          text: e.textContent, full: e.title,
          fullTextRetained: [name, content, tags, amount].filter(Boolean).every(part => e.title.includes(part.textContent)),
          nameFirst: rect(name).bottom <= rect(transaction).top + 1,
          tagsSeparate: !tags || rect(tags).top >= rect(transaction).bottom - 1,
          amountAligned: !amount || Math.abs(rect(amount).right - rect(e).right) < 1,
          amountStyle: !style || style.textAlign === 'right' && style.fontVariantNumeric.includes('tabular-nums') && style.fontFamily.includes('mono'),
          unclamped: getComputedStyle(e).webkitLineClamp === 'none',
        };
      });
      const rail = document.querySelector('.rail'), scroll = document.querySelector('.rail-scroll');
      return { titles, details, insiders, pageWidth: document.documentElement.scrollWidth, viewport: innerWidth,
        railWidth: rail.clientWidth, railScrollWidth: rail.scrollWidth,
        scrollWidth: scroll.clientWidth, scrollScrollWidth: scroll.scrollWidth };
    });
    results.push({ width, lang, theme, errors, ...metrics });
    if (width === 1440) await page.screenshot({ path: `${output}/nvda-${theme}-${lang}-1440.png`, fullPage: true });
    assert.equal(errors.length, 0, JSON.stringify(errors));
    assert.ok(metrics.details.some(t => t.className === 'row-name') && metrics.details.some(t => t.className === 'stream-meta'), 'Real segment names and trade metadata must be loaded');
    assert.ok(metrics.details.every(t => t.scrollWidth <= t.clientWidth && t.scrollHeight <= t.clientHeight && t.textOverflow !== 'ellipsis' && t.lineClamp === 'none'), JSON.stringify(metrics.details));
    assert.ok(metrics.titles.length && metrics.insiders.length, 'Real transaction titles must be loaded');
    assert.ok(metrics.titles.every(t => t.scrollWidth <= t.clientWidth && t.textOverflow !== 'ellipsis'), JSON.stringify(metrics.titles.filter(t => t.scrollWidth > t.clientWidth || t.textOverflow === 'ellipsis')));
    assert.ok(metrics.insiders.every(t => t.fullTextRetained && t.nameFirst && t.tagsSeparate && t.amountAligned && t.amountStyle && t.unclamped), JSON.stringify(metrics.insiders));
    assert.ok(metrics.pageWidth <= width && metrics.railScrollWidth <= metrics.railWidth && metrics.scrollScrollWidth <= metrics.scrollWidth, 'Horizontal overflow');
    console.log(`PASS NVDA ${width} ${lang} ${theme}: ${metrics.titles.length} title elements`);
    await page.close();
  }
} finally {
  await browser.close();
  await writeFile(`${output}/sidebar-title-measurements.json`, JSON.stringify(results, null, 2));
}
