import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

// Source-level assertions follow the dashboard's component boundary after extraction.
async function readDashboardSource() {
  const paths = ["portfolio-dashboard.tsx", "portfolio/overview.tsx", "portfolio/allocation.tsx", "portfolio/ledger.tsx", "portfolio/pnl.tsx", "portfolio/option-contract-label.tsx"];
  return (await Promise.all(paths.map(path => readFile(new URL(`../app/${path}`, import.meta.url), "utf8")))).join("\n");
}


async function render(path = "/", options = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html", ...(options.headers ?? {}) } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ...(options.env ?? {}) },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the investment record", async () => {
  const snapshot = JSON.parse(await readFile(new URL("../data/portfolio-snapshot.json", import.meta.url), "utf8"));
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>MAX · 投资记录<\/title>/i);
  assert.match(html, /当前净值/);
  assert.match(html, new RegExp(`\\$${snapshot.account.netLiquidation.toLocaleString("en-US", { minimumFractionDigits: 2 })}`.replace(".", "\\.")));
  assert.doesNotMatch(html, /IBKR 数据更新|数据源：IBKR|实际持仓成本\s*=|AI 生成|AI 分析|由 AI/i);
  assert.doesNotMatch(html, />交易(?:<|\s)/);
  assert.doesNotMatch(html, /Google Sheets/);
  assert.doesNotMatch(html, /Portfolio \/ 01|NAV RECONCILIATION|CORE POSITIONS|Transactions \/ 398/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("opens on four sample reports and retains the portfolio below", async () => {
  const html = await (await render()).text();
  assert.doesNotMatch(html, /class="site-header"|class="site-primary-nav"|class="profile-menu"/);
  assert.doesNotMatch(html, /每日复盘|每日投资复盘|今日宏观经济|昨日收盘总结|id="review-panel"/);
  assert.match(html, /id="daily-reports-title">群聊<\/h1>/);
  assert.match(html, /示例/);
  assert.equal((html.match(/class="daily-reports-tile"/g) ?? []).length, 4);
  assert.match(html, /id="portfolio-panel"[^>]*role="region"/);
  assert.match(html, /<h1 class="summary-nav-label" id="portfolio-title">当前净值<\/h1>/);
  assert.ok(html.indexOf('id="daily-reports-title"') < html.indexOf('id="portfolio-title"'));
});

test("shows backend net deposits without manual settings", async () => {
  const response = await render();
  const html = await response.text();
  const dashboard = await readDashboardSource();
  assert.match(html, /净入金/);
  assert.doesNotMatch(html, /调整净入金/);
  assert.doesNotMatch(dashboard, /localStorage|InvestmentSettingsDialog|onOpenSettings/);
  assert.match(dashboard, /const configuredTotalPnl = netLiquidation - netDeposits/);
});

test("renders the portfolio and investment ledger together", async () => {
  const html = await (await render()).text();
  assert.match(html, /class="portfolio-overview"/);
  assert.match(html, /class="heatmap-plot"/);
  assert.match(html, /<h2 id="ledger-title">投资账本<\/h2>/);
  assert.match(html, /aria-label="投资账本"/);
  assert.match(html, /aria-sort="descending"/);
  assert.doesNotMatch(html, /aria-label="账本排序"/);
  assert.match(html, /data-slot="table"/);
  assert.ok(html.indexOf('id="portfolio-title"') < html.indexOf('id="ledger-title"'));
});

test("redirects old ledger and retired report URLs to the combined page", async () => {
  for (const [path, target] of [["/ledger", "/#ledger-title"], ["/market-close", "/"], ["/market-close?date=2026-09-01", "/"]]) {
    const response = await render(path);
    assert.equal(response.status, 307, path);
    assert.equal(new URL(response.headers.get("location"), "http://localhost").href, new URL(target, "http://localhost").href, path);
  }
});

test("renders settings with theme and language controls in the shared dock", async () => {
  const response = await render("/settings");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /aria-label="主导航"/);
  assert.match(html, /id="settings-title"/);
  assert.match(html, /data-slot="card"/);
  assert.match(html, /aria-labelledby="theme-label"/);
  assert.match(html, /aria-labelledby="language-label"/);
  for (const label of ["日间模式", "夜间模式", "跟随系统", "中文", "English"]) assert.ok(html.includes(label));
  assert.doesNotMatch(await (await render()).text(), /切换日间或夜间模式|data-slot="toggle-group"/);
});

test("allows anonymous company browsing and reports unavailable plan storage", async () => {
  for (const ticker of ["NOK", "MSFT", "SATS"]) {
    const response = await render(`/positions/${ticker}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("location"), null);
    const html = await response.text();
    assert.match(html, /stock-detail-identity/);
    assert.doesNotMatch(html, /ownership-structure|股权结构/);
    assert.doesNotMatch(html, /<textarea/);
  }
  const response = await render("/api/plans/NOK");
  assert.equal(response.status, 500);
});

test("removes the disposable starter preview", async () => {
  const [page, dashboard, layout, packageJson, viewModel] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readDashboardSource(),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../lib/portfolio-view-model.ts", import.meta.url), "utf8"),
  ]);

  assert.match(dashboard, /当前净值/);
  assert.match(dashboard, /<div className="hero">/);
  assert.match(dashboard, /className="portfolio-heading"/);
  assert.match(dashboard, /className="summary-support"/);
  assert.doesNotMatch(dashboard, /MAX \/ PORTFOLIO 01|header-identity/);
  assert.doesNotMatch(page, /LedgerTab|TradeFilter|recentTrades|filteredTrades|switchLedger|updateUrl/);
  assert.doesNotMatch(page, /trade-disclosure|trade-toolbar|交易明细|role="tablist"/);
  assert.match(page, /buildPortfolioViewModel/);
  assert.doesNotMatch(page, /portfolio-history\.json/);
  assert.match(page, /PortfolioDashboard/);
  assert.match(dashboard, /activeSymbol/);
  assert.match(dashboard, /sortPositionGroups/);
  assert.doesNotMatch(dashboard, /filterPortfolioHistory|PortfolioHistoryPoint|PortfolioHistoryRange/);
  assert.doesNotMatch(page, /PageTab|activePage|switchPage|持仓分析|className="tabs"/);
  assert.match(viewModel, /actualCost/);
  assert.match(viewModel, /\(position\.costBasis - realized\) \/ position\.quantity/);
  assert.match(page, /currentPortfolioSnapshot/);
  assert.doesNotMatch(page, /const holdings = \[/);
  assert.doesNotMatch(page, /const optionContracts = \[/);
  assert.doesNotMatch(page, /const recentTrades = \[/);
  assert.doesNotMatch(page, /holding\.weight \/ 31\.12/);
  assert.doesNotMatch(dashboard, /SiteHeader/);
  assert.match(dashboard, /<section className="portfolio-overview"/);
  assert.doesNotMatch(page, /masthead|SnapshotNotice|className="(?:eyebrow|kicker)"/);
  assert.match(layout, /lang="zh-CN"/);
  assert.match(layout, /个人投资组合与持仓记录/);
  assert.doesNotMatch(layout, /个人持仓、交易与盈亏记录/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});

test("uses the approved ledger-dominant hierarchy without horizontal scrolling", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(page, /snapshot-status|ruled-heading|subtabs|formula-note|<footer/);
  assert.doesNotMatch(page, /点击展开合约|可收起|表内滚动/);
  assert.doesNotMatch(page, /个 Ticker|个正股|份期权/);
  assert.match(css, /grid-template-columns: minmax\(240px, 28fr\) minmax\(0, 72fr\);/);
  assert.match(css, /\.lower-grid \{[\s\S]*?border-top: 1px solid var\(--ink\);/);
  assert.match(css, /\.section-divider \{[\s\S]*?border-top: 1px dashed var\(--paper-deep\);/);
  assert.doesNotMatch(css, /min-width:\s*900px/);
  assert.match(css, /\.position-scroll \{[\s\S]*?overflow-x: visible;/);
  assert.match(css, /\.hero \{[\s\S]*?grid-template-columns: minmax\(300px, \.75fr\) minmax\(0, 1\.25fr\);/);
  assert.match(css, /\.summary-nav-value \{[\s\S]*?font-size: clamp\(40px, 4vw, 50px\);/);
  assert.match(css, /\.header-position-summary \{[\s\S]*?grid-template-columns: minmax\(110px, \.65fr\) minmax\(110px, \.65fr\) minmax\(190px, 1fr\) minmax\(280px, 1\.8fr\);/);
  assert.match(css, /h2 \{[\s\S]*?font: 600 22px\/1\.1 var\(--serif\);/);
  assert.doesNotMatch(css, /\.portfolio-header \{[^}]*background:/);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*?\.header-position-summary \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  assert.match(css, /font-variant-numeric: tabular-nums lining-nums;/);
  assert.doesNotMatch(css, /overscroll-behavior:\s*contain/);
  assert.match(css, /\.position-scroll \{[\s\S]*?overscroll-behavior: auto;/);
  assert.match(css, /\.table-wrap \{[\s\S]*?overscroll-behavior: auto;/);
});

test("uses an uncolored generic reminder slot beside the ticker", async () => {
  const [dashboard, css] = await Promise.all([
    readDashboardSource(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const mobileCss = css.match(/@media \(max-width: 620px\) \{([\s\S]*)\}\s*$/)?.[1] ?? "";
  const reminderCss = css.match(/\.position-reminder\s*\{([^}]*)\}/)?.[1] ?? "";

  assert.doesNotMatch(dashboard, /label: "财报（预计）"/);
  assert.doesNotMatch(dashboard, /className="company"/);
  assert.match(dashboard, /function PositionReminder/);
  assert.match(dashboard, /if \(!event\) return null;/);
  assert.match(dashboard, /className="ledger-identity"[\s\S]*?<PositionReminder/);
  assert.match(dashboard, /className="position-reminder"/);
  assert.doesNotMatch(dashboard, /<i>财报<\/i>|等待日程|data-empty/);
  assert.doesNotMatch(dashboard, /className="position-earnings"/);
  assert.match(css, /\.position-identity\s*\{[^}]*grid-template-columns:\s*4px auto minmax\(0, 1fr\);/s);
  assert.match(reminderCss, /min-width:\s*0;/);
  assert.match(reminderCss, /overflow:\s*hidden;/);
  assert.match(reminderCss, /justify-self:\s*stretch;/);
  assert.doesNotMatch(reminderCss, /background|border|box-shadow|color/);
  assert.match(mobileCss, /\.position-identity \{[^}]*grid-column: 1 \/ -1;[^}]*grid-template-columns: 4px auto minmax\(0, 1fr\);/);
  assert.match(mobileCss, /\.position-reminder \{[^}]*max-width: 210px;[^}]*justify-self: end;/);
});

test("removes the portfolio history chart while keeping supporting metrics", async () => {
  const [response, dashboard, snapshot] = await Promise.all([
    render(),
    readDashboardSource(),
    readFile(new URL("../data/portfolio-snapshot.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  const html = await response.text();

  assert.match(html, /当前净值/);
  const optionUnrealizedPnl = snapshot.positions
    .filter((position) => position.assetClass === "OPT")
    .reduce((sum, position) => sum + position.unrealizedPnl, 0);
  const netLiquidationWithoutOptionPnl = snapshot.account.netLiquidation - optionUnrealizedPnl;
  assert.match(html, /剔除期权浮盈亏/);
  assert.match(html, new RegExp(`\\$${netLiquidationWithoutOptionPnl.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`.replace(".", "\\.")));
  assert.match(html, /净入金/);
  assert.match(html, /现金/);
  assert.doesNotMatch(html, /净值走势|aria-label="净值周期"/);
  assert.doesNotMatch(dashboard, /PortfolioChart|className="portfolio-chart"|range-switch|历史净值正在积累/);
});

test("renders the current portfolio leverage in the portfolio overview", async () => {
  const [response, snapshot] = await Promise.all([
    render(),
    readFile(new URL("../data/portfolio-snapshot.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  const html = await response.text();
  const grossPositionsValue = snapshot.positions.reduce((sum, position) => sum + Math.abs(position.marketValue), 0);
  const leverage = grossPositionsValue / snapshot.account.netLiquidation;

  assert.match(html, /杠杆率/);
  assert.match(html, new RegExp(`${leverage.toFixed(2)}(?:<!-- -->)?x`));
});

test("renders the stock-only investment theme heatmap", async () => {
  const [response, snapshot] = await Promise.all([
    render(),
    readFile(new URL("../data/portfolio-snapshot.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  const html = await response.text();

  assert.match(html, /持仓主题热力图/);
  assert.match(html, /总敞口/);
  assert.match(html, /aria-label="持仓主题热力图"/);
  assert.match(html, /class="heatmap-domain /);
  const representativePositions = snapshot.positions
    .filter((position) => position.assetClass === "STK" && position.marketValue > 0)
    .sort((left, right) => right.marketValue - left.marketValue)
    .slice(0, 2);
  assert.ok(representativePositions.length > 0);
  for (const position of representativePositions) {
    const weight = (position.marketValue / snapshot.account.netLiquidation * 100).toFixed(2).replace(".", "\\.");
    assert.match(html, new RegExp(`${position.symbol}[^]*?${weight}%`));
  }
});

test("renders holding and sector allocation charts together", async () => {
  const [response, dashboard, css] = await Promise.all([
    render(),
    readDashboardSource(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const html = await response.text();

  assert.match(html, /id="holding-allocation-title">个股</);
  assert.match(html, /id="sector-allocation-title">板块</);
  assert.equal(html.match(/class="allocation-ring"/g)?.length, 2);
  assert.doesNotMatch(html, /class="allocation-tablist"/);
  assert.doesNotMatch(dashboard, /AllocationMode|allocationModes|setMode|aria-selected/);
  assert.match(dashboard, /SectorAllocationRing/);
  assert.match(dashboard, /allocationColor\(index\)/);
  assert.match(css, /\.allocation-comparison/);
  assert.match(css, /\.legend \{[^}]*gap: 2px;/s);
  assert.match(css, /\.legend-row \{[^}]*min-height: 32px;/s);
  assert.match(css, /@media \(max-width: 1024px\) \{[^]*?\.legend-row \{ min-height: 40px; \}/);
  assert.doesNotMatch(css, /\.allocation-tabs|\.allocation-tabpanels|\.allocation-tabpanel/);
});

test("keeps domain headers outside the holding tile area", async () => {
  const [component, css] = await Promise.all([
    readFile(new URL("../app/portfolio-heatmap.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(css, /\.heatmap-domain-tiles \{[^]*?inset: 26px 0 0;/);
  assert.doesNotMatch(css, /\.heatmap-domain-compact \.heatmap-domain-heading \{ display: none; \}/);
  assert.match(css, /\.heatmap-domain-compact \.heatmap-domain-heading \{[^]*?display: flex;/);
  assert.match(css, /\.heatmap-domain-compact \.heatmap-domain-tiles \{ inset: 24px 0 0; \}/);
  assert.match(css, /\.heatmap-domain-narrow \.heatmap-domain-heading \{[^]*?height: 24px;[^]*?writing-mode: horizontal-tb;/);
  assert.match(css, /\.heatmap-domain-narrow \.heatmap-domain-tiles \{ inset: 24px 0 0; \}/);
  assert.match(component, /heatmapDomainDensity/);
  assert.match(component, /insetTreemapRectangle/);
});

test("uses an in-plot floating window for holding details", async () => {
  const [component, css] = await Promise.all([
    readFile(new URL("../app/portfolio-heatmap.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(component, /className="heatmap-popover"/);
  assert.match(component, /role="tooltip"/);
  assert.doesNotMatch(component, /className="heatmap-detail"/);
  assert.match(component, /onMouseEnter=\{cancelPopoverClose\}/);
  assert.match(component, /onMouseLeave=\{schedulePopoverClose\}/);
  assert.match(component, /positionPopover[^]*?\[plotSize, popover\?\.symbol, positionPopover\]/);
  assert.match(css, /\.heatmap-popover \{[^]*?position: absolute;/);
  assert.match(css, /\.heatmap-popover \{[^]*?z-index: 4;/);
  assert.match(css, /\.heatmap-popover \{[^]*?pointer-events: auto;/);
});

test("keeps the heatmap responsive and keyboard reachable", async () => {
  const [dashboard, component, css] = await Promise.all([
    readDashboardSource(),
    readFile(new URL("../app/portfolio-heatmap.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(dashboard, /PortfolioHeatmap/);
  assert.match(css, /\.heatmap-plot \{[^]*?overflow: hidden;/);
  assert.match(css, /\.heatmap-tile:focus-visible/);
  assert.match(component, /onFocus=/);
  assert.match(component, /onBlur=/);
  assert.match(css, /@media \(max-width: 620px\)[^]*?\.heatmap-domain-tiles \{ inset-block-start: 20px; \}/);
});

test("groups stock and option positions by ticker", async () => {
  const snapshot = JSON.parse(await readFile(new URL("../data/portfolio-snapshot.json", import.meta.url), "utf8"));
  const response = await render();
  const html = await response.text();
  const symbols = [...new Set(snapshot.positions.map((position) => position.symbol))];
  const expectedTickerCount = symbols.length;
  const renderedTickerCount = html.match(/class="[^"]*ledger-data-row[^"]*"/g)?.length ?? 0;

  assert.equal(renderedTickerCount, expectedTickerCount);
  assert.doesNotMatch(html, /aria-label="查看 [^"]+ 持仓详情"/);
  assert.match(html, /，查看持仓详情/);
  assert.doesNotMatch(html, /<details class="position-row"/);
  for (const symbol of symbols) {
    const href = `href="/positions/${encodeURIComponent(symbol)}"`;
    assert.match(html, new RegExp(href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(html, /净市值/);
  assert.match(html, /已实现/);
  assert.match(await readDashboardSource(), /年内净盈亏/);
  assert.doesNotMatch(html, /持仓拆分|>拆分</);
  assert.doesNotMatch(html, /期权覆盖/);
});

test("uses semantic color tokens, stable holding marks, and a filled plan button", async () => {
  const [dashboard, heatmap, css] = await Promise.all([
    readDashboardSource(),
    readFile(new URL("../app/portfolio-heatmap.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(css, /--color-profit:/);
  assert.match(css, /--color-loss:/);
  assert.match(css, /\.add-plan-button[^]*?background: var\(--ink\);/);
  assert.match(dashboard, /allocationColor/);
  assert.match(dashboard, /otherWeight/);
  assert.match(dashboard, /data-active=\{segment\.symbol === activeSymbol/);
  assert.match(dashboard, /data-active=\{activeSymbol === group\.symbol\}/);
  assert.doesNotMatch(dashboard, /data-dimmed/);
  assert.doesNotMatch(heatmap, /data-dimmed/);
  assert.doesNotMatch(css, /\[data-dimmed="true"\]/);
  assert.match(heatmap, /--holding-color/);
  assert.match(heatmap, /signedPercent\(rate\)/);
  assert.doesNotMatch(css, /\.option-pill \{[^]*?color: #8b3b2b;/);
});

test("uses investment theme colors for heatmap headers and holding marks", async () => {
  const [dashboard, heatmap, css] = await Promise.all([
    readDashboardSource(),
    readFile(new URL("../app/portfolio-heatmap.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(dashboard, /"--holding-color": heatmapThemeColor\(group\.symbol\)/);
  assert.match(heatmap, /"--theme-color": heatmapDomainColor\(group\.domain\)/);
  assert.match(heatmap, /"--holding-color": heatmapThemeColor\(symbol\)/);
  assert.match(css, /\.heatmap-domain-heading\s*\{[^}]*background:\s*color-mix\(in oklch, var\(--theme-color\) 34%, var\(--paper\)\);[^}]*box-shadow:\s*inset 0 4px 0 var\(--theme-color\);/s);
  assert.match(css, /\.holding-mark\s*\{[^}]*background:\s*var\(--holding-color\);/s);
});

test("keeps small text high-contrast and visibly weighted", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(css, /--ink-soft:\s*#3f3f46/);
  assert.match(css, /--color-loss:\s*#b91c1c/);
  assert.match(css, /--color-profit:\s*#166534/);
  assert.match(css, /body\s*\{[^}]*font-weight:\s*500/s);
  assert.match(css, /-webkit-font-smoothing:\s*auto/);
});

test("keeps ledger labels and values above the minimum readable sizes", async () => {
  const [dashboard, css] = await Promise.all([
    readDashboardSource(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(dashboard, /className="daily-change-value/);
  assert.match(css, /--daily-gain:\s*#315b3d/);
  assert.match(css, /--daily-loss:\s*#8f2f25/);
  assert.match(css, /--muted-foreground:\s*#52525b/);
  assert.match(css, /\.position-row\s*\{[^}]*font-size:\s*14px;/s);
  assert.match(css, /\.position-identity\s*\{[^}]*align-items:\s*center;/s);
  assert.match(css, /\.position-reminder\s*\{[^}]*align-content:\s*center;/s);
  assert.match(css, /\.symbol\s*\{[^}]*font:\s*600 15px\/1 var\(--serif\);/s);
  assert.match(css, /\.position-reminder strong\s*\{[^}]*font-size:\s*12px;/s);
  assert.match(css, /\.position-reminder small\s*\{[^}]*font-size:\s*12px;/s);
  assert.match(css, /\.daily-change-value\s*\{[^}]*font-size:\s*14px;/s);
});

test("renders a single-line shadcn ledger with sorting in every header", async () => {
  const html = await (await render()).text();
  const table = html.match(/<table[^]*?<\/table>/)?.[0] ?? "";
  assert.equal((table.match(/scope="col"/g) ?? []).length, 10);
  assert.equal((table.match(/aria-sort=/g) ?? []).length, 10);
  for (const label of ["现价", "日涨跌", "净市值", "净权重", "摊薄成本", "持仓成本", "未实现盈亏", "年内已实现", "年内净盈亏"]) {
    assert.ok(table.includes(label));
  }
  assert.doesNotMatch(table, /position-market-cell|position-value-cell|position-cost-cell|position-year-cell/);
  assert.match(table, /未实现盈亏，点击降序/);
  assert.match(table, /净权重，点击升序/);
});

test("adds resilient company logos to current and historical ledger rows", async () => {
  const [dashboard, logo, css] = await Promise.all([
    readDashboardSource(),
    readFile(new URL("../app/company-logo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.equal((dashboard.match(/<CompanyLogo symbol=\{group\.symbol\} \/>/g) ?? []).length, 2);
  assert.match(logo, /loadCompanyLogo\(symbol\)/);
  assert.match(logo, /setAttribute\("data-failed", "true"\)/);
  assert.match(logo, /referrerPolicy="no-referrer"/);
  assert.match(css, /\.company-logo\s*\{[^}]*width:\s*26px;[^}]*height:\s*26px;/s);
  assert.match(css, /\.company-logo img\s*\{[^}]*object-fit:\s*contain;/s);
});

test("automatically resolves logos for newly planned tickers", async () => {
  const [dialog, detail, logo, css] = await Promise.all([
    readFile(new URL("../app/AddPlanDialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/positions/[ticker]/StockDetail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/company-logo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(dialog, /<CompanyLogo symbol=\{result\.symbol\} \/>/);
  assert.match(detail, /<CompanyLogo symbol=\{ticker\} size="lg" \/>/);
  assert.match(logo, /src=\{src\}/);
  assert.match(css, /\.company-logo\[data-size="lg"\]\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;/s);
});

test("switches between current and Flex-derived historical ticker groups", async () => {
  const [dashboard, viewModel, snapshotSource] = await Promise.all([
    readDashboardSource(),
    readFile(new URL("../lib/portfolio-view-model.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/portfolio-snapshot.ts", import.meta.url), "utf8"),
  ]);

  assert.match(dashboard, /<Tabs defaultValue="current"/);
  assert.match(dashboard, /<TabsList aria-label=\{t\("账本持仓范围"\)\}>/);
  for (const value of ["current", "historical", "plans"]) {
    assert.ok(dashboard.includes(`<TabsTrigger value="${value}">`));
    assert.ok(dashboard.includes(`<TabsContent value="${value}"`));
  }
  assert.doesNotMatch(dashboard, /<Switch|ledger-view-switch/);
  assert.match(dashboard, /t\("当前持仓 "\)\}<small>\{positionGroups\.length\}<\/small>/);
  assert.match(dashboard, /t\("历史持仓 "\)\}<small>\{historicalPositionGroups\.length\}<\/small>/);
  assert.match(dashboard, /<HistoricalPositionLedger groups=\{historicalPositionGroups\} \/>/);
  assert.match(dashboard, /累计已实现盈亏/);
  assert.match(viewModel, /if \(currentSymbols\.has\(symbol\)\) return groups;/);
  assert.doesNotMatch(snapshotSource, /mergeTrades[\s\S]{0,500}\.filter\(\(item\).*getUTCFullYear/);
});

test("keeps full ticker symbols visible before heatmap metrics", async () => {
  const [component, css] = await Promise.all([
    readFile(new URL("../app/portfolio-heatmap.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(component, /heatmapTileDensity/);
  assert.match(component, /heatmap-tile-symbol-only/);
  assert.match(css, /\.heatmap-tile-symbol-only \.heatmap-tile-metrics \{ display: none; \}/);
  assert.match(css, /\.heatmap-tile-symbol-only strong\s*\{[^}]*font-size:\s*12px;/s);
});

test("renders each option contract as an aligned child row of its ticker", async () => {
  const snapshot = JSON.parse(await readFile(new URL("../data/portfolio-snapshot.json", import.meta.url), "utf8"));
  const [dashboard, css] = await Promise.all([
    readDashboardSource(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const response = await render();
  const html = await response.text();
  const money = (value, sign = false) =>
    `${value < 0 ? "\u2212" : sign && value > 0 ? "+" : ""}$${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(value))}`;
  const optionPositions = snapshot.positions.filter((position) => position.assetClass === "OPT");
  const optionRows = html.match(/<tr[^>]*class="[^"]*ledger-option-row[^"]*"[^>]*>[\s\S]*?<\/tr>/g) ?? [];
  const columnCount = (dashboard.match(/\{ key: "[a-zA-Z]+", label: "[^"]+" \}/g) ?? []).length;

  assert.match(dashboard, /setSortKey/);
  assert.match(dashboard, /sortDirection/);
  assert.equal(optionRows.length, optionPositions.length);

  // The whole point of the child row is that its numbers land under the ticker's own headers.
  for (const row of optionRows) {
    assert.equal((row.match(/<td/g) ?? []).length, 10);
  }
  for (const position of optionPositions) {
    const row = optionRows.find((candidate) => candidate.includes(money(position.marketValue)));
    assert.ok(row, `no child row rendered ${position.contractDescription}`);
    // Per-contract unrealised P&L was dropped by the old submenu; it is the reason to read the row.
    assert.ok(row.includes(money(position.unrealizedPnl, true)), `${position.contractDescription} hides its unrealised P&L`);
    // The broker label stays in the hydration payload but never reaches the cell.
    assert.ok(!/@AMEX|&#x27;2\d/.test(row), `${position.contractDescription} still prints the raw broker label`);
  }
  assert.ok(columnCount >= 10);
  assert.match(html, /PUT<\/span>/);
  assert.match(html, /\$180<\/strong>/);
  assert.match(html, /2027-01-15/);

  assert.match(dashboard, /group\.options\.length > 0/);
  assert.doesNotMatch(dashboard, /group\.stock && group\.options\.length > 0/);
  assert.match(dashboard, /className="ledger-option-row"/);
  assert.match(dashboard, /<OptionContractLabel/);
  assert.match(dashboard, /option\.unrealized/);
  assert.match(dashboard, /aria-expanded=\{!collapsedOptions\.has\(group\.symbol\)\}/);
  assert.doesNotMatch(dashboard, /position-submenu|submenu-type|submenu-quantity|submenu-value/);
  assert.doesNotMatch(dashboard, /data-label="构成"|label: "构成"|className="position-kinds"/);
  assert.doesNotMatch(dashboard, /onOpenPosition/);
  assert.match(dashboard, /href=\{`\/positions\/\$\{encodeURIComponent\(group\.symbol\)\}`\}/);
  assert.doesNotMatch(dashboard, /breakdownSymbol|breakdown-trigger|position-breakdown|持仓拆分/);

  // Child rows stay a step quieter than their ticker and share one divider with it.
  assert.match(css, /\.ledger-table \.ledger-option-row td \{[^}]*height: 38px;[^}]*font-size: 13px;/);
  assert.doesNotMatch(css, /\.ledger-option-row td:first-child::before/);
  assert.match(css, /\.ledger-table \.ledger-data-row:has\(\+ \.ledger-option-row\)/);
  assert.match(css, /\.ledger-option-row \.option-contract \{ margin-inline-start: 24px; \}/);
  assert.doesNotMatch(css, /\.position-submenu|\.submenu-type|\.submenu-quantity|\.submenu-value/);
  assert.doesNotMatch(css, /\.position-kinds/);
  const mobileCss = css.match(/@media \(max-width: 620px\) \{([\s\S]*)\}\s*$/)?.[1] ?? "";
  assert.match(mobileCss, /\.ledger-option-row \.option-contract \{ margin-inline-start: 18px; \}/);
});

test("uses independent position routes and removes the workspace dialog", async () => {
  const [dashboard, addPlanDialog, detail] = await Promise.all([
    readDashboardSource(),
    readFile(new URL("../app/AddPlanDialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/positions/[ticker]/StockDetail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(dashboard, /import Link from "next\/link"/);
  assert.doesNotMatch(dashboard, /PositionDetailDialog|selectedPosition/);
  assert.doesNotMatch(dashboard, /aria-label=\{`查看 \$\{group\.symbol\} 持仓详情`\}/);
  assert.match(dashboard, /className="sr-only">\{t\("，查看持仓详情"\)\}/);
  assert.match(addPlanDialog, /navigate\(`\/positions\/\$\{encodeURIComponent\(result\.symbol\)\}`\)/);
  assert.match(detail, /<Tabs value=\{activeTab\}/);
  for (const label of ["业务前瞻", "财务指标", "持仓构成", "持仓计划", "披露时间线"]) assert.ok(detail.includes(label));
  await assert.rejects(access(new URL("app/PositionDetailDialog.tsx", projectRoot)));
});

test("renders price and daily change surfaces without source or snapshot labels", async () => {
  const [response, detail] = await Promise.all([
    render(),
    readFile(new URL("../app/positions/[ticker]/StockDetail.tsx", import.meta.url), "utf8"),
  ]);
  const html = await response.text();

  assert.match(html, /现价/);
  assert.match(html, /日涨跌/);
  assert.match(detail, /quote\.changePercent/);
  assert.match(detail, /RSI 14/);
  assert.match(detail, /quote\?\.rsi14/);
  assert.match(detail, /stock-detail-price/);
  assert.doesNotMatch(detail, /Yahoo Finance|IBKR 快照|snapshotTime/);
  assert.match(detail, /行情暂不可用/);
  assert.doesNotMatch(detail, /position\.value\s*=\s*quote|position\.unrealized\s*=\s*quote/);
});

test("retired review bookmarks render the combined portfolio without review content", async () => {
  const html = await (await render("/?view=review")).text();
  assert.match(html, /id="portfolio-title"/);
  assert.match(html, /id="ledger-title"/);
  assert.doesNotMatch(html, /每日投资复盘|关键驱动|观察清单|review-panel|daily-review/);
});

test("renders the holding summary in the portfolio overview without the market pulse", async () => {
  const [response, dashboard] = await Promise.all([
    render(),
    readDashboardSource(),
  ]);
  const html = await response.text();

  assert.match(html, /持仓净市值/);
  assert.match(html, /正股/);
  assert.match(html, /期权/);
  // The fixture has no live D1 calendar; the reminder is conditional on an event.
  assert.match(dashboard, /t\("即将到来的事件"\)/);
  assert.doesNotMatch(html, /未来一个月财报|earnings-calendar-panel/);
  assert.doesNotMatch(html, /class="market-tape"|aria-label="美股大盘"/);
  assert.doesNotMatch(dashboard, /MARKET_INDEXES|MARKET_INDEX_SYMBOLS|market-tape/);
  assert.match(dashboard, /const quoteSymbols = useMemo\(\(\) => positionGroups\.map/);
  assert.match(dashboard, /useMarketQuotes\(quoteSymbols\)/);
});

test("keeps the portfolio overview dense across desktop and tablet widths", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(css, /\.hero \{[^}]*min-height: 0;[^}]*grid-template-columns: minmax\(300px, \.75fr\) minmax\(0, 1\.25fr\);/s);
  assert.match(css, /\.summary-nav-value \{[^}]*font-size: clamp\(40px, 4vw, 50px\);/s);
  assert.match(css, /\.summary-support \{[^}]*grid-template-columns: repeat\(4, minmax\(110px, 1fr\)\);/s);

  const tabletCss = css.match(/@media \(max-width: 820px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(tabletCss, /\.hero \{ grid-template-columns: minmax\(230px, \.8fr\) minmax\(0, 1\.2fr\);/);

  const mobileCss = css.match(/@media \(max-width: 620px\) \{([\s\S]*)\}\s*$/)?.[1] ?? "";
  assert.match(mobileCss, /\.hero \{[^}]*grid-template-columns: 1fr;/s);
});

test("keeps every page inside a responsive device-safe edge", async () => {
  const [css, layout] = await Promise.all([
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(css, /--page-edge: clamp\(16px, 2vw, 32px\);/);
  assert.match(css, /body \{[^}]*padding-block-start: env\(safe-area-inset-top, 0px\);/s);
  assert.match(css, /body \{[^}]*padding-inline-end: max\(var\(--page-edge\), env\(safe-area-inset-right, 0px\)\);/s);
  assert.match(css, /body \{[^}]*padding-block-end: max\(var\(--page-edge\), env\(safe-area-inset-bottom, 0px\)\);/s);
  assert.match(css, /body \{[^}]*padding-inline-start: max\(var\(--page-edge\), env\(safe-area-inset-left, 0px\)\);/s);
  assert.match(layout, /viewportFit: "cover"/);
});

test("keeps both allocation charts visible in a responsive grid", async () => {
  const [dashboard, css] = await Promise.all([
    readDashboardSource(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(dashboard, /className="allocation-comparison"/);
  assert.match(dashboard, /className="allocation-mode-panel" aria-labelledby="holding-allocation-title"/);
  assert.match(dashboard, /className="allocation-mode-panel" aria-labelledby="sector-allocation-title"/);
  assert.match(css, /\.allocation-comparison \{[^}]*display: grid;[^}]*grid-template-columns: repeat\(auto-fit,/s);
  assert.match(css, /\.allocation-mode-panel \{[^}]*min-width: 0;[^}]*display: grid;[^}]*grid-template-rows: auto 1fr;/s);
  assert.match(css, /\.allocation-mode-panel > \.allocation-wrap \{[^}]*height: 100%;[^}]*align-items: center;/s);
});

test("places allocation after holding plans in the full-width ledger tabs", async () => {
  const [dashboard, css] = await Promise.all([
    readDashboardSource(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(dashboard, /<TabsTrigger value="plans">[\s\S]*?<TabsTrigger value="allocation">/);
  assert.match(dashboard, /<TabsContent value="allocation"[^>]*>[\s\S]*?<AllocationPanel[\s\S]*?<PortfolioHeatmap[\s\S]*?<\/TabsContent>/);
  assert.doesNotMatch(dashboard, /analysisExpanded|portfolio-analysis-toggle|<aside/);
  assert.match(css, /\.lower-grid \{[^}]*grid-template-columns: minmax\(0, 1fr\);/s);
});

test("fetches homepage and independent detail quotes without modal state", async () => {
  const [dashboard, detail] = await Promise.all([
    readDashboardSource(),
    readFile(new URL("../app/positions/[ticker]/StockDetail.tsx", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(dashboard, /selectedPosition|PositionDetailDialog/);
  assert.match(detail, /useMarketQuotes\(ticker\)/);
});

test("public quote endpoint validates input before fetching", async () => {
  const response = await render("/api/quotes?symbols=$BAD");
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Ticker 参数无效。" });
});

test("exposes uncached shared plan reads for the independent detail page", async () => {
  const route = await readFile(new URL("../app/api/plans/[ticker]/route.ts", import.meta.url), "utf8");

  assert.match(route, /export async function GET/);
  assert.match(route, /getHoldingPlan/);
  assert.match(route, /return Response\.json\(\{ plan \},/);
});

test("uses page-scrolling cards for mobile position details", async () => {
  const [detailPage, detailContent, css] = await Promise.all([
    readFile(new URL("../app/positions/[ticker]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/positions/[ticker]/PositionHoldings.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(detailPage, /StockDetail/);
  assert.match(detailContent, /id="position-structure"/);
  assert.match(detailContent, /data-label=\{t\("平均成本"\)\}/);
  assert.match(detailContent, /data-label=\{t\("未实现盈亏"\)\}/);
  assert.doesNotMatch(detailContent, /持仓，可横向滚动|持仓明细，可横向滚动/);
  assert.match(css, /\.position-detail\.table-wrap \{\s*overflow: visible;\s*overscroll-behavior: auto;/);
  assert.match(css, /\.instrument-table thead \{ display: none; \}/);
  assert.match(css, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.position-identity\s*\{[^}]*grid-column: 1 \/ -1;/);
});

test("keeps the add-plan dialog content-sized with useful idle and loading states", async () => {
  const [dialog, css] = await Promise.all([
    readFile(new URL("../app/AddPlanDialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(css, /\.plan-dialog \{[^]*?position: fixed;[^]*?inset: 50% auto auto 50%;[^]*?transform: translate\(-50%, -50%\);/);
  assert.doesNotMatch(dialog, /NEW INVESTMENT PLAN|New investment plan/);
  assert.match(dialog, /<Empty>/);
  assert.match(dialog, /<Skeleton key=/);
  assert.match(dialog, /setLoading\(Boolean\(value.trim\(\)\)\)/);
  assert.match(dialog, /<Dialog open=\{isOpen\} onOpenChange=\{changeOpen\}/);
  assert.match(dialog, /没有找到匹配的标的/);
  assert.doesNotMatch(css, /\.search-results \{[^}]*min-height:/s);
});

test("calculates actual holding cost from cost, realized P&L, and quantity", () => {
  const fixtures = [
    { label: "large position", cost: 21067.4311002, realized: 1.063786, quantity: 180, expected: 117.04 },
    { label: "realized loss", cost: 5838.87880005, realized: -44.802037, quantity: 15, expected: 392.25 },
    { label: "realized gain", cost: 3903.89579991, realized: 264.609827, quantity: 27, expected: 134.79 },
    { label: "diluted cost", cost: 1222.83379995, realized: 725.296967, quantity: 15, expected: 33.17 },
  ];

  for (const fixture of fixtures) {
    const actual = (fixture.cost - fixture.realized) / fixture.quantity;
    assert.equal(Number(actual.toFixed(2)), fixture.expected, fixture.label);
  }
});
