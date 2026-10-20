import { test } from "node:test";
import assert from "node:assert/strict";
import { DirectPageProvider, type MarkdownConverter, type PageReadRecord } from "../src/web-search/page.ts";
import type { ContentData, ContentRequest, SearchProvider } from "../src/web-search/types.ts";

const ARTICLE = "Oracle Cloud Infrastructure revenue grew 55% in the quarter as customers moved training workloads onto its new regions. ".repeat(8);

/** A provider over scripted pages; the inner provider stands in for Claude's web_fetch and counts its reads. */
function setup(pages: Record<string, () => Response>, converter?: MarkdownConverter) {
  const requested: string[] = [], reads: PageReadRecord[] = [], fallbacks: ContentRequest[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requested.push(url);
    assert.equal(init?.redirect, "manual");
    return pages[url]?.() ?? new Response("not found", { status: 404 });
  }) as typeof fetch;
  const inner: SearchProvider = {
    id: "claude-web:v1",
    search: async () => ({ kind: "search", results: [] }),
    fetchContent: async (r): Promise<ContentData> => { fallbacks.push(r); return { kind: "content", url: r.url, text: "read by the fallback", format: "markdown", completeness: "unverified" }; },
  };
  const markdown = converter ?? { toMarkdown: async () => ({ format: "markdown", data: `# Q1\n\n${ARTICLE}` }) };
  return { provider: new DirectPageProvider(inner, { fetcher, markdown, record: r => { reads.push(r); } }), requested, reads, fallbacks };
}
const html = (body: string, status = 200, headers: Record<string, string> = {}) => () => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });

test("an HTML page is read in the Worker and converted to Markdown, never sent to the model", async () => {
  const converted: Array<{ name: string; hostname?: string }> = [];
  const { provider, fallbacks, reads } = setup({ "https://investor.example.com/q1": html(`<html><body><article>${ARTICLE}</article></body></html>`) },
    { toMarkdown: async (file, options) => { converted.push({ name: file.name, hostname: options?.conversionOptions?.html?.hostname }); return { format: "markdown", data: `# Q1\n\n${ARTICLE}` }; } });
  const page = await provider.fetchContent({ url: "https://investor.example.com/q1", depth: "advanced" });
  assert.match(page.text, /^# Q1/);
  assert.equal(fallbacks.length, 0);
  assert.deepEqual(converted, [{ name: "page.html", hostname: "https://investor.example.com/q1" }]);
  assert.equal(reads[0]!.outcome, "direct");
});

test("a page served as Markdown is taken as it is", async () => {
  let conversions = 0;
  const { provider, fallbacks } = setup({ "https://blog.example.com/post": () => new Response(`---\ntitle: Post\n---\n${ARTICLE}`, { headers: { "content-type": "text/markdown" } }) },
    { toMarkdown: async () => { conversions++; return { format: "markdown", data: "" }; } });
  const page = await provider.fetchContent({ url: "https://blog.example.com/post" });
  assert.match(page.text, /^---\ntitle: Post/);
  assert.equal(conversions, 0);
  assert.equal(fallbacks.length, 0);
});

test("redirects are followed only to public addresses", async () => {
  const moved = setup({
    "https://example.com/a": () => new Response(null, { status: 301, headers: { location: "/b" } }),
    "https://example.com/b": html(ARTICLE),
  });
  assert.match((await moved.provider.fetchContent({ url: "https://example.com/a" })).text, /Oracle Cloud/);
  assert.deepEqual(moved.requested, ["https://example.com/a", "https://example.com/b"]);

  const inward = setup({ "https://example.com/a": () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }) });
  assert.equal((await inward.provider.fetchContent({ url: "https://example.com/a" })).text, "read by the fallback");
  assert.deepEqual(inward.requested, ["https://example.com/a"], "the private address is never requested");
  assert.equal(inward.reads[0]!.reason, "redirect-not-public");
});

test("a refused, script-only, challenge or oversized page goes to the fallback with its reason", async () => {
  const cases: Array<[string, () => Response, string, MarkdownConverter?]> = [
    ["refused", html("Forbidden", 403), "http"],
    ["shell", html("<div id=root></div>"), "too-short", { toMarkdown: async () => ({ format: "markdown", data: "Loading…" }) }],
    ["challenge", html("x"), "blocked", { toMarkdown: async () => ({ format: "markdown", data: `Just a moment... Enable JavaScript and cookies to continue. ${"·".repeat(600)}` }) }],
    ["huge", html("x", 200, { "content-length": String(9 * 1024 * 1024) }), "too-large"],
    ["image", () => new Response("png", { headers: { "content-type": "image/png" } }), "unsupported-type"],
  ];
  for (const [name, page, reason, converter] of cases) {
    const { provider, fallbacks, reads } = setup({ [`https://example.com/${name}`]: page }, converter);
    assert.equal((await provider.fetchContent({ url: `https://example.com/${name}` })).text, "read by the fallback", name);
    assert.equal(fallbacks.length, 1, name);
    assert.deepEqual([reads[0]!.outcome, reads[0]!.reason], ["fallback", reason], name);
  }
});

test("page reads keep their own cache version, so the search cache stays valid", () => {
  const { provider } = setup({});
  assert.equal(provider.id, "claude-web:v1");
  assert.equal(provider.contentId, "direct-page:v1+claude-web:v1");
});
