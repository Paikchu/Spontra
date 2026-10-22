import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PICTURE_BASE_CSS, PICTURE_CSP, PICTURE_PREVIEW_THEME } from "../../../shared/analysis-runtime/lens/picture.ts";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("the picture frame, its policy and the harness's browser draw on the same document", async () => {
  const [frame, headers, style] = await Promise.all([read("../public/html-frame.html"), read("../public/_headers"), read("../src/style.css")]);
  assert.ok(frame.includes(JSON.stringify(PICTURE_BASE_CSS)), "html-frame.html carries PICTURE_BASE_CSS verbatim");
  const policies = [...headers.matchAll(/^\/html-frame(?:\.html)?\n(?:.*\n)*?\s+Content-Security-Policy: (.+)$/gm)].map(m => m[1]);
  assert.equal(policies.length, 2);
  for (const policy of policies) assert.equal(policy, PICTURE_CSP);
  // The dark theme the harness measures in is the page's own :root.
  const root = style.match(/:root \{([\s\S]*?)\n\}/)![1]!;
  for (const [token, value] of Object.entries(PICTURE_PREVIEW_THEME.tokens)) {
    const declared = root.match(new RegExp(`^\\s*${token}:\\s*(.+);$`, "m"))?.[1];
    assert.equal(declared, value, token);
  }
});
