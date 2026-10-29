/**
 * Renders the business site and checks fiscal period labels (the home page's cards and signals; company pages carry none since U25).
 * The dev server must already be running (fixture or a proxy to the read API).
 *   node apps/business-site/test/period-label.browser.mjs
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { periodLabel } from "../../../shared/analysis-runtime/fiscal-label.ts";

const require = createRequire(import.meta.url);
const axeSource = require.resolve("axe-core/axe.min.js");
const base = process.env.PERIOD_LABEL_URL ?? "http://127.0.0.1:4188";
const outDir = "/opt/cursor/artifacts/u12";
mkdirSync(outDir, { recursive: true });

const viewports = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
];
const themes = ["dark", "light"];
const locales = ["zh-CN", "en"];
const pages = (process.env.PERIOD_LABEL_PAGES ?? "home").split(",").filter(Boolean).map(name => (
  name === "home" ? { name, path: "/" } : { name, path: `/companies/${name}` }
));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/usr/local/bin/google-chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const failures = [];
const note = (where, message) => failures.push(`${where}: ${message}`);

for (const viewport of viewports) {
  for (const theme of themes) {
    for (const locale of locales) {
      for (const target of pages) {
        const where = `${viewport.name} ${theme} ${locale} ${target.name}`;
        const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
        await page.addInitScript(({ theme: selected, locale: lang }) => {
          try {
            localStorage.setItem("business-map-theme", selected);
            localStorage.setItem("business-map-locale", lang);
          } catch { /* Storage may be blocked in a frame. */ }
          const root = document.documentElement;
          if (root) {
            root.classList.toggle("light", selected === "light");
            root.classList.toggle("dark", selected !== "light");
          }
          window.__cls = 0;
          try {
            new PerformanceObserver(list => {
              for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__cls += entry.value;
            }).observe({ type: "layout-shift", buffered: true });
          } catch { /* The frame may not expose layout-shift. */ }
        }, { theme, locale });
        await page.goto(`${base}${target.path}?lang=${locale}`, { waitUntil: "networkidle" });
        await page.waitForSelector(".period-primary", { timeout: 20000 });
        const lang = await page.evaluate(() => document.documentElement.lang);
        if (!lang.toLowerCase().startsWith(locale.slice(0, 2).toLowerCase())) note(where, `html lang ${lang}`);
        const forbidden = await page.locator("text=财季待确认").count() + await page.locator("text=Fiscal quarter pending").count();
        if (forbidden) note(where, "pending-quarter copy is still visible");
        const labels = await page.evaluate(() => [...document.querySelectorAll(".period-mark")].map(el => ({
          ticker: el.getAttribute("data-ticker"),
          period: el.getAttribute("data-period"),
          variant: el.getAttribute("data-variant"),
          unknown: el.hasAttribute("data-unknown"),
          primary: el.querySelector(".period-primary")?.textContent?.trim() ?? "",
          secondary: el.querySelector(".period-secondary")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
          secondaryShown: !!el.querySelector(".period-secondary")?.getClientRects().length,
        })));
        if (!labels.length) note(where, "no period marks");
        for (const mark of labels) {
          if (!mark.period) { note(where, "mark missing period"); continue; }
          const expected = periodLabel({ ticker: mark.ticker, periodEnd: mark.period }, locale === "zh-CN" ? "zh-CN" : "en");
          const text = expected.primary ?? expected.unknown;
          if (mark.primary !== text) note(where, `${mark.ticker} ${mark.period} shows «${mark.primary}» expected «${text}»`);
          if (mark.variant === "footer" && viewport.name === "mobile" && mark.secondaryShown) note(where, "mobile footer still shows a secondary label");
        }
        const layout = await page.evaluate(() => {
          const problems = [];
          const root = document.documentElement;
          const inScroller = (el) => {
            for (let node = el.parentElement; node; node = node.parentElement) {
              const overflow = getComputedStyle(node).overflowX;
              if (overflow === "auto" || overflow === "scroll" || overflow === "hidden") return true;
            }
            return false;
          };
          for (const el of document.querySelectorAll(".period-mark, .period-primary, .period-secondary, .home-card")) {
            const box = el.getBoundingClientRect();
            if (box.width === 0 || box.height === 0) continue;
            if (el.scrollWidth > el.clientWidth + 2) problems.push(`${el.className || el.tagName} overflows ${el.scrollWidth}>${el.clientWidth}`);
            if (!inScroller(el) && (box.right > root.clientWidth + 1 || box.left < -1)) problems.push(`${el.className || el.tagName} escapes ${Math.round(box.left)}..${Math.round(box.right)}`);
          }
          return problems;
        });
        for (const problem of layout) note(where, problem);
        const mark = page.locator(".period-primary").first();
        const before = await mark.boundingBox();
        await mark.focus();
        await page.waitForSelector(".period-tip", { timeout: 2000 });
        const tipBox = await page.locator(".period-tip").boundingBox();
        if (!tipBox || tipBox.width < 8) note(where, "tooltip has no box");
        else if (tipBox.x < -1 || tipBox.x + tipBox.width > viewport.width + 1) note(where, `tooltip escapes ${Math.round(tipBox.x)}..${Math.round(tipBox.x + tipBox.width)}`);
        const tipText = await page.locator(".period-tip").innerText();
        if (target.name === "NVDA" && locale === "zh-CN" && !tipText.includes("2027 财年第二季度")) note(where, `NVDA tooltip «${tipText}»`);
        if (target.name === "NVDA" && locale === "en" && !tipText.includes("Q2 of fiscal 2027")) note(where, `NVDA tooltip «${tipText}»`);
        await page.addScriptTag({ path: axeSource });
        const contrast = await page.evaluate(async () => {
          const result = await window.axe.run(
            { include: [[".period-mark"], [".period-tip"], [".trend-now"], [".findings-aside"]] },
            { runOnly: { type: "rule", values: ["color-contrast"] } },
          );
          return result.violations.flatMap(v => v.nodes.map(n => `${n.target.join(" ")} ${n.failureSummary?.split("\n")[0] ?? ""}`));
        });
        for (const item of contrast) note(where, `contrast ${item}`);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(150);
        if (await page.locator(".period-tip").count()) note(where, "Escape did not close the tooltip");
        const after = await mark.boundingBox();
        if (before && after && (Math.abs(before.x - after.x) > 0.5 || Math.abs(before.y - after.y) > 0.5)) note(where, "label moved when the tooltip opened");
        const settled = await mark.boundingBox();
        await page.waitForTimeout(400);
        const later = await mark.boundingBox();
        if (settled && later && (Math.abs(settled.x - later.x) > 0.5 || Math.abs(settled.y - later.y) > 0.5)) note(where, "label moved after it settled");
        for (const error of errors) {
          if (/favicon|Failed to load resource|net::ERR/i.test(error)) continue;
          note(where, `console ${error.slice(0, 240)}`);
        }
        const file = where.replaceAll(" ", "-");
        await page.screenshot({ path: `${outDir}/${file}.png` });
        if (target.name === "home") {
          await page.locator("#home-companies").scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${outDir}/${file}-cards.png` });
        }
        if (target.name !== "home") {
          const chart = page.locator(".trend").first();
          if (await chart.count()) {
            await chart.scrollIntoViewIfNeeded();
            await page.screenshot({ path: `${outDir}/${file}-chart.png` });
          }
        }
        await page.close();
        process.stdout.write(failures.some(f => f.startsWith(`${where}:`)) ? `FAIL ${where}\n` : `ok   ${where}\n`);
      }
    }
  }
}

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} problems\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("period label render checks passed");
