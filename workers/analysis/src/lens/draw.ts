import puppeteer, { type Browser, type BrowserWorker } from "@cloudflare/puppeteer";
import type { LensPictureRender } from "../../../../shared/analysis-contract/lens.ts";
import { pictureDocument } from "../../../../shared/analysis-runtime/lens/picture.ts";

/** Draws one html picture at one width and reports what a reader would see. */
export type PictureRenderer = (html: string, width: number) => Promise<LensPictureRender>;

/** How long a picture may take to load its scripts and settle before it is measured. */
const LOAD_MS = 15_000, SETTLE_MS = 600;
/** A browser stays open after a run so the next one does not pay a browser start. */
const KEEP_ALIVE_MS = 120_000;

/** Pages drawn at once: a findings run lays out several findings together, and the account has few browsers. */
const PAGES_AT_ONCE = 3;

/**
 * The harness's eyes, on Cloudflare Browser Rendering: each picture is loaded in the frame's own document (same
 * tokens, same policy), with motion reduced so it is measured at rest, and the page reports its own geometry. One
 * browser serves a whole run, a few pages at a time; a failure is a `failed` render, never a thrown error, so the
 * agent's turn goes on.
 */
export function browserRenderer(binding: BrowserWorker): PictureRenderer {
  let browser: Promise<Browser> | null = null;
  let active = 0;
  const waiting: Array<() => void> = [];
  const slot = async () => { if (active >= PAGES_AT_ONCE) await new Promise<void>(r => waiting.push(r)); active++; };
  const release = () => { active--; waiting.shift()?.(); };
  const connected = async () => {
    const current = browser ? await browser.catch(() => null) : null;
    if (current?.isConnected()) return current;
    browser = open(binding);
    return browser;
  };
  return async (html, width) => {
    await slot();
    try {
      const page = await (await connected()).newPage();
      const errors: string[] = [];
      page.on("pageerror", (e: unknown) => errors.push(`script error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200)));
      page.on("console", m => { if (m.type() === "error") errors.push(`console error: ${m.text()}`.slice(0, 200)); });
      page.on("requestfailed", r => errors.push(`could not load ${r.url().slice(0, 120)}`));
      try {
        await page.setViewport({ width, height: Math.round(width * 1.2), deviceScaleFactor: 1 });
        await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
        await page.setContent(pictureDocument(html), { waitUntil: "networkidle0", timeout: LOAD_MS });
        await new Promise(r => setTimeout(r, SETTLE_MS));
        const seen = await page.evaluate(MEASURE_PICTURE) as { height: number; problems: string[]; notes: string[] };
        return { width, height: seen.height, problems: [...new Set(errors)].slice(0, 6).concat(seen.problems), notes: seen.notes };
      } finally { await page.close().catch(() => {}); }
    } catch (error) {
      return { width, failed: (error instanceof Error ? error.message : String(error)).slice(0, 200) };
    } finally { release(); }
  };
}

/** A free open session when there is one, else a new browser that stays warm for the next run. */
async function open(binding: BrowserWorker): Promise<Browser> {
  const free = (await puppeteer.sessions(binding).catch(() => [])).filter(s => !s.connectionId);
  for (const s of free) { try { return await puppeteer.connect(binding, s.sessionId); } catch { /* taken meanwhile; try the next */ } }
  return puppeteer.launch(binding, { keep_alive: KEEP_ALIVE_MS });
}

/**
 * Runs inside the picture's page: the content's height, and what overlaps or overflows. A source string rather than a
 * function, because the bundler's helpers (`__name`) would travel with a function into a page that lacks them. Text
 * boxes come from ranges over text nodes, marks are solid SVG shapes; a label wholly inside a mark is deliberate, a
 * label partly across one is a collision.
 */
export const MEASURE_PICTURE = `(() => {
  var problems = [], notes = [];
  var W = document.documentElement.clientWidth;
  var height = Math.ceil(Math.max(document.body.scrollHeight, document.body.getBoundingClientRect().height));
  // The frame hides overflow, so the scroll width says nothing: the widest drawn element does.
  var wide = Array.prototype.slice.call(document.body.querySelectorAll("svg, canvas, img, table, div, p")).reduce(function (w, el) { return Math.max(w, Math.ceil(el.getBoundingClientRect().right)); }, document.documentElement.scrollWidth);
  if (wide > W + 1) problems.push("content is " + wide + "px wide in a " + W + "px frame; the overflow is cut off");
  function area(b) { return Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top); }
  function meet(a, b) { return { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) }; }
  function shown(el) { var s = getComputedStyle(el); return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) > 0.05; }
  function box(r) { return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; }
  var texts = [];
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (var node = walker.nextNode(); node; node = walker.nextNode()) {
    var text = (node.textContent || "").trim(), el = node.parentElement;
    if (!text || !el || ["SCRIPT", "STYLE", "TITLE"].indexOf(el.tagName) >= 0 || el.closest("title, desc, defs") || !shown(el)) continue;
    var range = document.createRange(); range.selectNodeContents(node);
    var r = range.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    texts.push({ text: text.slice(0, 32), box: box(r), size: parseFloat(getComputedStyle(el).fontSize) || 0, label: !!el.closest("svg") });
  }
  var collide = [];
  for (var i = 0; i < texts.length; i++) for (var j = i + 1; j < texts.length; j++) {
    var a = texts[i], b = texts[j];
    if (area(meet(a.box, b.box)) > 0.2 * Math.min(area(a.box), area(b.box))) { collide.push('"' + a.text + '" overlaps "' + b.text + '"'); continue; }
    // Two chart labels on one line with no gap read as one word ("Sep 24Dec 24"); flowing text is split by inline tags and is left alone.
    if (!a.label || !b.label) continue;
    var rows = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top), gap = Math.max(a.box.left, b.box.left) - Math.min(a.box.right, b.box.right);
    if (rows > 0.5 * Math.min(a.box.bottom - a.box.top, b.box.bottom - b.box.top) && gap < 3) collide.push('"' + a.text + '" and "' + b.text + '" touch with no space between them');
  }
  var marks = Array.prototype.slice.call(document.querySelectorAll("svg rect, svg path, svg circle, svg ellipse, svg polygon")).filter(function (el) {
    var s = getComputedStyle(el);
    // Solid marks only: a label over a faint area or band fill still reads.
    return shown(el) && s.fill !== "none" && !/rgba\\([^)]*,\\s*0(\\.[0-5]\\d*)?\\)$/.test(s.fill) && Number(s.fillOpacity) * Number(s.opacity) >= 0.6;
  }).map(function (el) { return box(el.getBoundingClientRect()); }).filter(function (m) { return area(m) > 0 && area(m) < 0.5 * W * Math.max(1, height); });
  var across = [];
  texts.forEach(function (t) {
    var own = area(t.box);
    if (marks.some(function (m) { var shared = area(meet(t.box, m)); return shared > 0.25 * own && shared < 0.95 * own; })) across.push('"' + t.text + '" sits partly across a mark');
  });
  // A tight line height lifts a glyph box a little above the top; a part of the font size is slack, not overflow.
  var outside = texts.filter(function (t) { var slack = Math.max(2, 0.3 * t.size); return t.box.left < -slack || t.box.right > W + slack || t.box.top < -slack; }).map(function (t) { return '"' + t.text + '" runs past the frame edge'; });
  problems = problems.concat(collide.slice(0, 8), across.slice(0, 8), outside.slice(0, 6));
  var small = texts.filter(function (t) { return t.size > 0 && t.size < 10.5; });
  if (small.length) notes.push(small.length + " text item" + (small.length === 1 ? "" : "s") + ' under 10.5px, e.g. "' + small[0].text + '"');
  if (!document.querySelector("svg, canvas") && texts.length < 3) problems.push("nothing drawn: no svg or canvas and almost no text");
  return { height: height, problems: problems, notes: notes };
})()`;
