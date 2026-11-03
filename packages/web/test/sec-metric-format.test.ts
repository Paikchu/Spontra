import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSecMetricLabel, formatSecMetricValue } from "../src/model/sec-metric-format.ts";

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

test("Chinese labels translate growth and common operating keys and mark unknown keys; English is unchanged", () => {
  assert.equal(formatSecMetricLabel("revenue_growth", "zh-CN"), "营收增长");
  assert.equal(formatSecMetricLabel("data_center_revenue_growth", "zh-CN"), "Data Center 营收增长");
  assert.equal(formatSecMetricLabel("data_center_units", "zh-CN"), "Data Center 销量");
  assert.equal(formatSecMetricLabel("backlog", "zh-CN"), "未交付订单");
  assert.equal(formatSecMetricLabel("subscriber_churn", "zh-CN"), "指标（subscriber churn）");
  assert.equal(formatSecMetricLabel("revenue_growth"), "revenue growth");
  assert.equal(formatSecMetricLabel("data_center_units"), "data center units");
  assert.equal(formatSecMetricLabel("subscriber_churn"), "subscriber churn");
});

test("a ratio metric is scaled by its unit, and one without a unit keeps its stored number", () => {
  assert.equal(formatSecMetricValue("gross_margin", "0.08", "ratio"), "8.0%");
  assert.equal(formatSecMetricValue("gross_margin", "1.2", "%"), "1.2%");
  assert.equal(formatSecMetricValue("revenue_growth", "1.2", "percent"), "1.2%");
  assert.equal(formatSecMetricValue("revenue_growth", "0.8"), "0.8");
  assert.equal(formatSecMetricValue("revenue_growth", "75"), "75");
});
