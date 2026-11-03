import { test } from "node:test";
import assert from "node:assert/strict";
import { points, type Locale } from "../../../shared/analysis-runtime/locale.ts";

for (const locale of ["en", "zh-CN"] satisfies Locale[]) {
  const unit = locale === "en" ? " pp" : "个百分点";
  for (const fixed of [true, false]) {
    for (const signed of [true, false]) {
      const options = { fixed, signed };
      test(`points omits signs for rounded zero (${locale}, fixed=${fixed}, signed=${signed})`, () => {
        for (const value of [-0.04, 0.04, -0, 0]) {
          assert.equal(points(value, locale, options), (fixed ? "0.0" : "0") + unit, `value=${value}`);
        }
      });

      test(`points preserves nonzero signs (${locale}, fixed=${fixed}, signed=${signed})`, () => {
        assert.equal(points(-0.06, locale, options), "−0.1" + unit);
        assert.equal(points(0.06, locale, options), (signed ? "+" : "") + "0.1" + unit);
      });
    }
  }
}

test("points defaults to unsigned rounded zero with one decimal in English", () => {
  assert.equal(points(-0.04), "0.0 pp");
  assert.equal(points(0.04), "0.0 pp");
});
