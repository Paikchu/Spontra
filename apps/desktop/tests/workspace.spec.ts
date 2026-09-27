import { test, expect, type Page } from "@playwright/test";
import { buildPortfolioPresentation } from "../../../packages/client/src/portfolio";
import { emptyCalendar } from "../../../lib/earnings-live";
import { readerFilingFixture } from "../../../tests/fixtures/sec-reader-fixture";
import type { PortfolioSnapshotV1 } from "../../../lib/portfolio-snapshot";
const token = "desktop-browser-test-token-000000000000";
const snapshot = { generatedAt: "2026-09-28T00:00:00Z", account: { netLiquidation: 10000, netDeposits: 8000, cashBalance: 5000 }, positions: [
  { symbol: "DEMO", assetClass: "STK", name: "示例公司", quantity: 50, marketPrice: 100, marketValue: 5000, unrealizedPnl: 2000, averageCost: 60, costBasis: 3000 },
], trades: [] } as unknown as PortfolioSnapshotV1;
const presentation = buildPortfolioPresentation(snapshot, emptyCalendar());
const source = { id: "source1", title: "测试来源", url: "https://example.com/report", publishedAt: null, retrievedAt: "2026-09-28T00:00:00Z", kind: "company", excerpt: "合成测试数据" };
const report = { version: "research.v1", id: "r1", caseId: "case1", title: "测试研究汇报", summary: "核查合成公司的现金流", tickers: ["DEMO"], generatedAt: "2026-09-28T00:00:00Z", asOf: "2026-09-28T00:00:00Z", trigger: "baseline", content: [{ type: "markdown", blockId: "body", markdown: "这是用于桌面验收的合成研究正文。", evidenceIds: ["source1"] }], sources: [source], hypotheses: [], followups: [], limitations: [] };
const raw = readerFilingFixture();
const filing = { ...raw, accessionNumber: "0000000001-26-000001", edgarUrl: raw.indexUrl, reportVersion: "sec-analysis.v3:demo", provenance: "sec_edgar", analysisStatus: "complete", periodId: "DEMO:2026-06-30:quarter", analysisSchemaVersion: "sec-analysis.v3", contentRevision: "demo", analysisRun: { state: "succeeded", updatedAt: null, errorCode: null } };
async function mockDesktop(page: Page, saved = true) {
  let offline = false; let unauthorized = false; let writes = 0; let canceled = 0;
  const paths: string[] = []; const opened: string[] = []; const copies: string[] = [];
  let plan: unknown = null;
  await page.exposeFunction("__nativeTest", async (cmd: string, args: Record<string, string>) => {
    if (cmd === "connection_status") return saved;
    if (cmd === "connect") { if (args.token !== token) throw new Error("INVALID_TOKEN"); unauthorized = false; return null; }
    if (cmd === "cancel_request") { canceled++; return null; }
    if (cmd === "disconnect") return null;
    if (cmd === "plugin:event|listen") return 1;
    if (cmd === "plugin:event|unlisten") return null;
    if (cmd === "open_external") { opened.push(args.url); return null; }
    if (cmd === "plugin:clipboard-manager|write_text") { copies.push(args.text); return null; }
    if (cmd !== "api_request") throw new Error(`Unexpected command: ${cmd}`);
    paths.push(args.path);
    if (offline) throw new Error("NETWORK_UNAVAILABLE");
    if (unauthorized) return { status: 401, body: JSON.stringify({ error: "unauthorized" }) };
    const url = new URL(args.path, "https://example.test"); const path = url.pathname;
    let body: unknown = {};
    if (path === "/portfolio") body = { source: "live", asOf: snapshot.generatedAt, presentation };
    else if (path === "/research/feed") body = { reports: [report], nextCursor: null, monitor: { enabled: true, tickers: ["DEMO"], issues: [], holdingsAsOf: null, lastScanAt: null } };
    else if (path === "/earnings") body = emptyCalendar();
    else if (path === "/quotes") body = { quotes: {} };
    else if (path === "/plans") body = { plans: [] };
    else if (path.startsWith("/plans/")) {
      if (args.method === "PUT") { writes++; plan = { ...JSON.parse(args.body), ticker: "DEMO", name: "示例公司", id: "plan1", updatedAt: new Date().toISOString() }; }
      body = { plan };
    } else if (path.startsWith("/stocks/")) {
      const ticker = path.split("/").at(-1);
      if (ticker === "SLOW") await new Promise(resolve => setTimeout(resolve, 400));
      body = { ticker, companyName: "示例公司", exchange: "TEST", trades: [], position: presentation.positionGroups[0] };
    }
    else if (path.endsWith("/search") || path === "/symbols") body = { results: [{ symbol: "DEMO", name: "示例公司", exchange: "TEST", type: "stock" }] };
    else if (path.endsWith("/filings")) body = { filings: [filing], total: 1, nextCursor: null, checkedAt: null };
    else if (path.includes("/filings/")) body = { company: { ticker: "DEMO", cik: "0000000001", name: "示例公司" }, filing };
    else if (path.endsWith("/analysis")) body = { overview: null, latestRun: { state: "none" } };
    else if (path.endsWith("/fundamentals")) body = { source: "sec_xbrl", status: "pending", metrics: [], series: [], periods: [] };
    else throw new Error(`Unmocked route: ${path}`);
    return { status: 200, body: JSON.stringify(body) };
  });
  await page.addInitScript(() => {
    Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} }, __TAURI_INTERNALS__: {
      invoke: (cmd: string, args: Record<string, string>) => (window as unknown as { __nativeTest: (c: string, a: Record<string, string>) => Promise<unknown> }).__nativeTest(cmd, args),
      transformCallback: () => 1, unregisterCallback: () => {},
    }});
  });
  return { paths, opened, copies, canceled: () => canceled, writes: () => writes, offline: (value: boolean) => { offline = value; }, unauthorized: () => { unauthorized = true; } };
}
const shortcut = (key: string) => `${process.platform === "darwin" ? "Meta" : "Control"}+${key}`;

test("connects, navigates all main surfaces, preserves state and handles loss of connection", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const native = await mockDesktop(page, false);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "连接 Spontra" })).toBeVisible();
  await page.getByLabel("访问令牌", { exact: true }).fill("bad-token-00000000000000000000000000");
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("连接失败");
  await page.getByLabel("访问令牌", { exact: true }).fill(token);
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await expect(page.getByRole("heading", { name: "研究汇报", exact: true })).toBeVisible();
  await expect(page.getByText("这是用于桌面验收的合成研究正文。")).toBeVisible();
  await page.keyboard.press(shortcut("2"));
  await expect(page.getByRole("heading", { name: "投资账本", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "历史持仓" }).click();
  await page.keyboard.press(shortcut("4"));
  await page.getByRole("radio", { name: "English" }).click();
  await expect(page.getByRole("heading", { name: "Desktop connection" })).toBeVisible();
  await page.getByRole("radio", { name: "中文" }).click();
  await page.keyboard.press(shortcut("2"));
  await expect(page.getByRole("tab", { name: "历史持仓" })).toHaveAttribute("aria-selected", "true");
  native.offline(true);
  await page.keyboard.press(shortcut("r"));
  await expect(page.getByRole("alert").filter({ hasText: "连接暂时不可用" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "投资账本", exact: true })).toBeVisible();
  native.offline(false);
  await page.keyboard.press(shortcut("r"));
  await expect(page.getByRole("alert").filter({ hasText: "连接暂时不可用" })).toHaveCount(0);
  native.unauthorized(); await page.keyboard.press(shortcut("r"));
  await expect(page.getByRole("heading", { name: "连接 Spontra" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("stock tabs, plan writes, pinned reports, copy and external sources", async ({ page }) => {
  const native = await mockDesktop(page);
  await page.goto("/#/positions/DEMO");
  await expect(page.getByRole("heading", { name: "DEMO", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "持仓计划", exact: true }).click();
  await expect(page).toHaveURL(/positions\/DEMO#plan/);
  await page.getByLabel("持仓原因", { exact: true }).fill("桌面计划测试：现金流持续改善。");
  await page.keyboard.press(shortcut("r"));
  await expect(page.getByLabel("持仓原因", { exact: true })).toHaveValue("桌面计划测试：现金流持续改善。");
  await page.getByRole("button", { name: "立即保存" }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(page.getByRole("status").filter({ hasText: "计划已保存" })).toBeVisible();
  expect(native.writes()).toBe(1);
  await page.goto("/#/analysis/stocks/DEMO/sec/0000000001-26-000001?reportDate=2026-06-30&reportVersion=sec-analysis.v3%3Ademo");
  await expect(page.getByText("增长更快了，投资判断转向现金兑现").first()).toBeVisible();
  await page.getByText("报告链接与版本", { exact: true }).click();
  await page.getByRole("button", { name: "复制链接" }).click();
  await expect(page.getByText("已复制", { exact: true })).toBeVisible();
  expect(native.copies[0]).toContain("https://spontra.max-zhangyuchen.workers.dev/analysis/stocks/DEMO/sec/");
  expect(native.copies[0]).toContain("reportVersion=sec-analysis.v3%3Ademo");
  await page.getByRole("link", { name: "本报告固定链接" }).click();
  expect(native.opened[0]).toBe(native.copies[0]);
  expect(native.paths.some(path => path.includes("reportDate=2026-06-30&reportVersion=sec-analysis.v3%3Ademo"))).toBeTruthy();
});

for (const width of [1024, 1280, 1600]) test(`desktop composition at ${width}px`, async ({ page }) => {
  await mockDesktop(page);
  await page.setViewportSize({ width, height: width === 1024 ? 720 : 900 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "研究汇报", exact: true })).toBeVisible();
  await page.screenshot({ path: `/tmp/spontra-desktop-${width}.png` });
  const overflow = await page.evaluate(() => [...document.querySelectorAll("body *")].filter(el => el.getBoundingClientRect().right > innerWidth + 1).slice(0, 8).map(el => ({ tag: el.tagName, class: el.className, right: el.getBoundingClientRect().right })));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), JSON.stringify(overflow)).toBeTruthy();
  await page.screenshot({ path: `/tmp/spontra-desktop-${width}.png` });
});


test("search cancels a superseded company and refreshes the current context", async ({ page }) => {
  const native = await mockDesktop(page);
  await page.goto("/#/analysis");
  const search = page.getByRole("textbox", { name: "搜索股票代码或公司名称" });
  await search.fill("SLOW");
  await search.press("Enter");
  await expect.poll(() => native.paths.includes("/stocks/SLOW")).toBeTruthy();
  await search.fill("DEMO");
  await search.press("Enter");
  await expect(page.getByRole("heading", { name: "DEMO", exact: true })).toBeVisible();
  await expect.poll(native.canceled).toBeGreaterThan(0);
  const previousReads = native.paths.filter(path => path === "/stocks/DEMO").length;
  await page.keyboard.press(shortcut("r"));
  await expect.poll(() => native.paths.filter(path => path === "/stocks/DEMO").length).toBeGreaterThan(previousReads);
  await expect(page.getByRole("heading", { name: "DEMO", exact: true })).toBeVisible();
});
