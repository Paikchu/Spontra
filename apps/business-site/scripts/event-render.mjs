/**
 * Renders the company rail for U13: META, TSM, AMZN, NBIS × desktop/mobile × dark/light × zh/en.
 * Checks console errors, horizontal overflow, fold and bubble clipping, axe color-contrast, and CLS after settle.
 * One pass also drives the filter and a fold from the keyboard.
 *
 *   BUSINESS_SITE_ORIGIN=http://127.0.0.1:4190 node apps/business-site/scripts/event-render.mjs
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const axeSource = require("fs").readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const origin = process.env.BUSINESS_SITE_ORIGIN ?? "http://127.0.0.1:4190";
const outDir = "/opt/cursor/artifacts/u13";
mkdirSync(outDir, { recursive: true });

const tickers = ["META", "TSM", "AMZN", "NBIS"];
const viewports = [{ name: "1280", width: 1280, height: 900 }, { name: "390", width: 390, height: 844 }];
const themes = ["dark", "light"];
const locales = [{ name: "zh", lang: "zh-CN" }, { name: "en", lang: "en" }];

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
});

const failures = [];
const notes = [];

function fail(where, message) {
  failures.push(`${where}: ${message}`);
  console.error(`FAIL ${where}: ${message}`);
}

async function settle(page) {
  await page.waitForSelector('[data-section="events"] [role="radiogroup"] [role="radio"]', { timeout: 90_000 });
  await page.waitForTimeout(600);
}

async function readPage(page, where) {
  await settle(page);
  await page.evaluate(() => { window.__cls = 0; });
  await page.waitForTimeout(800);
  const facts = await page.evaluate(() => {
    const cls = window.__cls ?? 0;
    const section = document.querySelector('[data-section="events"]');
    const rail = section?.getBoundingClientRect();
    const doc = document.documentElement;
    const problems = [];
    const visible = (el) => {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    // A capsule past the rail is fine when the capsule row itself scrolls and stays inside the viewport.
    const scrolls = (el) => {
      let node = el.parentElement;
      while (node && node !== document.body) {
        const style = getComputedStyle(node);
        if (/(auto|scroll|hidden)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1) return node.getBoundingClientRect();
        node = node.parentElement;
      }
      return null;
    };
    if (section && rail) {
      if (rail.right > doc.clientWidth + 1 || rail.left < -1) problems.push(`events section outside viewport ${Math.round(rail.right)}/${doc.clientWidth}`);
      const filters = document.querySelector(".event-filters");
      const filterBox = filters?.getBoundingClientRect();
      if (filterBox && (filterBox.right > doc.clientWidth + 1 || filterBox.left < -1)) problems.push("capsule row outside viewport");
      for (const el of section.querySelectorAll(".event-fold-text, .event-filter, .timeline-bubble")) {
        if (!visible(el)) continue;
        if (el.classList.contains("event-fold-text") && el.scrollWidth > el.clientWidth + 2) problems.push(`clipped fold “${el.textContent?.slice(0, 40)}”`);
        const box = el.getBoundingClientRect();
        const clip = scrolls(el);
        if (clip) {
          if (clip.right > doc.clientWidth + 1 || clip.left < -1) problems.push(`scroller outside viewport “${el.textContent?.trim().slice(0, 24)}”`);
          continue;
        }
        if (box.right > Math.min(rail.right, doc.clientWidth) + 2 || box.left < rail.left - 2) problems.push(`outside rail “${el.textContent?.trim().slice(0, 24)}”`);
      }
      const bubbles = [...document.querySelectorAll(".timeline-bubble")].filter(visible);
      for (let i = 0; i < bubbles.length; i++) {
        const a = bubbles[i].getBoundingClientRect();
        for (let j = i + 1; j < bubbles.length; j++) {
          const b = bubbles[j].getBoundingClientRect();
          const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          if (overlap > 2) problems.push(`bubbles overlap ${Math.round(overlap)}px`);
        }
      }
    }
    const filters = [...document.querySelectorAll(".event-filter:not(.event-filter--ghost)")];
    const selected = filters.find(el => el.getAttribute("aria-checked") === "true");
    const sample = selected ? getComputedStyle(selected) : null;
    return {
      cls,
      problems,
      filters: filters.map(el => ({ label: el.childNodes[0]?.textContent?.trim(), count: el.querySelector("small")?.textContent, checked: el.getAttribute("aria-checked") })),
      capsule: sample && { height: sample.height, radius: sample.borderRadius, weight: sample.fontWeight, size: sample.fontSize, padding: sample.padding },
      bubbles: document.querySelectorAll(".timeline-bubble").length,
      points: document.querySelectorAll(".timeline-point, .timeline-bubble").length,
    };
  });
  if (facts.cls > 0) fail(where, `CLS ${facts.cls}`);
  for (const problem of facts.problems) fail(where, problem);
  if (facts.capsule) {
    if (facts.capsule.height !== "28px") fail(where, `capsule height ${facts.capsule.height}`);
    if (facts.capsule.size !== "12px") fail(where, `capsule font ${facts.capsule.size}`);
  }
  const axe = await page.evaluate(async () => {
    if (!window.axe || !document.querySelector('[data-section="events"]')) return { violations: [{ id: "setup", nodes: [] }] };
    const include = [".event-filters", "[data-section='events'] .findings-rows"];
    if (document.querySelector(".timeline")) include.push(".timeline");
    const result = await window.axe.run({ include }, { runOnly: { type: "rule", values: ["color-contrast"] } });
    return { violations: result.violations.map(v => ({ id: v.id, nodes: v.nodes.slice(0, 3).map(n => n.target.join(" ")) })) };
  });
  if (axe.violations.length) fail(where, `contrast ${JSON.stringify(axe.violations)}`);
  return facts;
}

async function shoot(page, name) {
  const section = page.locator('[data-section="events"]');
  await section.scrollIntoViewIfNeeded();
  await section.screenshot({ path: `${outDir}/${name}.png` });
  const timeline = page.locator(".timeline");
  if (await timeline.count()) {
    await timeline.scrollIntoViewIfNeeded();
    await timeline.screenshot({ path: `${outDir}/${name}-timeline.png` });
  }
}

const jobs = [];
for (const ticker of tickers) for (const viewport of viewports) for (const theme of themes) for (const locale of locales) {
  jobs.push({ ticker, viewport, theme, locale });
}

async function runJob(job) {
  const where = `${job.ticker} ${job.viewport.name} ${job.theme} ${job.locale.name}`;
  const context = await browser.newContext({
    viewport: { width: job.viewport.width, height: job.viewport.height },
    colorScheme: job.theme,
    reducedMotion: "no-preference",
  });
  await context.addInitScript(axeSource);
  await context.addInitScript((theme) => {
    localStorage.setItem("business-map-theme", theme);
    const shifts = { value: 0 };
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (!entry.hadRecentInput) shifts.value += entry.value;
    }).observe({ type: "layout-shift", buffered: true });
    Object.defineProperty(window, "__cls", { get: () => shifts.value, set: (v) => { shifts.value = v; } });
  }, job.theme);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  page.on("console", msg => { if (msg.type() === "error" && !msg.text().startsWith("Failed to load resource")) errors.push(msg.text()); });
  page.on("response", response => { if (response.status() >= 400 && !response.url().includes("/agents/status")) errors.push(`${response.status()} ${response.url()}`); });
  try {
    await page.goto(`${origin}/companies/${job.ticker}?lang=${job.locale.lang}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    const facts = await readPage(page, where);
    notes.push({ where, filters: facts.filters, points: facts.points, bubbles: facts.bubbles });
    if (job.viewport.name === "1280" && job.theme === "dark") await shoot(page, `${job.ticker.toLowerCase()}-${job.locale.name}-desktop-dark`);
    if (job.viewport.name === "390" && job.theme === "light") await shoot(page, `${job.ticker.toLowerCase()}-${job.locale.name}-mobile-light`);
    console.log(`ok ${where} points=${facts.points} bubbles=${facts.bubbles} key=${facts.filters.find(f => f.checked === "true")?.count}`);
  } catch (error) {
    fail(where, error instanceof Error ? error.message : String(error));
  }
  for (const error of errors) fail(where, `console ${error.slice(0, 300)}`);
  await context.close();
}

const queue = [...jobs];
const workers = Array.from({ length: 2 }, async () => {
  while (queue.length) await runJob(queue.shift());
});
await Promise.all(workers);

async function keyboard() {
  const where = "keyboard META+TSM";
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  await context.addInitScript(() => localStorage.setItem("business-map-theme", "dark"));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  page.on("console", msg => { if (msg.type() === "error" && !msg.text().startsWith("Failed to load resource")) errors.push(msg.text()); });
  page.on("response", response => { if (response.status() >= 400 && !response.url().includes("/agents/status")) errors.push(`${response.status()} ${response.url()}`); });
  try {
    await page.goto(`${origin}/companies/META?lang=zh-CN`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await settle(page);
    const motion = await page.evaluate(() => getComputedStyle(document.querySelector(".event-filter")).transitionDuration);
    if (motion !== "0s") fail(where, `reduced motion still transitions (${motion})`);
    await page.locator('[data-section="events"] [role="radio"][aria-checked="true"]').focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(200);
    const earnings = await page.locator('[data-section="events"] [role="radio"][aria-checked="true"]').innerText();
    if (!earnings.includes("财报与指引")) fail(where, `ArrowRight landed on ${earnings}`);
    await page.keyboard.press("End");
    await page.waitForTimeout(200);
    const all = await page.locator('[data-section="events"] [role="radio"][aria-checked="true"]').innerText();
    if (!all.startsWith("全部")) fail(where, `End landed on ${all}`);
    if (!page.url().includes("events=all")) fail(where, `url ${page.url()}`);
    await page.keyboard.press("Home");
    await page.waitForTimeout(200);
    const key = await page.locator('[data-section="events"] [role="radio"][aria-checked="true"]').innerText();
    if (!key.startsWith("重要")) fail(where, `Home landed on ${key}`);

    await page.goto(`${origin}/companies/TSM?lang=zh-CN&events=all`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await settle(page);
    const expand = page.locator('[data-section="events"] .section-expand');
    if (await expand.count()) await expand.click();
    const fold = page.locator('[data-section="events"] .event-fold-row').first();
    await fold.waitFor({ timeout: 15_000 });
    await fold.focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
    if (await fold.getAttribute("aria-expanded") !== "true") fail(where, "Enter did not expand the fold");
    const openText = await fold.innerText();
    if (!/6-K 例行文件 × \d+|本月按计划卖出/.test(openText)) fail(where, `fold copy ${openText}`);
    const leaves = await fold.locator("xpath=ancestor::div[contains(@class,'event-fold')]").locator(".event-fold-inner .event-row").count();
    const count = Number(openText.match(/×\s*(\d+)|卖出\s*(\d+)\s*笔/)?.[1] ?? openText.match(/卖出\s*(\d+)\s*笔/)?.[1]);
    if (!Number.isFinite(count) || leaves !== count) fail(where, `fold leaves ${leaves} vs label ${openText}`);
    await page.keyboard.press("Space");
    await page.waitForTimeout(200);
    if (await fold.getAttribute("aria-expanded") !== "false") fail(where, "Space did not collapse the fold");
    await shoot(page, "tsm-fold-keyboard");
    await fold.focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    await shoot(page, "tsm-fold-open");
    const bare = await page.locator('[data-section="events"] .finding-title').evaluateAll(nodes => nodes.map(n => n.textContent?.trim()).filter(text => text === "其他" || text === "其他 · 6-K"));
    if (bare.length) fail(where, `bare rows ${bare.join(",")}`);
    console.log(`ok ${where} fold=${openText}`);
  } catch (error) {
    fail(where, error instanceof Error ? error.message : String(error));
  }
  for (const error of errors) fail(where, `console ${error.slice(0, 300)}`);
  await context.close();
}

await keyboard();
await browser.close();

if (failures.length) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`\nrender checks passed (${notes.length} pages)`);
