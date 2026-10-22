import { test } from "node:test";
import assert from "node:assert/strict";
import { readerChange } from "../src/sec/reader.ts";
import { editorialGate, normalizeEditorialIssues, type EditorialIssue } from "../src/sec/editorial.ts";

// NBIS's 20-F states its own prior baseline: three material weaknesses at December 31, 2024, two remediated in 2025.
const BASELINE = "ev:0001104659-26-052948:nbis-20251231x20f.htm:block:0090:d9dfeda9";
const CURRENT = "ev:0001104659-26-052948:nbis-20251231x20f.htm:block:0233:3bf6c350";
const evidence = { currentEvidence: new Set([BASELINE, CURRENT, "xbrl:ae285dcf", "market:NBIS:9d75"]), priorEvidence: new Set(["xbrl:2023capex"]) };
const row = (priorEvidenceIds: string[]) => ({ topic: "Internal control", kind: "changed", prior: "Three material weaknesses at December 31, 2024.",
  current: "Two remediated during 2025; two remain open.", implication: "Partial improvement, not a clean control environment.", evidenceIds: [CURRENT], priorEvidenceIds });

test("a change row's prior position may rest on a passage of this filing that states it", () => {
  const change = readerChange(row([BASELINE]), evidence);
  assert.equal(change.kind, "changed");
  assert.equal(change.prior, "Three material weaknesses at December 31, 2024.");
  assert.deepEqual(change.priorEvidenceIds, [BASELINE]);
});

test("this period's figures and market data are not a prior baseline, so the row stays not comparable", () => {
  for (const id of ["xbrl:ae285dcf", "market:NBIS:9d75"]) {
    const change = readerChange(row([id]), evidence);
    assert.equal(change.kind, "not_comparable");
    assert.equal(change.prior, "No verified comparable baseline");
  }
  assert.equal(readerChange(row(["xbrl:2023capex"]), evidence).kind, "changed", "earlier periods' source data still count");
});

const issue = (id: string, category: EditorialIssue["category"], severity: EditorialIssue["severity"], previousIssueId?: string): EditorialIssue =>
  ({ id, category, severity, sectionIds: [], quote: "", evidenceIds: [], detail: id, acceptance: "", ...(previousIssueId ? { previousIssueId } : {}) });

test("early rounds block on every finding that is not minor or about presentation", () => {
  const { blocking, notes } = editorialGate([issue("gap", "coverage", "major"), issue("typo", "presentation", "major"), issue("nit", "fact", "minor")], 1, []);
  assert.deepEqual(blocking.map(i => i.id), ["gap"]);
  assert.deepEqual(notes.map(i => i.id), ["typo", "nit"]);
});

test("from round two only unresolved earlier issues and new errors of fact block; other new findings become notes", () => {
  const previous = [issue("controls-baseline", "consistency", "major"), issue("old-nit", "coverage", "minor")];
  const findings = [
    issue("controls-row-mismatch", "consistency", "major", "controls-baseline"),
    issue("microsoft-fee-omitted", "coverage", "major"),
    issue("wrong-capex-figure", "fact", "major"),
    issue("revived-nit", "coverage", "major", "old-nit"),
  ];
  const { blocking, notes } = editorialGate(findings, 2, previous);
  assert.deepEqual(blocking.map(i => i.id), ["controls-row-mismatch", "wrong-capex-figure"]);
  assert.deepEqual(notes.map(i => i.id), ["microsoft-fee-omitted", "revived-nit"]);
});

test("a finding may only continue an issue the previous round reported", () => {
  const audit = { verdict: "revise", issues: [
    { id: "a", category: "consistency", severity: "major", previousIssueId: "controls-baseline", detail: "d", acceptance: "x" },
    { id: "b", category: "consistency", severity: "major", previousIssueId: "made-up", detail: "d", acceptance: "x" },
  ] };
  const [a, b] = normalizeEditorialIssues(audit, new Set(), new Set(["controls-baseline"]));
  assert.equal(a!.previousIssueId, "controls-baseline");
  assert.equal(b!.previousIssueId, undefined);
});
