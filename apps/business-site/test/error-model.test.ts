import { test } from "node:test";
import assert from "node:assert/strict";
import { companyFault, featuredCompanies, isHomePath } from "../src/error-model.ts";

test("an unknown ticker is not covered, and a listed company with one reason is short on data", () => {
  assert.deepEqual(companyFault({ httpStatus: null, reasons: ["MISSING_TWO_QUARTERS"], covered: false, attempted: true }), { kind: "not-found", code: "NOT_FOUND" });
  assert.deepEqual(companyFault({ httpStatus: null, reasons: ["MISSING_TWO_QUARTERS"], covered: null, attempted: false }), { kind: "not-found", code: "NOT_FOUND" });
  assert.deepEqual(companyFault({ httpStatus: 404, reasons: [], covered: null, attempted: false }), { kind: "not-found", code: "NOT_FOUND" });
  assert.deepEqual(companyFault({ httpStatus: null, reasons: ["MISSING_TWO_QUARTERS"], covered: true, attempted: true }), { kind: "insufficient", code: "MISSING_TWO_QUARTERS" });
  assert.deepEqual(companyFault({ httpStatus: null, reasons: ["INVALID_SOURCE", "UNBALANCED_STATEMENT"], covered: true, attempted: true }), { kind: "insufficient", code: "INVALID_SOURCE, UNBALANCED_STATEMENT" });
});

test("rate limits and server failures stay retryable even when the catalog has the company", () => {
  assert.deepEqual(companyFault({ httpStatus: 429, reasons: [], covered: true, attempted: false }), { kind: "rate-limit", code: "429" });
  assert.deepEqual(companyFault({ httpStatus: 503, reasons: [], covered: null, attempted: false }), { kind: "server", code: "503" });
  assert.deepEqual(companyFault({ httpStatus: 0, reasons: [], covered: null, attempted: false }), { kind: "server", code: "NETWORK" });
});

test("the suggestion list is the homepage's popular companies, named from the catalog", () => {
  const catalog = [{ ticker: "AAA", name: "Aaa Inc.", nameZh: "甲公司" }, { ticker: "BBB", name: "Bbb Corp", nameZh: null }];
  const picks = featuredCompanies(catalog, ["BBB", "AAA", "GONE"], "zh-CN");
  assert.deepEqual(picks.map(company => company.ticker), ["BBB", "AAA"]);
  assert.equal(picks[0]?.name, "Bbb Corp");
  assert.equal(picks[1]?.name, "甲公司");
  assert.deepEqual(featuredCompanies([], [], "en"), []);
  assert.equal(isHomePath("/"), true);
  assert.equal(isHomePath("/index.html"), true);
  assert.equal(isHomePath("/companies/META"), false);
  assert.equal(isHomePath("/nope"), false);
});
