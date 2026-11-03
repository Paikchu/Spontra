/**
 * Offline point-in-time replay. No network, Worker invocation, or database writes.
 *
 * node --experimental-strip-types workers/analysis/scripts/valuation-history.ts \
 *   --input research/orcl-valuation-history/inputs/fy2026-q2/input.json \
 *   --source-root research/orcl-valuation-history --validate
 *
 * Add --assumptions <Agent artifact> --out <local result> to calculate. Optional --outcomes <file>
 * is opened only after the calculation; future prices and actuals never enter calculateValuation.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { evaluateHistory, historyAssumptionsSchema, historyOutcomeSchema, readHistoryInput, replayHistory } from "../../../shared/analysis-runtime/valuation/history.ts";

const { values: args } = parseArgs({ options: {
  input: { type: "string" }, "source-root": { type: "string" }, assumptions: { type: "string" }, outcomes: { type: "string" },
  out: { type: "string" }, validate: { type: "boolean", default: false },
} });
if (!args.input || !args["source-root"]) throw new Error("--input and --source-root are required");
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const raw = readFileSync(args.input);
const input = readHistoryInput(JSON.parse(raw.toString("utf8")));
const inputSha256 = sha256(raw), root = resolve(args["source-root"]);
const verifySources = (sources: typeof input.sources) => {
  for (const source of sources) {
    const path = resolve(root, source.path), fromRoot = relative(root, path);
    if (isAbsolute(source.path) || fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw new Error(`Source path leaves the frozen source root: ${source.id}`);
    if (sha256(readFileSync(path)) !== source.sha256) throw new Error(`Source hash mismatch: ${source.id}`);
  }
};
verifySources(input.sources);
for (const material of input.researchMaterials) {
  if (sha256(material.text) !== material.sha256) throw new Error(`Research text hash mismatch: ${material.sourceId}`);
}
if (args.validate) {
  process.stdout.write(JSON.stringify({ ticker: input.ticker, cutoff: input.cutoff, inputSha256, facts: input.facts.length, sources: input.sources.length, missing: input.missing, status: input.missing.length ? "incomplete" : "ready_for_agent" }, null, 2) + "\n");
} else {
  if (!args.assumptions || !args.out) throw new Error("A replay requires --assumptions from an Agent and --out; a code-only prior is not a historical Agent run");
  const artifact = historyAssumptionsSchema.parse(JSON.parse(readFileSync(args.assumptions, "utf8")));
  const replay = replayHistory(input, artifact, inputSha256);
  const outcome = args.outcomes ? historyOutcomeSchema.parse(JSON.parse(readFileSync(args.outcomes, "utf8"))) : null;
  if (outcome?.sources) verifySources(outcome.sources);
  const evaluation = outcome ? evaluateHistory(input, artifact, outcome, inputSha256) : null;
  writeFileSync(args.out, JSON.stringify({ schemaVersion: "valuation-history-run.v1", kind: artifact.kind, ticker: input.ticker, cutoff: input.cutoff, inputSha256, model: artifact.model, promptSha256: artifact.promptSha256, transcriptPath: artifact.transcriptPath, ...replay, evaluation, limitations: input.limitations }, null, 2) + "\n");
  process.stdout.write(`${input.ticker} ${input.cutoff}: saved replay to ${args.out}\n`);
}
