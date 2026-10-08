import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarProvider } from "../components/ui/sidebar";
import { ChartContainer, ChartTooltipContent } from "../components/ui/chart";
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "../components/ui/native-select";
import { Rail, RailActions } from "../apps/business-site/src/Sidebar";
import { Home } from "../apps/business-site/src/Home";

// These composition paths must keep the existing DOM skin, rather than introduce
// wrappers, default labels or platform-menu replacements into the business map.
test("the composed sidebar retains its semantic shell, scroll target and Chinese action labels", () => {
  const html = renderToStaticMarkup(
    <SidebarProvider asChild open={false} keyboardShortcut={null} persistState={false}>
      <main data-rail="collapsed">
        <Rail ticker="ORCL" label="公司业务" actions={<RailActions light={false} collapsed onSearch={() => {}} onToggleTheme={() => {}} />}>
          <div className="rail-list">全部业务</div>
        </Rail>
      </main>
    </SidebarProvider>,
  );
  assert.match(html, /<main[^>]*data-rail="collapsed"/);
  assert.match(html, /<aside[^>]*class="rail"[^>]*aria-label="公司业务"/);
  assert.match(html, /id="rail-body"/);
  assert.match(html, /aria-controls="rail-body"/);
  assert.equal((html.match(/<button\b/g) ?? []).length, 3);
  assert.equal((html.match(/<svg\b/g) ?? []).length, 4);
  assert.match(html, /<a href="\/" data-nav="true" class="icon-button" aria-label="首页"/);
  for (const name of ["首页", "搜索公司", "切换浅色主题", "展开侧边栏"]) assert.ok(html.includes(`aria-label="${name}"`));
  assert.ok(!html.includes("Toggle Sidebar"));
  assert.ok(!html.includes('data-slot="sidebar-gap"'));
  assert.ok(!html.includes('data-slot="sheet"'));
});

test("native quarterly selection keeps the selected report, group and disabled unavailable periods", () => {
  const html = renderToStaticMarkup(
    <label className="report-select"><span>财报季度</span>
      <NativeSelect appearance="native" value="current" onChange={() => {}}>
        <NativeSelectOptGroup label="近两年 · 季度报告">
          <NativeSelectOption value="current">2026.08</NativeSelectOption>
          <NativeSelectOption value="previous">2026.05</NativeSelectOption>
          <NativeSelectOption value="missing" disabled>2026.02 · 完整报告暂不可用</NativeSelectOption>
        </NativeSelectOptGroup>
      </NativeSelect>
    </label>,
  );
  assert.match(html, /<option[^>]*value="current"[^>]*selected=""/);
  assert.match(html, /<option[^>]*value="missing"[^>]*disabled=""/);
  assert.match(html, /<optgroup[^>]*label="近两年 · 季度报告"/);
  assert.ok(html.includes("完整报告暂不可用"));
  assert.equal((html.match(/<select\b/g) ?? []).length, 1);
  assert.ok(!html.includes("native-select-wrapper"));
  assert.ok(!html.includes("native-select-icon"));
});

test("custom chart composition preserves rich disclosed tooltip content without responsive wrappers", () => {
  const html = renderToStaticMarkup(
    <ChartContainer asChild config={{ cloud: { label: "云服务", color: "var(--biz-1)" } }}>
      <section className="trend" aria-label="全部业务 近 8 季收入">
        <div className="trend-plot"><div className="trend-col">
          <ChartTooltipContent asChild>
            <div className="trend-tip" role="presentation">
              <div className="trend-tip-title">2026-06-01 — 2026-08-31</div>
              <div className="trend-tip-row"><span>云服务</span><b>$11.6B</b></div>
              <p className="trend-tip-source">SEC 10-Q · 2026-09-11</p>
            </div>
          </ChartTooltipContent>
        </div></div>
      </section>
    </ChartContainer>,
  );
  assert.match(html, /^<section[^>]*class="trend"/);
  for (const content of ["2026-06-01 — 2026-08-31", "云服务", "$11.6B", "SEC 10-Q · 2026-09-11"]) assert.ok(html.includes(content));
  assert.equal((html.match(/class="trend-tip"/g) ?? []).length, 1);
  assert.ok(!html.includes("recharts-responsive-container"));
  assert.ok(!html.includes("aspect-video"));
});

test("home leads with the inline ticker search and keeps its list closed until the user types", () => {
  const html = renderToStaticMarkup(<Home light onToggleTheme={() => {}} recent={["NVDA"]} onPick={() => {}} />);
  assert.match(html, /<main class="home"/);
  assert.match(html, /class="search-panel" data-inline="true"/);
  assert.match(html, /role="combobox"[^>]*aria-expanded="false"/);
  assert.match(html, /<div class="search-drop" hidden="">/);
  assert.match(html, /<a href="\/companies\/NVDA" data-nav="true">/);
  assert.match(html, /<section class="home-findings"[^>]*aria-busy="true"/);
});
