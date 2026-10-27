import { test } from "node:test";
import assert from "node:assert/strict";
import { checkIssuerLiterals } from "../../../scripts/check-issuer-literals.ts";

const check = (source: string) => checkIssuerLiterals("shared/example.ts", source);

test("code that names a company fails the check", () => {
  assert.equal(check(`export const profiled = (cik: string) => cik === "0000000123";`).length, 1);
  assert.equal(check(`if (ticker !== "ACME") return q;`).length, 1);
  assert.equal(check(`if (row.ticker === "ACME") return q;`).length, 1);
  assert.equal(check(`const FEATURED = ["AAA", "BBB", "CCC"];`).length, 1);
  assert.equal(check(`const ISSUERS = { AAA: 1, BBB: 2, CCC: 3 };`).length, 1);
});

test("periods, currencies, forms and code tables are not companies", () => {
  assert.deepEqual(check(`const P = ["FY", "Q1", "Q2", "Q3"]; const C = { USD: 1, EUR: 2, JPY: 3 };`), []);
  assert.deepEqual(check(`const CODES = new Set(["S", "P", "M", "F"]);`), []);
  assert.deepEqual(check(`if (row.ticker === "*") return;`), []);
});
