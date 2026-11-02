import { test } from "node:test";
import assert from "node:assert/strict";
import { selectLatestWorkflowFilings } from "../src/workflow-core.ts";
import type { SecFiling } from "../src/sec/sec.ts";

const filing = (accessionNumber: string, form: string) => ({ accessionNumber, form, ticker: "NBIS" }) as SecFiling;

test("a newest periodic report that is an amendment brings the original it amends", () => {
  const filings = [filing("a-6k", "6-K"), filing("a-20fa", "20-F/A"), filing("a-20f", "20-F"), filing("a-6k-old", "6-K")];
  assert.deepEqual(selectLatestWorkflowFilings(filings).map(f => f.accessionNumber), ["a-20f", "a-20fa", "a-6k", "a-6k-old"]);
});

test("a newest periodic report that is an original comes alone", () => {
  const filings = [filing("q2", "10-Q"), filing("k-a", "10-K/A"), filing("k", "10-K")];
  assert.deepEqual(selectLatestWorkflowFilings(filings).map(f => f.accessionNumber), ["q2"]);
});
