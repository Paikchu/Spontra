import { test } from "node:test";
import assert from "node:assert/strict";
import { isDefaultScene, nextTranscript, overlay, readEvent, shown, type OverlayEvent, type OverlayState, type TranscriptEntry } from "../src/stage/stage-model.ts";

test("every edge of the overlay state machine", () => {
  const cases: Array<[OverlayState, OverlayEvent, OverlayState]> = [
    ["closed", { type: "toggle" }, "open"], ["open", { type: "toggle" }, "closed"], ["mini", { type: "toggle" }, "closed"], ["busy", { type: "toggle" }, "busy"],
    ["closed", { type: "focus" }, "open"], ["mini", { type: "focus" }, "open"], ["busy", { type: "focus" }, "busy"],
    ["open", { type: "escape" }, "mini"], ["mini", { type: "escape" }, "closed"], ["busy", { type: "escape" }, "busy"], ["closed", { type: "escape" }, "closed"],
    ["open", { type: "turn-start" }, "busy"], ["mini", { type: "turn-start" }, "busy"], ["closed", { type: "turn-start" }, "closed"],
    ["busy", { type: "turn-end", staged: true }, "mini"], ["busy", { type: "turn-end", staged: false }, "open"], ["open", { type: "turn-end", staged: true }, "open"],
    ["open", { type: "staged" }, "mini"], ["busy", { type: "staged" }, "mini"], ["closed", { type: "staged" }, "closed"], ["mini", { type: "staged" }, "mini"],
    ["open", { type: "disconnect" }, "disconnected"], ["busy", { type: "disconnect" }, "disconnected"], ["closed", { type: "disconnect" }, "closed"],
    ["disconnected", { type: "connect", running: false }, "open"], ["disconnected", { type: "connect", running: true }, "busy"], ["open", { type: "connect", running: false }, "open"],
    ["open", { type: "stage-click" }, "mini"], ["busy", { type: "stage-click" }, "busy"],
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
