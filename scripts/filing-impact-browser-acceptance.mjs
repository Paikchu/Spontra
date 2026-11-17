/** User-operation journey against Vite and the actual local read handlers from filing-impact-publication-acceptance --serve.
 * No model or production request. Run with node --experimental-strip-types --no-warnings. */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { company, capital, findings, events, filings, valuation } from "./i18n/fixture.ts";
const fixture = JSON.parse(await readFile("/tmp/spontra-filing-impact-fixture.json", "utf8"));
const base = process.env.ACCEPTANCE_BASE ?? "http://127.0.0.1:4208";
const directory = "/tmp/spontra-filing-impact-browser"; await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
const results = [];
const opening = JSON.parse(JSON.stringify({ revisions: {}, resources: {
  company: { status: 200, body: company }, capital: { status: 200, body: { status: "ready", capital } }, findings: { status: 200, body: { status: "ready", findings, passages: [] } }, events: { status: 200, body: { status: "ready", events } }, filings: { status: 200, body: { status: "ready", filings } }, fundamentals: { status: 200, body: { status: "unavailable" } }, valuation: { status: 200, body: { ...valuation, researchStatus: "valid" } }, insiders: { status: 200, body: { status: "unavailable" } },
} }).replaceAll("ACME", "SYNTH"));
const digest = opening.resources.filings.body.filings.filings[0];
Object.assign(digest, { accessionNumber: fixture.selection.accession, reportDate: "2026-09-30", periodEnd: "2026-09-30", periodLabel: "FY2026 Q3", filingDate: "2026-11-12", date: "2026-11-12", headline: fixture.artifact.title });
opening.resources.filings.body.filings.filings = [digest, { ...digest, accessionNumber: fixture.otherFiling.accession, headline: fixture.otherFiling.title, filingDate: "2026-11-13", date: "2026-11-13" }];
const params = extra => new URLSearchParams({ report: fixture.selection.accession, artifactVersion: fixture.selection.version, artifactHash: fixture.selection.hash, ...extra });
async function setup(page) {
  const requests = [];
  await page.route("**/api/business/v1/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== "GET") return route.fulfill({ status: 204, body: "" });
    if (url.pathname.includes("/artifact-preview/") || /\/filings\/\d/.test(url.pathname)) {
      requests.push(url.pathname + url.search);
      const response = await route.fetch({ url: `http://127.0.0.1:8796${url.pathname}${url.search}` });
      return route.fulfill({ response });
    }
    if (url.pathname.endsWith("/opening")) return route.fulfill({ json: opening });
    if (url.pathname.includes("/tickers/")) return route.fulfill({ json: { schemaVersion: "ticker.v1", requested: "SYNTH", ticker: "SYNTH", listed: true } });
    if (url.pathname.endsWith("/revision")) return route.fulfill({ json: { revisions: {} } });
    const resource = url.pathname.split("/").at(-1);
    if (opening.resources[resource]) return route.fulfill({ json: opening.resources[resource].body });
    if (url.pathname.endsWith("/SYNTH")) return route.fulfill({ json: opening.resources.company.body });
    return route.fulfill({ status: 404, json: { error: "No local fixture" } });
  });
  await page.route("**/agents/**", route => route.fulfill({ json: { open: false } }));
  return requests;
}
try {
  for (const [width, height, lang] of [[1440,900,"en"],[390,844,"zh-CN"]]) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
    const page = await context.newPage(); const errors = []; page.on("pageerror", error => errors.push(error.message));
    const requests = await setup(page);
    await page.goto(`${base}/companies/SYNTH?${params({ lang })}`);
    const summary = page.locator(`[data-filing-impact="${fixture.result.resultId}"]`);
    await summary.waitFor({ timeout: 45000 });
    assert.equal(await page.locator(".filing-company-reference").evaluate(element => element.open), false);
    assert.ok((await summary.innerText()).includes("82M") || (await summary.innerText()).includes("8200万"));
    assert.equal((await summary.innerText()).includes("+183.7%"), false);
    const resultId = await summary.getAttribute("data-filing-impact");
    await page.screenshot({ path: `${directory}/${width}-summary.png` });
    await summary.locator("a").click();
    await page.waitForURL(/view=valuation/);
    await page.locator(`[data-filing-impact="${resultId}"]`).waitFor();
    assert.equal(await page.locator("[data-filing-impact]").getAttribute("data-filing-impact"), resultId);
    assert.equal(new URL(page.url()).searchParams.get("artifactHash"), fixture.selection.hash);
    const inputDetails = page.locator(".filing-impact-calculation details").first();
    await inputDetails.locator("summary").click();
    const inputTable = await inputDetails.innerText();
    assert.match(inputTable, /16400 USDmillions/); assert.match(inputTable, /16,400,000,000 USD/);
    await page.locator(".filing-impact-sources > summary").click();
    assert.ok((await page.locator(".filing-impact-sources").innerText()).includes(fixture.selection.hash));
    const scroll = page.locator(".filing-impact-panel > .lens-doc");
    await scroll.focus(); await page.keyboard.press("PageDown"); await page.waitForTimeout(100);
    const keyboardScrolled = await scroll.evaluate(element => element.scrollTop > 0);
    await scroll.hover(); await page.mouse.wheel(0, 15000); await page.waitForTimeout(150);
    const end = await scroll.evaluate(element => ({ top: element.scrollTop, max: element.scrollHeight - element.clientHeight }));
    assert.ok(end.max === 0 || end.max - end.top <= 2);
    await page.mouse.wheel(0, -15000); await page.waitForTimeout(150);
    assert.equal(await scroll.evaluate(element => element.scrollTop), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${directory}/${width}-detail.png` });
    await page.reload(); await page.locator(`[data-filing-impact="${resultId}"]`).waitFor();
    await page.goBack(); await page.locator(`[data-filing-impact="${resultId}"]`).waitFor();
    assert.equal(errors.length, 0);
    results.push({ viewport: [width, height], lang, resultId, canonicalHash: fixture.selection.hash, keyboardScrolled, reachesEnd: true, returnsToTop: true, inputTable, requests, errors });
    await context.close();
  }
  for (const variant of ["preview", "wrong-hash", "stale", "missing-sidecar", "forged-preview"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await context.newPage(); await setup(page);
    const selection = new URLSearchParams({ view: "valuation", filingImpact: fixture.selection.accession, artifactVersion: fixture.selection.version, artifactHash: fixture.selection.hash, lang: "en" });
    if (variant === "preview") selection.set("artifact-preview", fixture.token);
    if (variant === "forged-preview") selection.set("artifact-preview", `${fixture.token}a`);
    if (variant === "wrong-hash") selection.set("artifactHash", "0".repeat(64));
    if (variant === "stale" || variant === "missing-sidecar") await page.route("**/api/business/v1/companies/SYNTH/filings/**", route => route.fulfill({ json: { ...fixture.detail, artifact: variant === "stale" ? fixture.stale : { ...fixture.artifact, filingImpact: null } } }));
    await page.goto(`${base}/companies/SYNTH?${selection}`);
    if (variant === "wrong-hash" || variant === "forged-preview") { await page.getByRole("alert").filter({ hasText: "exact filing edition" }).waitFor(); assert.equal(await page.locator("[data-filing-impact]").count(), 0); }
    else if (variant === "missing-sidecar") await page.getByText("This edition has no saved structured investment bridge.", { exact: false }).waitFor();
    else {
      await page.locator(`[data-filing-impact="${fixture.result.resultId}"]`).waitFor();
      if (variant === "preview") await page.getByText("Unpublished preview", { exact: false }).waitFor();
      if (variant === "stale") { await page.getByText("Adopted research needs review.", { exact: false }).waitFor(); assert.equal(await page.locator(".filing-impact-calculation").count(), 0); }
    }
    results.push({ variant, passed: true }); await context.close();
  }
  for (const variant of ["report-preview-denied", "report-preview-empty", "report-preview-loading", "report-sidebar", "detail-sidebar", "preview-sidebar", "private-reference", "private-reference-mismatch", "long-chain", "long-chain-desktop"]) {
    const width = variant === "long-chain-desktop" ? 1440 : 390, height = variant === "long-chain-desktop" ? 900 : 844;
    const context = await browser.newContext({ viewport: { width, height } }); const page = await context.newPage(); const requests = await setup(page);
    const query = params({ lang: "en" });
    if (variant.startsWith("report-preview")) { query.delete("artifactVersion"); query.delete("artifactHash"); query.set("artifact-preview", variant === "report-preview-empty" ? "" : `${fixture.token}a`); }
    if (variant === "preview-sidebar") query.set("artifact-preview", fixture.token);
    if (variant === "detail-sidebar") { query.delete("report"); query.set("view", "valuation"); query.set("filingImpact", fixture.selection.accession); }
    if (variant === "report-preview-loading") await page.route("**/api/business/v1/artifact-preview/**", async route => { await new Promise(resolve => setTimeout(resolve, 1500)); await route.fulfill({ status: 404, json: { error: "Synthetic denied preview" } }); });
    const adjustmentId = "a".repeat(32), adjustmentBase = "d".repeat(32);
    if (variant.startsWith("private-reference")) {
      query.set("valuationAdjustment", adjustmentId);
      const result = { schemaVersion: "valuation-adjustment.v1", id: adjustmentId, ticker: "SYNTH", baseVersionId: adjustmentBase, createdAt: "2026-11-17T00:00:00Z", researchAsOf: "2026-11-17T00:00:00Z", financialPeriodEnd: "2026-09-30", currency: "USD", input: { factor: "discountRate", delta: .01, baseVersionId: variant === "private-reference-mismatch" ? "e".repeat(32) : adjustmentBase }, cases: [] };
      await page.route(`**/agents/valuation-adjustments/${adjustmentId}`, route => route.fulfill({ json: { status: "available", result } }));
    }
    if (variant.startsWith("long-chain")) {
      const artifact = structuredClone(fixture.artifact);
      artifact.filingImpact.chains = Array.from({ length: 3 }, (_, index) => ({ ...fixture.result.chains[0], id: `long-${index}`, revisedAssumption: fixture.result.chains[0].revisedAssumption.repeat(25), financialEffect: fixture.result.chains[0].financialEffect.repeat(25), missingInputs: fixture.result.chains[0].missingInputs.map(text => text.repeat(20)) }));
      await page.route("**/api/business/v1/companies/SYNTH/filings/**", route => route.fulfill({ json: { ...fixture.detail, artifact } }));
    }
    await page.goto(`${base}/companies/SYNTH?${query}`);
    if (variant === "report-preview-loading") {
      await page.locator(".report-document > [role=status]").waitFor();
      assert.equal(await page.locator("iframe[data-artifact-frame]").count(), 0);
      await page.locator(".report-document > [role=alert]").waitFor();
    } else if (variant === "report-preview-denied" || variant === "report-preview-empty") {
      await page.locator(".report-document > [role=alert]").waitFor();
      assert.equal(await page.locator("iframe[data-artifact-frame]").count(), 0);
      assert.equal(requests.some(url => /\/filings\//.test(url)), false);
    } else {
      await page.locator(`[data-filing-impact="${fixture.result.resultId}"]`).waitFor();
      if (variant.endsWith("sidebar")) {
        await page.getByText(fixture.otherFiling.title, { exact: true }).click();
        await page.locator(`iframe[data-artifact-hash="${fixture.otherFiling.hash}"]`).waitFor();
        const next = new URL(page.url());
        for (const pin of ["artifactVersion","artifactHash","filingImpact","artifact-preview"]) assert.equal(next.searchParams.has(pin), false);
        assert.equal(next.searchParams.get("report"), fixture.otherFiling.accession);
        await page.goBack(); await page.locator(`[data-filing-impact="${fixture.result.resultId}"]`).waitFor();
      } else if (variant.startsWith("private-reference")) {
        await page.locator(".filing-company-reference > summary").click();
        const link = page.getByRole("link", { name: "Open company valuation", exact: true }); await link.waitFor();
        const url = new URL(await link.getAttribute("href"), base);
        assert.equal(url.searchParams.has("valuationAdjustment"), variant === "private-reference");
        if (variant === "private-reference") assert.equal(url.searchParams.get("valuationVersion"), adjustmentBase);
      } else if (variant.startsWith("long-chain")) {
        const start = await page.locator("iframe[data-artifact-frame]").boundingBox();
        assert.ok(start && start.y < height, `Body start is offscreen: ${JSON.stringify(start)}`);
        assert.ok(await page.locator(".filing-impact-chain--compact").first().evaluate(element => element.clientHeight < 180));
        await page.locator(".filing-impact-chain--compact details > summary").first().click();
        assert.ok((await page.locator(".filing-impact-chain--compact").first().innerText()).length > 1000);
        await page.screenshot({ path: `${directory}/${width}-long-chain-expanded.png` });
      }
    }
    results.push({ variant, passed: true }); await context.close();
  }
  await writeFile(`${directory}/results.json`, JSON.stringify({ at: new Date().toISOString(), scope: "Actual local read-handler responses and synthetic company opening; no model or production requests", results }, null, 2));
  console.log(JSON.stringify({ journeys: results.length, evidence: `${directory}/results.json` }));
} finally { await browser.close(); }
