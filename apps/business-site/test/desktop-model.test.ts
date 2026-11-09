import assert from "node:assert/strict";
import test from "node:test";
import { desktopPolicy, pictureFramePolicy, readHeaderPolicies } from "../desktop-shell.vite.ts";
import { companyOfLink, isExternal, isReopenable, proxiedUrl, proxyBase, themeAtLaunch, thumbBox, viewForDigit } from "../src/desktop/desktop-model.ts";

const PROXY = "spontra-api://localhost";

test("site reads, the stage and logos go through the proxy; nothing else does", () => {
  assert.equal(proxiedUrl("/api/business/v1/home?lang=en", PROXY), `${PROXY}/api/business/v1/home?lang=en`);
  assert.equal(proxiedUrl("/agents/status?ticker=X", PROXY), `${PROXY}/agents/status?ticker=X`);
  assert.equal(proxiedUrl("https://images.financialmodelingprep.com/symbol/BRK.B.png", PROXY), `${PROXY}/logo/BRK.B.png`);
  assert.equal(proxiedUrl("https://example.com/data.json", PROXY), "https://example.com/data.json");
  assert.equal(proxiedUrl("/assets/font.woff2", PROXY), "/assets/font.woff2");
});

test("Windows reaches custom schemes over http", () => {
  assert.equal(proxyBase("Mozilla/5.0 (Windows NT 10.0) Edg/140"), "http://spontra-api.localhost");
  assert.equal(proxyBase("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), PROXY);
});

test("only home and company pages reopen at launch", () => {
  assert.equal(isReopenable("/"), true);
  assert.equal(isReopenable("/companies/BRK.B?view=cash"), true);
  assert.equal(isReopenable("/companies/lower"), false);
  assert.equal(isReopenable("/settings"), false);
});

test("the theme follows the system until the reader departs from it", () => {
  assert.equal(themeAtLaunch(null, null, "light"), "light");
  assert.equal(themeAtLaunch("dark", "dark", "light"), "light");
  assert.equal(themeAtLaunch("dark", "light", "light"), "dark");
  assert.equal(themeAtLaunch("dark", null, "light"), "light");
});

test("digits one to four choose the views in tab order", () => {
  assert.equal(viewForDigit("1"), "valuation");
  assert.equal(viewForDigit("4"), "balance");
  assert.equal(viewForDigit("5"), null);
});

test("only other sites leave the app", () => {
  assert.equal(isExternal("https://www.sec.gov/x"), true);
  assert.equal(isExternal("http://tauri.localhost/companies/X"), false);
  assert.equal(isExternal("tauri://localhost/companies/X"), false);
});

test("a company link names the company it reads ahead", () => {
  assert.equal(companyOfLink("/companies/BRK.B?view=cash"), "BRK.B");
  assert.equal(companyOfLink("/"), null);
});

test("the scroll thumb follows the position and only appears on overflow", () => {
  const view = { top: 100, right: 500, height: 400 };
  assert.equal(thumbBox(view, 0, 400), null);
  assert.deepEqual(thumbBox(view, 0, 800), { top: 103, left: 492, height: 197 });
  const end = thumbBox(view, 400, 800)!;
  assert.equal(end.top + end.height, 497);
  assert.equal(thumbBox(view, 0, 100000)!.height, 28);
});

const HEADERS = `/*
  X-Content-Type-Options: nosniff
  Content-Security-Policy: default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; img-src 'self' data: https://images.financialmodelingprep.com; connect-src 'self' https://cloudflareinsights.com; frame-ancestors 'none'

# A comment.
/html-frame
  ! Content-Security-Policy
  Content-Security-Policy: default-src 'none'; font-src https: data:; connect-src 'none'; frame-ancestors 'self'
`;

test("the app's policies come from the site's headers", () => {
  const policies = readHeaderPolicies(HEADERS);
  const page = desktopPolicy(policies.get("/*")!, "https://site.example");
  assert.match(page, /script-src 'self';/);
  assert.match(page, /connect-src 'self' ipc: http:\/\/ipc\.localhost spontra-api:\/\/localhost http:\/\/spontra-api\.localhost wss:\/\/site\.example/);
  assert.match(page, /img-src 'self' data: https:\/\/images\.financialmodelingprep\.com blob:/);
  assert.doesNotMatch(page, /frame-ancestors|cloudflareinsights/);
  const frame = pictureFramePolicy(policies.get("/html-frame")!);
  assert.match(frame, /connect-src 'none'/);
  assert.match(frame, /font-src https: data: tauri: http:\/\/tauri\.localhost/);
});
