import test from "node:test";
import assert from "node:assert/strict";
import { readFiscalFocus } from "../src/read-api/fiscal-periods.ts";

/** Fake D1 whose range query rejects only for keys starting with `failPrefix`. */
function db(failPrefix: string | null): D1Database {
  return {
    prepare: () => ({
      bind: (from: string) => ({
        all: async () => {
          if (failPrefix && from.startsWith(failPrefix)) throw new Error("D1_ERROR: storage unavailable");
          return { results: [] };
        },
      }),
    }),
  } as unknown as D1Database;
}

test("AC-7: a failing fiscal-period range query rejects instead of yielding empty maps", async () => {
  await assert.rejects(readFiscalFocus(db("sec:fiscal-period:v1:")), /storage unavailable/);
  await assert.rejects(readFiscalFocus(db("sec:fiscal-period:v1:"), "NVDA"), /storage unavailable/);
});

test("AC-7: a failing discovery-state range query rejects too", async () => {
  await assert.rejects(readFiscalFocus(db("sec:discovery")), /storage unavailable/);
});

test("AC-7: a successful empty read still returns empty maps", async () => {
  const result = await readFiscalFocus(db(null));
  assert.equal(result.focus.size, 0);
  assert.equal(result.issuers.size, 0);
});
