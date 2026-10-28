import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSecMetricLabel } from "../src/model/sec-metric-format.ts";

test("a key ending in a known metric reads as that metric of the part its leading words name", () => {
  assert.equal(formatSecMetricLabel("data_center_revenue"), "Data Center revenue");
  assert.equal(formatSecMetricLabel("data_center_revenue", "zh-CN"), "Data Center 营收");
  assert.equal(formatSecMetricLabel("cloud_operating_income"), "Cloud operating income");
  assert.equal(formatSecMetricLabel("segment_eps"), "Segment EPS");
});

test("known keys keep their label and unknown keys read as words", () => {
  assert.equal(formatSecMetricLabel("revenue", "zh-CN"), "营收");
  assert.equal(formatSecMetricLabel("backlog_units"), "backlog units");
});
