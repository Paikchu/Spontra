import { test } from "node:test";
import assert from "node:assert/strict";
import { runElapsed, runView } from "../src/run-progress.ts";

const at = "2026-10-22T13:00:00.000Z";
const run = (kind: Parameters<typeof runView>[0]["kind"], stages: string[]) =>
  ({ kind, status: "running", stage: stages.at(-1) ?? null, steps: stages.map(stage => ({ stage, at })), startedAt: at, updatedAt: at });

test("a report job is placed by its stage, with the editorial round as its step", () => {
  const view = runView({ ...run("report", []), stage: "editorial-review:1" });
  assert.equal(view.phases[view.current], "编辑审校");
  assert.equal(view.step, "编辑审校 · 第 2 轮");
  assert.equal(runView({ ...run("report", []), stage: "node:round:0:3:segment-cloud" }).step, "分节分析 · 第 4 节");
  assert.equal(runView({ ...run("report", []), stage: "discovery-audit" }).phases[3], "分节分析");
  assert.equal(runView({ ...run("report", []), stage: "discovery:2" }).current, 1);
});

test("parallel tree businesses show the furthest phase, and the step names the business and its turn", () => {
  const view = runView(run("tree", ["tree-time", "tree-input", "tree-filings", "tree-b1-library", "tree-b2-t1-act", "tree-b1-review", "tree-b2-t3-2-search"]));
  assert.equal(view.phases[view.current], "审校");
  assert.equal(view.step, "第 2 项业务 · 第 3 轮网页搜索");
  assert.equal(view.steps, 7);
  assert.equal(runView(run("tree", ["tree-b1-describe-review"])).phases[runView(run("tree", ["tree-b1-describe-review"])).current], "复核");
});

test("findings, analyst and explainer steps read as their phases", () => {
  const lens = runView(run("findings", ["findings-time", "findings-input", "findings-write", "findings-lens-f2-t2-c0-read"]));
  assert.deepEqual([lens.phases[lens.current], lens.step], ["绘制图表", "图表 · 第 2 轮阅读"]);
  const analyst = runView(run("analyst", ["analyst-time", "analyst-input", "analyst-r1-f3-t4-act"]));
  assert.deepEqual([analyst.phases[analyst.current], analyst.step], ["逐条研究", "第 4 轮思考"]);
  const explainer = runView(run("explainer", ["explainer-input", "explainer-evidence-0", "explainer-write-1"]));
  assert.deepEqual([explainer.phases[explainer.current], explainer.step], ["撰写", "撰写 · 第 2 组"]);
});

test("elapsed time runs from the start to now", () => {
  assert.equal(runElapsed({ startedAt: at, updatedAt: at }, Date.parse(at) + 125_000), "2 分钟");
  assert.equal(runElapsed({ startedAt: at, updatedAt: at }, Date.parse(at) + 3_900_000), "1 小时 5 分");
});
