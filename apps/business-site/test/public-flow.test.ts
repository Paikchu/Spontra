import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPublicFlow } from "../worker/index.ts";

const answer = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
const preparing = { schemaVersion: "complete-business-flow.v1", status: "preparing", flow: null, reasons: ["PREPARING"], outdated: false, lastAttemptAt: null };

test("the issuer's fiscal calendar passes through to the page, and only in its own shape", async () => {
  const kept = await loadPublicFlow("ACME", answer({ ...preparing, issuer: { fiscalYearEndMonth: 5, name: " Acme ", annualForm: "20-F", extra: "x" } }));
  assert.deepEqual(kept.issuer, { fiscalYearEndMonth: 5, name: "Acme", annualForm: "20-F" });
  const odd = await loadPublicFlow("ACME", answer({ ...preparing, issuer: { fiscalYearEndMonth: 13, name: 3, annualForm: "S-1" } }));
  assert.deepEqual(odd.issuer, { fiscalYearEndMonth: null, name: null, annualForm: null });
  assert.equal((await loadPublicFlow("ACME", answer(preparing))).issuer, undefined);
});
