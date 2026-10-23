import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { openingFace } from "../src/opening-face.ts";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("the company page stays on its skeleton until the opening read settles", () => {
  assert.equal(openingFace({ ready: false, failed: false, flow: false, publication: false }), "loading");
  assert.equal(openingFace({ ready: false, failed: true, flow: false, publication: false }), "failed");
  assert.equal(openingFace({ ready: true, failed: false, flow: true, publication: true }), "map");
  assert.equal(openingFace({ ready: true, failed: true, flow: true, publication: true }), "map");
  assert.equal(openingFace({ ready: true, failed: false, flow: false, publication: true }), "state");
  assert.equal(openingFace({ ready: true, failed: true, flow: false, publication: false }), "failed");
  assert.equal(openingFace({ ready: true, failed: false, flow: false, publication: false }), "loading");
});

test("the first paint is one crossfade of a fitted chart, not a clipped skeleton", async () => {
  const [flow, main, style] = await Promise.all([read("../src/FlowChart.tsx"), read("../src/main.tsx"), read("../src/style.css")]);
  assert.equal(flow.includes('attributeName="width"'), false);
  const keyed = main.match(/Fragment key=\{locale\}/g) ?? [];
  assert.equal(keyed.length, 1);
  assert.match(main, /if \(!ticker\)\s*return <Fragment key=\{locale\}>/);
  assert.match(main, /<Company key=\{ticker\}/);
  assert.equal(style.includes(".map--loading .stage { grid-template-rows: minmax(240px, 1fr); }"), false);
  assert.match(style, /::view-transition-new\(company-map\) \{ animation: \.42s var\(--ease\) both fade-in; \}/);
  assert.match(style, /::view-transition-new\(stage-chart\) \{ animation: \.32s var\(--ease\) both fade-in; \}/);
});
