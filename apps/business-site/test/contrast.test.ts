import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const css = await readFile(new URL("../src/style.css", import.meta.url), "utf8");

function lin(channel: number) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function lum(hex: string) {
  const n = hex.slice(1);
  const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(fg: string, bg: string) {
  const a = lum(fg), b = lum(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}
function tokens(block: string) {
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6});/g)].map(match => [match[1], match[2]!.toLowerCase()]));
}
const dark = tokens(css.match(/:root \{([\s\S]*?)\n\}/)![1]!);
const light = tokens(css.match(/:root\.light \{([\s\S]*?)\n\}/)![1]!);

test("dark text tokens clear 4.5:1 and chart grid clears 3:1", () => {
  assert.ok(contrast(dark["muted-foreground"]!, "#152723") >= 4.5);
  assert.ok(contrast(dark.faint!, "#152723") >= 4.5);
  assert.ok(contrast(dark.faint!, "#0a1412") >= 4.5);
  assert.ok(contrast(dark.foreground!, "#0a1412") >= 4.5);
  assert.ok(contrast(dark.grid!, "#0a1412") >= 3);
  assert.ok(contrast(dark.grid!, "#0f1d1a") >= 3);
});

test("light text tokens clear 4.5:1 and chart grid clears 3:1", () => {
  assert.ok(contrast(light["muted-foreground"]!, "#ffffff") >= 4.5);
  assert.ok(contrast(light["muted-foreground"]!, "#f3f5f2") >= 4.5);
  assert.ok(contrast(light.faint!, "#ffffff") >= 4.5);
  assert.ok(contrast(light.faint!, "#f3f5f2") >= 4.5);
  assert.ok(contrast(light.faint!, "#e9efea") >= 4.5);
  assert.ok(contrast(light.grid!, "#f3f5f2") >= 3);
  assert.ok(contrast(light.grid!, "#ffffff") >= 3);
  assert.ok(contrast(light.up!, "#e3e5e4") >= 4.5);
  assert.ok(contrast(light.loss!, "#e3e5e4") >= 4.5);
});
