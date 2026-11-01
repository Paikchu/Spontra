import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale } from "../../../packages/web/src/i18n/core.ts";
import { SeverityIcon } from "../src/SeverityIcon.tsx";

const render = (severity: 1 | 2 | 3) => renderToStaticMarkup(h(SeverityIcon, { severity }));

test("each severity is an icon named for screen readers and tooltips, with no digit or word on screen", () => {
  for (const [locale, names] of [
    ["en", { 3: "Severity: Major (highest of 3)", 2: "Severity: Watch", 1: "Severity: Note" }],
    ["zh-CN", { 3: "严重度：重要（3 级里最高）", 2: "严重度：留意", 1: "严重度：提示" }],
  ] as const) {
    setLocale(locale);
    for (const severity of [1, 2, 3] as const) {
      const html = render(severity);
      assert.match(html, /^<svg [^>]*role="img"/);
      assert.ok(html.includes(`aria-label="${names[severity]}"`), html);
      assert.ok(html.includes(`<title>${names[severity]}</title>`), html);
      assert.doesNotMatch(html, /aria-hidden/);
      // Nothing but the title is text: no bare digit, no visible level word.
      assert.equal(html.replace(/<title>.*?<\/title>/, "").replace(/<[^>]+>/g, ""), "");
    }
  }
  setLocale("en");
});

test("the three levels draw three different shapes", () => {
  const shapes = ([1, 2, 3] as const).map(s => render(s).replace(/<title>.*?<\/title>|aria-label="[^"]*"|data-severity="\d"/g, ""));
  assert.equal(new Set(shapes).size, 3);
  assert.match(render(3), /severity-icon-fill/);
});
