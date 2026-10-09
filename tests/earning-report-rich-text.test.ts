import assert from "node:assert/strict";
import test from "node:test";

import { parseInline, parseRichText } from "../packages/web/src/model/rich-text.ts";

test("prose without markup keeps rendering one paragraph per line", () => {
  const blocks = parseRichText("第一段。\n第二段。\n\n第三段。");
  assert.deepEqual(blocks.map((block) => block.type), ["paragraph", "paragraph", "paragraph"]);
  assert.deepEqual(blocks.map((block) => block.type === "paragraph" ? block.inline : []), [
    [{ type: "text", value: "第一段。" }],
    [{ type: "text", value: "第二段。" }],
    [{ type: "text", value: "第三段。" }],
  ]);
});

test("bold applies inside Chinese prose, where CommonMark flanking rules would not", () => {
  assert.deepEqual(parseInline("云业务**同比 +18%**增长"), [
    { type: "text", value: "云业务" },
    { type: "strong", value: "同比 +18%" },
    { type: "text", value: "增长" },
  ]);
});

test("an unterminated marker stays literal, so prose truncated mid-`**` degrades to text", () => {
  assert.deepEqual(parseInline("毛利率承压 **持续"), [{ type: "text", value: "毛利率承压 **持续" }]);
});

test("one pass means a marker cannot be rewritten inside another one's span", () => {
  assert.deepEqual(parseInline("口径见 `non_gaap_eps **调整**` 一节"), [
    { type: "text", value: "口径见 " },
    { type: "code", value: "non_gaap_eps **调整**" },
    { type: "text", value: " 一节" },
  ]);
});

test("underscores and lone asterisks in filing prose are never emphasis", () => {
  assert.deepEqual(parseInline("non_gaap_eps 与脚注 * 均为字面量"), [
    { type: "text", value: "non_gaap_eps 与脚注 * 均为字面量" },
  ]);
});

test("list markers need trailing space, so a line opening in bold is still a paragraph", () => {
  const blocks = parseRichText("- 收入创新高\n- 利润率承压\n**指引**上调");
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], {
    type: "list",
    ordered: false,
    items: [[{ type: "text", value: "收入创新高" }], [{ type: "text", value: "利润率承压" }]],
  });
  assert.equal(blocks[1]!.type, "paragraph");
});

test("ordered lists stop at two digits, so a line opening with a year stays prose", () => {
  const blocks = parseRichText("1) 上调全年指引\n2026. 资本开支见顶");
  assert.equal(blocks[0]!.type, "list");
  assert.equal(blocks[1]!.type, "paragraph");
});

test("a switch of list style starts a new list rather than merging the two", () => {
  assert.deepEqual(parseRichText("- 甲\n1. 乙").map((block) => block.type), ["list", "list"]);
});

test("headings parse at the two depths the page styles", () => {
  assert.deepEqual(parseRichText("### 指引\n#### 口径").map((block) => block.type === "heading" ? block.level : null), [3, 4]);
});

test("only https and same-site links survive; anything else stays visible as its own text", () => {
  assert.deepEqual(parseInline("[EDGAR](https://sec.gov/x)"), [{ type: "link", value: "EDGAR", href: "https://sec.gov/x" }]);
  assert.deepEqual(parseInline("[本页](/stocks/MSFT)"), [{ type: "link", value: "本页", href: "/stocks/MSFT" }]);
  for (const hostile of ["javascript:alert(1)", "data:text/html,x", "http://sec.gov", "//evil.test"]) {
    const nodes = parseInline(`[点击](${hostile})`);
    assert.equal(nodes.every((node) => node.type === "text"), true, hostile);
    assert.equal(nodes.map((node) => node.value).join(""), `[点击](${hostile})`);
  }
});

test("markup the model was not meant to write arrives as text, never as a node", () => {
  const blocks = parseRichText("<script>alert(1)</script> 与 <b>粗体</b>");
  assert.deepEqual(blocks, [{
    type: "paragraph",
    inline: [{ type: "text", value: "<script>alert(1)</script> 与 <b>粗体</b>" }],
  }]);
});
