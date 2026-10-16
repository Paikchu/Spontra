import { test } from "node:test";
import assert from "node:assert/strict";
import type { MapResource, MapRevisions } from "../../../shared/analysis-contract/revisions.ts";
import { nextPending, readRevisions, resourcesToRead } from "../src/revision-reads.ts";

type Screen = { publication: unknown; flow: unknown; findings: unknown; events: unknown; capital: unknown };
const screen = (over: Partial<Screen> = {}): Screen => ({ publication: { v: 1 }, flow: { v: 1 }, findings: null, events: null, capital: null, ...over });

/** Answers each resource from a table; a missing entry fails the way a refused request does. */
const reader = (answers: Partial<Record<MapResource, Partial<Screen> | null>>) => {
  const asked: MapResource[] = [];
  const read = async (resource: MapResource) => {
    asked.push(resource);
    if (!(resource in answers)) throw new Error("unavailable");
    return answers[resource] ?? null;
  };
  return { read, asked };
};

/** One check as the page runs it: what to read, the reads, and the revisions it then counts as shown. */
async function check(shown: MapRevisions, latest: MapRevisions, now: Screen, answers: Parameters<typeof reader>[0]) {
  const { read, asked } = reader(answers);
  const result = await readRevisions(resourcesToRead(shown, latest), latest, now, read);
  return { asked, result, shown: { ...shown, ...result.same, ...result.filled.revisions } };
}

test("a resource whose first read failed is read again at the next check and fills in", async () => {
  // The page opened at these revisions; the findings read failed, so only the company was counted as read.
  const latest = { company: "c1", findings: "f1" };
  const opened: MapRevisions = { company: "c1" };

  const first = await check(opened, latest, screen(), {});
  assert.deepEqual(first.asked, ["findings"]);
  assert.deepEqual(first.shown, opened, "a failed read does not move the revision on");

  const findings = { list: ["a"] };
  const second = await check(first.shown, latest, screen(), { findings: { findings } });
  assert.deepEqual(second.asked, ["findings"]);
  assert.deepEqual(second.result.filled, { revisions: { findings: "f1" }, patch: { findings } });
  assert.deepEqual(second.shown, latest);
  assert.deepEqual(resourcesToRead(second.shown, latest), []);
});

test("a check that fails for one resource settles only the ones that answered", async () => {
  const shown = { findings: "f1", events: "e1" };
  const latest = { findings: "f2", events: "e2" };
  const now = screen({ findings: { list: ["a"] }, events: { list: ["x"] } });
  const { result, shown: after } = await check(shown, latest, now, { events: { events: { list: ["x"] } } });
  assert.deepEqual(result.same, { events: "e2" });
  assert.deepEqual(after, { findings: "f1", events: "e2" });
  assert.deepEqual(resourcesToRead(after, latest), ["findings"]);
});

test("a published resource that reads empty is not counted as read", async () => {
  const { shown } = await check({}, { capital: "k1" }, screen(), { capital: null });
  assert.deepEqual(shown, {});
});

test("newer data waits for the reader and is dropped once a later read matches the screen", async () => {
  const now = screen({ events: { list: ["x"] } });
  const newer = { events: { list: ["x", "y"] } };
  const first = await check({ events: "e1" }, { events: "e2" }, now, { events: newer });
  const waiting = nextPending(null, first.result);
  assert.deepEqual(waiting, { revisions: { events: "e2" }, patch: newer });
  assert.deepEqual(first.shown, { events: "e1" }, "a waiting update is shown only once taken");
  assert.deepEqual(resourcesToRead(first.shown, { events: "e2" }, waiting!.revisions), [], "what waits is not read again");

  // The events moved on and now read as the screen already shows them: nothing is left to offer.
  const second = await check(first.shown, { events: "e3" }, now, { events: now });
  assert.equal(nextPending(waiting, second.result), null);
});

test("a waiting update keeps a resource whose newer read failed", async () => {
  const now = screen({ findings: { list: ["a"] }, events: { list: ["x"] } });
  const waiting = { revisions: { findings: "f2" }, patch: { findings: { list: ["a", "b"] } } };
  const { result } = await check({ findings: "f1", events: "e1" }, { findings: "f3", events: "e2" }, now, { events: { events: { list: ["x", "y"] } } });
  assert.deepEqual(nextPending(waiting, result), {
    revisions: { findings: "f2", events: "e2" },
    patch: { findings: { list: ["a", "b"] }, events: { list: ["x", "y"] } },
  });
});
