import puppeteer, { type Browser, type BrowserWorker, type Frame, type Page } from "@cloudflare/puppeteer";
import axeSource from "axe-core/axe.min.js";
import { anthropicConfigured, AnthropicUnavailable, judge, type ImageInput } from "./anthropic.ts";
import { issueKey, type TrackedIssue } from "./document.ts";

/**
 * The visual review (docs/analysis-html-artifact.md §7): the draft is opened in the real company page through a signed
 * preview link, at several widths and both themes, inside the same `/artifact-frame` sandbox readers get. Programmatic
 * checks find what can be measured; the interactive components are exercised; screenshots go to Claude Haiku 5.5 for
 * the design review. Every finding names a block, so the composer fixes only that block.
 */
/** `parts`: how many screenshots a tall block may take at this width, each `SLICE` pixels at most. */
export type Viewport = { name: string; width: number; height: number; dark: boolean; mobile?: boolean; parts: number };
export const VIEWPORTS: Viewport[] = [
  { name: "1440x900 light", width: 1440, height: 900, dark: false, parts: 3 },
  { name: "390x844 light", width: 390, height: 844, dark: false, mobile: true, parts: 3 },
  { name: "1280x800 dark", width: 1280, height: 800, dark: true, parts: 1 },
];
/** A block is shot whole, in parts no taller than this: no screenshot edge falls inside a block shorter than it. */
const SLICE = 1500;
/**
 * Runs in the page: brings a point `offset` pixels down the artifact frame to the top of what scrolls it, and returns
 * where the frame then stands in the window and where the visible part of the report ends.
 */
const SCROLL_TO = `(offset) => {
  var frame = document.querySelector("iframe[data-artifact-frame]");
  var box = frame.parentElement;
  while (box && box !== document.body) { var cs = getComputedStyle(box); if (/(auto|scroll)/.test(cs.overflowY) && box.scrollHeight > box.clientHeight + 4) break; box = box.parentElement; }
  var scroller = box && box !== document.body ? box : null;
  var before = frame.getBoundingClientRect();
  if (scroller) { var edge = scroller.getBoundingClientRect().top; scroller.scrollTop += before.top + offset - edge; }
  else window.scrollBy(0, before.top + offset);
  var r = frame.getBoundingClientRect();
  var bottom = scroller ? Math.min(window.innerHeight, scroller.getBoundingClientRect().bottom) : window.innerHeight;
  return { left: r.left, top: r.top, bottom: bottom };
}`;
/** The most screenshots one design review reads; every width covers every block before a second part of any is taken. */
const MAX_IMAGES = 24;
export type QaResult = {
  issues: TrackedIssue[];
  scores: Record<string, number> | null;
  /** The review could not run (no browser, or the page never drew); the caller settles with the safe layout. */
  unavailable: string | null;
  shots: number;
  /** The blocks the design review saw, by width. */
  covered?: Record<string, string[]>;
  /** Widths that could not be looked at while others could: the page's fault or the browser's, not a block's. */
  errors?: string[];
};
type Measured = { stageWidth: number; blocks: Array<{ id: string; x: number; y: number; width: number; height: number }>; problems: Array<{ block: string; severity: "blocker" | "major" | "minor"; kind: "render" | "interaction"; problem: string }> };

const LOAD_MS = 45_000;

/** Runs inside the artifact frame: geometry, colours from the theme, charts drawn, and the interactive components exercised. */
const MEASURE = `(async () => {
  var problems = [];
  var article = document.querySelector("article[data-artifact]");
  if (!article) return { stageWidth: 0, blocks: [], problems: [{ block: "*", severity: "blocker", kind: "render", problem: "the artifact did not render" }] };
  var W = document.documentElement.clientWidth;
  var blockOf = function (el) { var s = el.closest("section[data-block]"); return s ? s.getAttribute("data-block") : "*"; };
  var push = function (el, severity, kind, problem) { problems.push({ block: blockOf(el), severity: severity, kind: kind, problem: problem }); };
  var all = Array.prototype.slice.call(article.querySelectorAll("*"));
  // Horizontal overflow: anything reaching past the stage, outside a scroll container the components allow.
  all.forEach(function (el) {
    var r = el.getBoundingClientRect();
    if (r.width && r.right > W + 1 && !el.closest('[data-slot="table-container"],[data-slot="scroll-area"],[data-slot="carousel-content"],[data-slot="tabs-list"]')) push(el, "blocker", "render", "<" + el.tagName.toLowerCase() + "> reaches " + Math.round(r.right) + "px in a " + W + "px stage");
  });
  // Clipped text: content larger than a box that hides its overflow.
  all.forEach(function (el) {
    var cs = getComputedStyle(el);
    if ((cs.overflowX === "hidden" || cs.overflowX === "clip") && el.scrollWidth > el.clientWidth + 2 && el.textContent.trim()) push(el, "blocker", "render", "text is cut off in <" + el.tagName.toLowerCase() + "> (" + el.scrollWidth + "px of content in " + el.clientWidth + "px)");
    if ((cs.overflowY === "hidden" || cs.overflowY === "clip") && el.scrollHeight > el.clientHeight + 2 && el.textContent.trim() && !el.closest('[data-state="closed"]')) push(el, "major", "render", "content is cut off at the bottom of <" + el.tagName.toLowerCase() + ">");
  });
  // Overlapping text: two text boxes, neither inside the other, drawn over each other.
  var texts = all.filter(function (el) { return /^(P|LI|H2|H3|H4|TD|TH|DT|DD|FIGCAPTION|BLOCKQUOTE|SPAN|STRONG|DATA)$/.test(el.tagName) && el.textContent.trim() && el.getClientRects().length; }).slice(0, 400);
  // An inline element that wraps is judged by its line boxes: its bounding box covers the lines between, where other text rightly sits.
  var rects = texts.map(function (el) { return Array.prototype.slice.call(el.getClientRects()); });
  var bounds = texts.map(function (el) { return el.getBoundingClientRect(); });
  var crosses = function (a, b) { return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 4 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 4; };
  for (var i = 0; i < texts.length; i++) for (var j = i + 1; j < texts.length; j++) {
    if (texts[i].contains(texts[j]) || texts[j].contains(texts[i])) continue;
    if (!crosses(bounds[i], bounds[j])) continue;
    if (rects[i].some(function (a) { return rects[j].some(function (b) { return crosses(a, b); }); })) { push(texts[i], "blocker", "render", "\\"" + texts[i].textContent.trim().slice(0, 40) + "\\" overlaps \\"" + texts[j].textContent.trim().slice(0, 40) + "\\""); break; }
  }
  // Charts: every figure the harness filled has a drawn picture.
  Array.prototype.slice.call(article.querySelectorAll("figure[data-chart]")).forEach(function (f) { var svg = f.querySelector("svg"); var r = svg && svg.getBoundingClientRect(); if (!r || r.width < 40 || r.height < 40) push(f, "blocker", "render", "a chart did not draw"); });
  // Colours: every visible colour is a theme token (or a token at reduced opacity).
  var probe = document.createElement("span"); document.body.appendChild(probe);
  // The page's own custom properties are the theme: every one that resolves to a colour is allowed.
  var tokens = {}; var rootStyle = getComputedStyle(document.documentElement);
  for (var k = 0; k < rootStyle.length; k++) { var v = rootStyle[k]; if (v.indexOf("--") !== 0) continue; probe.style.color = ""; probe.style.color = "var(" + v + ")"; var c = getComputedStyle(probe).color.match(/\\d+(\\.\\d+)?/g); if (c) tokens[c.slice(0, 3).join(",")] = v; }
  probe.remove();
  var rgb = function (s) { var m = s.match(/\\d+(\\.\\d+)?/g); return m && (m.length < 4 || Number(m[3]) > 0.02) ? m.slice(0, 3).join(",") : null; };
  var off = {};
  all.slice(0, 1500).forEach(function (el) {
    var cs = getComputedStyle(el);
    [["color", cs.color], ["background", cs.backgroundColor], ["border", parseFloat(cs.borderTopWidth) > 0 ? cs.borderTopColor : ""]].forEach(function (p) {
      var c = p[1] && rgb(p[1]); if (c && !tokens[c] && !el.closest("svg") && !off[c]) { off[c] = 1; push(el, "major", "render", p[0] + " rgb(" + c + ") is not a theme colour"); }
    });
  });
  // Interactive components: each is operated the way a reader would, and must change state without hiding other content.
  var visible = function (el) { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
  Array.prototype.slice.call(article.querySelectorAll('[data-slot="tabs"]')).forEach(function (tabs) {
    Array.prototype.slice.call(tabs.querySelectorAll('[data-slot="tabs-trigger"]')).forEach(function (t) {
      t.click();
      var v = t.getAttribute("data-value"), panel = tabs.querySelector('[data-slot="tabs-content"][data-value="' + v + '"]');
      if (!panel || !visible(panel) || t.getAttribute("aria-selected") !== "true") push(t, "blocker", "interaction", "selecting the \\"" + t.textContent.trim().slice(0, 30) + "\\" tab does not show its panel");
    });
    var first = tabs.querySelector('[data-slot="tabs-trigger"]'); if (first) first.click();
  });
  Array.prototype.slice.call(article.querySelectorAll('[data-slot="accordion-trigger"],[data-slot="collapsible-trigger"]')).forEach(function (t) {
    var item = t.closest('[data-slot="accordion-item"],[data-slot="collapsible"]'); if (!item) return;
    var content = item.querySelector('[data-slot="accordion-content"],[data-slot="collapsible-content"]'); if (!content) return;
    var was = visible(content); t.click();
    if (visible(content) === was) push(t, "blocker", "interaction", "\\"" + t.textContent.trim().slice(0, 30) + "\\" does not open or close its content");
    t.click();
  });
  Array.prototype.slice.call(article.querySelectorAll('[data-slot="tooltip"],[data-slot="hover-card"]')).forEach(function (t) {
    t.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true })); t.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    var pop = document.querySelector("[data-artifact-popup]");
    var r = pop && pop.getBoundingClientRect();
    if (!pop || !visible(pop)) push(t, "blocker", "interaction", "the tooltip on \\"" + t.textContent.trim().slice(0, 30) + "\\" does not appear");
    else if (r.right > W + 1 || r.left < -1) push(t, "major", "interaction", "the tooltip on \\"" + t.textContent.trim().slice(0, 30) + "\\" runs outside the stage");
    t.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true })); t.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
  // Accessibility: contrast, headings and table structure.
  if (window.axe) {
    try {
      var result = await window.axe.run(article, { runOnly: ["color-contrast", "heading-order", "empty-heading", "th-has-data-cells", "td-headers-attr", "list", "listitem"] });
      result.violations.forEach(function (v) { (v.nodes || []).slice(0, 3).forEach(function (n) { var el = n.target && document.querySelector(n.target[0]); push(el || article, v.impact === "critical" || v.impact === "serious" ? "major" : "minor", "render", v.help); }); });
    } catch (e) {}
  }
  var blocks = Array.prototype.slice.call(article.querySelectorAll("section[data-block]")).map(function (s) { var r = s.getBoundingClientRect(); return { id: s.getAttribute("data-block"), x: r.left, y: r.top + window.scrollY, width: r.width, height: r.height }; });
  return { stageWidth: W, blocks: blocks, problems: problems.slice(0, 60) };
})()`;

async function openBrowser(binding: BrowserWorker): Promise<Browser> {
  const free = (await puppeteer.sessions(binding).catch(() => [])).filter(s => !s.connectionId);
  for (const s of free) { try { return await puppeteer.connect(binding, s.sessionId); } catch { /* taken meanwhile */ } }
  return puppeteer.launch(binding, { keep_alive: 120_000 });
}

async function artifactFrame(page: Page): Promise<{ frame: Frame; rect: { x: number; y: number; width: number; height: number } } | null> {
  // The frame is brought into view first: a browser paints an off-screen cross-origin frame late or not at all.
  await page.waitForSelector("iframe[data-artifact-frame]", { timeout: LOAD_MS });
  await page.$eval("iframe[data-artifact-frame]", el => el.scrollIntoView({ block: "start" }));
  await page.waitForSelector("iframe[data-artifact-frame][data-rendered]", { timeout: LOAD_MS });
  const rect = await page.$eval("iframe[data-artifact-frame][data-rendered]", el => { const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; });
  const frame = page.frames().find(f => f.url().includes("/artifact-frame"));
  return frame ? { frame, rect } : null;
}

type Pass = { viewport: Viewport; measured: Measured; frameRect: { x: number; y: number; width: number; height: number }; shots: Array<{ block: string; part: number; height: number; image: ImageInput }> };

async function renderPass(browser: Browser, url: string, viewport: Viewport, errors: string[]): Promise<Pass> {
  const page = await browser.newPage();
  page.on("pageerror", (e: unknown) => errors.push(`${viewport.name}: script error ${e instanceof Error ? e.message : String(e)}`.slice(0, 200)));
  try {
    await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1, isMobile: !!viewport.mobile, hasTouch: !!viewport.mobile });
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: viewport.dark ? "dark" : "light" }]);
    await page.evaluateOnNewDocument(`try { localStorage.setItem("business-map-theme", ${JSON.stringify(viewport.dark ? "dark" : "light")}); } catch (e) {}`);
    // The drawn frame is what the review waits for; other parts of the page may keep loading (pictures, scripts).
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: LOAD_MS });
    const found = await artifactFrame(page).catch(async (error: unknown) => {
      // What the page showed instead, so a frame that never drew says why.
      const seen = await page.evaluate(`(() => ({ lens: !!document.querySelector("section.lens"), frames: document.querySelectorAll("iframe[data-artifact-frame]").length, rendered: document.querySelectorAll("iframe[data-artifact-frame][data-rendered]").length, path: location.pathname + location.search.replace(/artifact-preview=[^&]+/, "artifact-preview=…"), text: (document.body.innerText || "").replace(/\\s+/g, " ").slice(0, 160) }))()`).catch(() => null);
      console.log(JSON.stringify({ event: "artifact-qa-page", viewport: viewport.name, url, seen, errors: errors.slice(-3) }));
      throw new Error(`${error instanceof Error ? error.message.slice(0, 80) : String(error)}; page: ${JSON.stringify(seen)}`);
    });
    if (!found) throw new Error("the artifact frame never drew");
    await found.frame.evaluate(axeSource).catch(() => undefined);
    const measured = await found.frame.evaluate(MEASURE) as Measured;
    const shots: Pass["shots"] = [];
    // Every block is shot by itself (§4.7), so the review sees each one whole and names the one it is looking at.
    const slice = Math.min(SLICE, viewport.height - 80);
    for (const b of measured.blocks) for (let k = 0; k < viewport.parts; k++) {
      const top = b.y + k * slice;
      if (b.width < 8 || top >= b.y + b.height - 8) break;
      // The part is scrolled to the top of whatever scrolls the report (the stage's own column, or the window), and
      // shot where it then stands on screen: only what is on screen has been painted.
      const at = await page.evaluate(`(${SCROLL_TO})(${Math.round(top)})`) as { left: number; top: number; bottom: number };
      await new Promise(resolve => setTimeout(resolve, 150));
      const y = Math.max(0, at.top + top), height = Math.min(slice, b.y + b.height - top, at.bottom - y);
      if (height < 24) break;
      const data = await page.screenshot({ type: "jpeg", quality: 65, encoding: "base64", clip: { x: at.left + b.x, y, width: b.width, height } }) as string;
      shots.push({ block: b.id, part: k + 1, height, image: { mediaType: "image/jpeg", base64: data } });
    }
    return { viewport, measured, frameRect: found.rect, shots };
  } finally { await page.close().catch(() => undefined); }
}

const VISUAL_SYSTEM = `You are the design reviewer of an equity research platform. You see screenshots of one research report as readers see it, rendered at several widths: each screenshot is one section (block) of the report at one width, or one part of a tall section, and the map names the block and width of every screenshot. Judge the design only, never the investment view or the figures.
The house style: a research report, not a dashboard. Sections are separated by headings, body text, thin rules and space; data is shown with tables, charts, tabs and other components wherever they make the point clearer. Avoid piles of rounded, bordered boxes, decorative badges, gradients and large colour fills; the highlight colour and gain/loss colours are used sparingly.
Score each dimension from 0 to 10: layout (grid, alignment, white space, balance), hierarchy (headings, key figures and charts read in the right order), density (neither cramped nor wasteful), consistency (house style: components serve the content, few bordered boxes, restrained colour), readability (type size, line length, contrast).
List concrete problems, each tied to the block id of the screenshot where it appears, with a fix that can be made with the report's components and classes, such as "show these four figures as one two-column table" or "drop the border around these paragraphs". Do not report a problem you cannot point to.`;
const VISUAL_SCHEMA = {
  type: "object", additionalProperties: false, required: ["scores", "issues"],
  properties: {
    scores: { type: "object", additionalProperties: false, required: ["layout", "hierarchy", "density", "consistency", "readability"], properties: Object.fromEntries(["layout", "hierarchy", "density", "consistency", "readability"].map(k => [k, { type: "number" }])) },
    issues: { type: "array", items: { type: "object", additionalProperties: false, required: ["block", "severity", "viewport", "problem", "suggestion"], properties: {
      block: { type: "string" }, severity: { type: "string", enum: ["major", "minor"] }, viewport: { type: "string" }, problem: { type: "string" }, suggestion: { type: "string" } } } },
  },
};
const WEIGHTS: Record<string, number> = { layout: 0.25, hierarchy: 0.25, density: 0.2, consistency: 0.15, readability: 0.15 };
/** Initial pass mark (§7.4): weighted 80, every dimension at least 7. */
export const visualPasses = (scores: Record<string, number> | null) => !!scores && Object.entries(WEIGHTS).reduce((sum, [k, w]) => sum + (scores[k] ?? 0) * 10 * w, 0) >= 80 && Object.keys(WEIGHTS).every(k => (scores[k] ?? 0) >= 7);

/**
 * One review of a draft. `url` opens it in the real stage; `blocks` are the ids the review may name. The design review
 * is skipped, not failed, when Anthropic is not configured; the result says so through `scores: null`.
 */
export async function reviewRendering(env: { BROWSER?: BrowserWorker; ANTHROPIC_API_KEY?: string; DB?: D1Database }, url: string, blocks: readonly string[], ledger: { ticker: string; runId?: string }): Promise<QaResult> {
  if (!env.BROWSER) return { issues: [], scores: null, unavailable: "no browser binding", shots: 0 };
  const errors: string[] = [];
  let browser: Browser;
  try { browser = await openBrowser(env.BROWSER); } catch (error) { return { issues: [], scores: null, unavailable: `browser: ${error instanceof Error ? error.message : String(error)}`, shots: 0 }; }
  const passes: Pass[] = [];
  try {
    for (const viewport of VIEWPORTS) {
      // The stage reloads its frame when the company's data moves under it; a width that lost its frame is tried once more.
      for (let attempt = 0; attempt < 2; attempt++) {
        try { passes.push(await renderPass(browser, url, viewport, errors)); break; }
        catch (error) {
          if (attempt === 0) { await new Promise(resolve => setTimeout(resolve, 2500)); continue; }
          errors.push(`${viewport.name}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
        }
      }
    }
  } finally { browser.disconnect(); }
  if (!passes.length) return { issues: [], scores: null, unavailable: errors.join("; ").slice(0, 1500) || "the page never drew", shots: 0 };
  const known = new Set(blocks);
  const issues: TrackedIssue[] = [];
  const seen = new Set<string>();
  for (const pass of passes) for (const p of pass.measured.problems) {
    const block = known.has(p.block) ? p.block : blocks[0] ?? "*";
    const key = issueKey(block, `${p.kind} ${p.problem}`);
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({ block, kind: p.kind, severity: p.severity, problem: p.problem, viewport: pass.viewport.name, key });
  }
  // A width that never drew is on record but is held against no block: what was seen at the other widths is what is judged.
  let scores: Record<string, number> | null = null;
  // First parts before second parts, so every width shows every block before the limit is reached.
  const images = passes.flatMap((p, order) => p.shots.map(s => ({ ...s, viewport: p.viewport.name, order }))).sort((a, b) => a.part - b.part || a.order - b.order).slice(0, MAX_IMAGES);
  if (anthropicConfigured(env) && images.length) {
    const map = images.map((s, i) => ({ screenshot: i + 1, viewport: s.viewport, block: s.block, part: s.part, height: Math.round(s.height) }));
    try {
      const verdict = await judge<{ scores: Record<string, number>; issues: Array<{ block: string; severity: "major" | "minor"; viewport: string; problem: string; suggestion: string }> }>(env, {
        stage: "artifact-visual", system: VISUAL_SYSTEM, schema: VISUAL_SCHEMA, effort: "medium", images: images.map(s => s.image),
        text: JSON.stringify({ blockMap: map, measuredProblems: issues.slice(0, 20).map(i => ({ block: i.block, problem: i.problem })) }),
        ledger: { kind: "artifact-visual", ticker: ledger.ticker, ...(ledger.runId ? { runId: ledger.runId } : {}) },
      });
      scores = verdict.scores;
      for (const v of verdict.issues.slice(0, 16)) {
        const block = known.has(v.block) ? v.block : null;
        if (!block) continue;
        issues.push({ block, kind: "visual", severity: v.severity, problem: v.problem, suggestion: v.suggestion, viewport: v.viewport, key: issueKey(block, `visual ${v.problem}`) });
      }
    } catch (error) {
      if (!(error instanceof AnthropicUnavailable)) throw error;
    }
  }
  return { issues, scores, unavailable: null, shots: images.length, covered: Object.fromEntries(passes.map(p => [p.viewport.name, [...new Set(images.filter(s => s.viewport === p.viewport.name).map(s => s.block))]])), ...(errors.length ? { errors } : {}) };
}
