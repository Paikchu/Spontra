/** Prepare isolated, immutable evaluation cache records. This script writes local SQL only; it neither deploys nor runs a model. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readHistoryInput } from "../../../shared/analysis-runtime/valuation/history.ts";

const { values: args } = parseArgs({ options: { input: { type: "string" }, "source-root": { type: "string" }, id: { type: "string" }, sql: { type: "string" } } });
if (!args.input || !args["source-root"] || !args.id || !args.sql) throw new Error("--input, --source-root, --id and --sql are required");
if (!/^[a-zA-Z0-9-]{1,90}$/.test(args.id)) throw new Error("Invalid evaluation id");
const raw = readFileSync(args.input, "utf8"), input = readHistoryInput(JSON.parse(raw));
const digest = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const root = resolve(args["source-root"]);
for (const source of input.sources) {
  const path = resolve(root, source.path), part = relative(root, path);
  if (isAbsolute(source.path) || part.startsWith("..") || isAbsolute(part)) throw new Error(`Source escapes the frozen directory: ${source.id}`);
  if (digest(readFileSync(path)) !== source.sha256) throw new Error(`Source hash mismatch: ${source.id}`);
}
for (const material of input.researchMaterials) if (digest(material.text) !== material.sha256) throw new Error(`Text hash mismatch: ${material.sourceId}`);
if (raw.length > 1_900_000) throw new Error("Snapshot exceeds evaluation limit");
const chunks: string[] = [], statements: string[] = [], now = new Date().toISOString();
const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;
const insert = (key: string, value: unknown) => `INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (${sqlText(key)}, ${sqlText(JSON.stringify(value))}, ${sqlText(now)}) ON CONFLICT(cache_key) DO NOTHING;`;
for (let offset = 0; offset < raw.length; offset += 20_000) {
  const key = `valuation:evaluation:chunk:${args.id}:${chunks.length}`;
  chunks.push(key);
  statements.push(insert(key, raw.slice(offset, offset + 20_000)));
}
const inputSha256 = digest(raw);
statements.push(insert(`valuation:evaluation:input:${args.id}`, { schemaVersion: "valuation-evaluation-input.v1", chunks, inputSha256 }));
writeFileSync(args.sql, statements.join("\n") + "\n");
process.stdout.write(JSON.stringify({ evaluationId: args.id, ticker: input.ticker, cutoff: input.cutoff, inputSha256, chunks: chunks.length, sql: args.sql, workflowParams: { ticker: input.ticker, evaluationId: args.id } }, null, 2) + "\n");
