import assert from "node:assert/strict";
import test from "node:test";
import { checkSourceBoundary } from "../scripts/check-pipeline-boundary.ts";

const contract = "shared/analysis-contract/example.ts";
const runtime = "shared/analysis-runtime/example.ts";

test("contracts may infer runtime types without importing executable schemas", () => {
  for (const source of [
    'export type { Reader } from "../analysis-runtime/schema.ts";',
    'import type { Reader } from "../analysis-runtime/schema.ts"; export type Value = Reader;',
    'import { type Reader } from "../analysis-runtime/schema.ts"; export type Value = Reader;',
    'export { type Reader } from "../analysis-runtime/schema.ts";',
    'export type Value = import("../analysis-runtime/schema.ts").Reader;',
    'export const VERSION = "v1"; export type Value = { version: typeof VERSION };',
  ]) assert.deepEqual(checkSourceBoundary(contract, source), [], source);
  for (const source of [
    'export { SCHEMA } from "../analysis-runtime/schema.ts";',
    'import { SCHEMA, type Reader } from "../analysis-runtime/schema.ts";',
    'import * as schemas from "../analysis-runtime/schema.ts";',
    'import "../analysis-runtime/schema.ts";',
    'import { z } from "zod";',
    'export const validate = (value: unknown) => value;',
  ]) assert.ok(checkSourceBoundary(contract, source).length, source);
});

test("shared runtime allows only Zod, its own modules and shared contracts", () => {
  const allowed = 'import { z } from "zod"; import { ID } from "./identity.ts"; import type { Reader } from "../analysis-contract/report.ts"; export const schema = z.string();';
  assert.deepEqual(checkSourceBoundary(runtime, allowed), []);
  for (const specifier of ["node:fs", "fs", "react", "@cloudflare/workers-types", "../../lib/analysis-client.ts", "../../workers/pipeline/src/sec/d1.ts", "@/app/page.tsx", "zod/../../node:fs"]) {
    assert.ok(checkSourceBoundary(runtime, `import { value } from ${JSON.stringify(specifier)};`).length, specifier);
    assert.ok(checkSourceBoundary(runtime, `export * from ${JSON.stringify(specifier)};`).length, specifier);
  }
  assert.ok(checkSourceBoundary(runtime, 'const module = import(path);').length);
  assert.ok(checkSourceBoundary(runtime, 'const module = require("node:fs");').length);
});

test("pure runtime rejects browser, worker and process capabilities", () => {
  for (const source of [
    'export const load = () => fetch("https://example.com");',
    'export const load = () => globalThis["fetch"]("https://example.com");',
    'export const settings = process.env;',
    'export const cache = localStorage.getItem("x");',
    'export type Database = D1Database;',
    'export const next = () => crypto.randomUUID();',
    'export const timer = () => setTimeout(() => {}, 1);',
  ]) assert.ok(checkSourceBoundary(runtime, source).some((error) => error.includes("platform API")), source);
});

test("runtime sharing does not weaken the existing Pipeline and Web boundaries", () => {
  assert.deepEqual(checkSourceBoundary("workers/pipeline/src/example.ts", 'import { schema } from "../../../shared/analysis-runtime/schema.ts";'), []);
  assert.deepEqual(checkSourceBoundary("app/example.tsx", 'import { schema } from "@/shared/analysis-runtime/schema.ts";'), []);
  assert.ok(checkSourceBoundary("workers/pipeline/src/example.ts", 'import { client } from "../../../lib/client.ts";').length);
  assert.ok(checkSourceBoundary("app/example.tsx", 'import { model } from "@/workers/pipeline/src/model.ts";').length);
  assert.ok(checkSourceBoundary("workers/pipeline/src/example.ts", 'const target = WEB_APP_ORIGIN + "/api/internal/result";').length);
});
