import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterByGap, narrowTypes, readTimelineTypes, timelineSearch } from "../src/timeline-model.ts";

const at = (id: string, x: number) => ({ id, x });

test("points closer than the hit size share one marker, and a gap keeps them apart", () => {
  const clustered = clusterByGap([at("a", 0), at("b", 10), at("c", 20), at("d", 50)], item => item.x, 24);
  assert.deepEqual(clustered.map(mark => mark.items.map(item => item.id)), [["a", "b", "c"], ["d"]]);
  assert.equal(clustered[0]?.items.length, 3);
  const apart = clusterByGap([at("a", 0), at("b", 24)], item => item.x, 24);
  assert.equal(apart.length, 2);
  // A steady 20px run must not collapse into one marker: each cluster stays inside the hit size.
  const run = clusterByGap([at("a", 0), at("b", 20), at("c", 40), at("d", 60)], item => item.x, 24);
  assert.deepEqual(run.map(mark => mark.items.map(item => item.id)), [["a", "b"], ["c", "d"]]);
  assert.ok(run[1].x - run[0].x >= 24);
});

test("the type filter round-trips through the query and leaves other parameters alone", () => {
  assert.equal(readTimelineTypes(""), null);
  assert.deepEqual(readTimelineTypes("?finding=f1&tl=report,guidance"), ["report", "guidance"]);
  assert.equal(timelineSearch("?finding=f1&tl=report", null), "?finding=f1");
  assert.equal(timelineSearch("?finding=f1", ["insider", "report"]), "?finding=f1&tl=insider%2Creport");
  assert.deepEqual(narrowTypes(["report", "gone"], ["report", "insider"]), ["report"]);
  assert.equal(narrowTypes(["report", "insider"], ["report", "insider"]), null);
  assert.equal(narrowTypes(null, ["report"]), null);
});
