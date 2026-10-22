import { test } from "node:test";
import assert from "node:assert/strict";
import { carriesResult, isDefaultScene, nextTranscript, overlay, readEvent, shown, stageResult, type OverlayEvent, type OverlayState, type TranscriptEntry } from "../src/stage/stage-model.ts";

test("every edge of the overlay state machine", () => {
  const cases: Array<[OverlayState, OverlayEvent, OverlayState]> = [
    ["closed", { type: "toggle" }, "open"], ["away", { type: "toggle" }, "open"], ["open", { type: "toggle" }, "away"], ["busy", { type: "toggle" }, "away"], ["disconnected", { type: "toggle" }, "disconnected"],
    ["closed", { type: "focus" }, "open"], ["away", { type: "focus" }, "open"], ["busy", { type: "focus" }, "busy"],
    ["open", { type: "sent" }, "away"], ["open", { type: "escape" }, "away"], ["busy", { type: "escape" }, "away"], ["away", { type: "escape" }, "away"], ["closed", { type: "escape" }, "closed"],
    ["open", { type: "stage-click" }, "away"], ["open", { type: "result" }, "away"], ["busy", { type: "result" }, "away"], ["closed", { type: "result" }, "closed"],
    ["open", { type: "turn-start" }, "busy"], ["away", { type: "turn-start" }, "away"], ["closed", { type: "turn-start" }, "closed"],
    ["busy", { type: "turn-end" }, "open"], ["away", { type: "turn-end" }, "away"],
    ["open", { type: "disconnect" }, "disconnected"], ["busy", { type: "disconnect" }, "disconnected"], ["away", { type: "disconnect" }, "away"], ["closed", { type: "disconnect" }, "closed"],
    ["disconnected", { type: "connect", running: false }, "open"], ["disconnected", { type: "connect", running: true }, "busy"], ["away", { type: "connect", running: false }, "away"],
  ];
  for (const [from, event, to] of cases) assert.equal(overlay(from, event), to, `${from} + ${event.type}`);
});

test("the reader's picks on the map win over the agent's scene", () => {
  assert.equal(shown(true, { type: "navigate" }), false);
  assert.equal(shown(false, { type: "committed", revision: 3, movedSinceSay: false }), true);
  assert.equal(shown(false, { type: "committed", revision: 3, movedSinceSay: true }), false);
  assert.equal(shown(false, { type: "committed", revision: 0, movedSinceSay: false }), false);
  assert.equal(shown(false, { type: "show" }), true);
});

test("socket messages: only stage events are read, and the transcript never repeats an entry", () => {
  assert.equal(readEvent('{"type":"cf_agent_state","state":{}}'), null);
  assert.equal(readEvent("not json"), null);
  const e = (id: string): TranscriptEntry => ({ id, at: "", role: "user", text: id });
  assert.deepEqual(nextTranscript([e("a")], { type: "stage:transcript", entries: [e("a"), e("b")] }).map(x => x.id), ["a", "b"]);
  assert.deepEqual(nextTranscript([e("a")], { type: "stage:transcript", entries: [e("c")], replace: true }).map(x => x.id), ["c"]);
  assert.ok(isDefaultScene([{ cells: [[{ id: "map", kind: "business-flow" }]] }]));
  assert.ok(!isDefaultScene([{ cells: [[{ id: "x", kind: "findings" }]] }]));
});

test("the stage shows the latest question's turn, then its result", () => {
  const user = (id: string, text: string): TranscriptEntry => ({ id, at: "", role: "user", text });
  const answer: TranscriptEntry = { id: "a", at: "", role: "assistant", kind: "answer", paragraphs: [{ text: "x", sourceIds: [] }], contentLanguage: "en" };
  const proposal: TranscriptEntry = { id: "q", at: "", role: "assistant", kind: "question", questionId: "q1", question: "Report?" };
  assert.equal(stageResult([], null), null);
  assert.deepEqual(stageResult([user("u", "hi")], { id: "t", phase: "staging", status: null }), { kind: "loading", question: "hi", phase: "staging" });
  assert.equal(stageResult([user("u", "hi"), answer], null)?.kind, "answer");
  assert.equal(stageResult([user("u", "hi"), { id: "s", at: "", role: "assistant", kind: "stage", revision: 2 }], null)?.kind, "scene");
  assert.equal(stageResult([user("u", "hi"), proposal], null)?.kind, "proposal");
  assert.equal(stageResult([user("u", "hi"), { ...proposal, settled: "yes" } as TranscriptEntry], null)?.kind, "scene");
  assert.equal(stageResult([user("u", "hi"), { ...proposal, settled: "no" } as TranscriptEntry], null), null);
  assert.equal(stageResult([user("u", "hi"), { id: "n", at: "", role: "assistant", kind: "notice", code: "quota-reached" }], null)?.kind, "notice");
  // Progress marks do not take the stage, and an earlier question's answer is not the latest one's.
  assert.equal(stageResult([user("u", "hi"), { id: "n", at: "", role: "assistant", kind: "notice", code: "report-ready" }], null), null);
  assert.equal(stageResult([user("u1", "a"), answer, user("u2", "b")], null), null);
  assert.ok(carriesResult({ type: "stage:transcript", entries: [answer] }));
  assert.ok(!carriesResult({ type: "stage:transcript", entries: [answer], replace: true }));
  assert.ok(!carriesResult({ type: "stage:transcript", entries: [{ ...proposal, settled: "yes" } as TranscriptEntry] }));
});
