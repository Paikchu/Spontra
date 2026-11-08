/**
 * Starts a `selftest` build of the desktop app, lets scripts/desktop-selftest.js drive it inside the real webview, and
 * prints what it found. Exits non-zero if any check failed.
 *
 *   node --experimental-strip-types scripts/desktop-selftest.ts --app <Spontra.app> [--mode full|door] [--site ws://127.0.0.1:8799]
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { app: { type: "string" }, mode: { type: "string", default: "full" }, site: { type: "string", default: "" }, "timeout-s": { type: "string", default: "180" } } });
if (!values.app) throw new Error("--app is required");
const app = resolve(values.app);

type Result = { name: string; ok: boolean; detail?: unknown };
const work = mkdtempSync(join(tmpdir(), "spontra-selftest-"));
const out = join(work, "results.jsonl"), script = join(work, "script.js");
writeFileSync(script, `window.__selftest_mode=${JSON.stringify(values.mode)};window.__selftest_site=${JSON.stringify(values.site)};\n${readFileSync(new URL("./desktop-selftest.js", import.meta.url), "utf8")}`);
const child = spawn(join(app, "Contents/MacOS/spontra-desktop"), [], { env: { ...process.env, SPONTRA_SELFTEST_OUT: out, SPONTRA_SELFTEST_SCRIPT: script, SPONTRA_CACHE_DIR: join(work, "cache"), SPONTRA_PERF_LOG: join(work, "perf.log") }, stdio: ["ignore", "pipe", "pipe"] });
const origins = new Set<string>();
const scan = (chunk: Buffer) => { for (const match of chunk.toString().matchAll(/selftest-origin=(\S+)/g)) origins.add(match[1]!); };
child.stdout.on("data", scan); child.stderr.on("data", scan);

const read = (): Result[] => existsSync(out) ? readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Result) : [];
const deadline = Date.now() + Number(values["timeout-s"]) * 1000;
let linked = false, results: Result[] = [];
while (Date.now() < deadline) {
  results = read();
  const waiting = results.find(result => result.name === "awaiting-deep-link");
  if (waiting && !linked) { linked = true; execFileSync("open", ["-a", app, `spontra://companies/${(waiting.detail as { ticker: string }).ticker}?view=cash`]); }
  if (results.some(result => result.name === "done" || result.name === "crashed")) break;
  await new Promise(resolve => setTimeout(resolve, 200));
}
child.kill();
const finished = results.some(result => result.name === "done");
for (const result of results.filter(r => r.name !== "done" && r.name !== "awaiting-deep-link")) console.log(`${result.ok ? "pass" : "FAIL"}  ${result.name}  ${JSON.stringify(result.detail ?? null)}`);
console.log(`origins the webview sent: ${[...origins].join(", ") || "none"}`);
if (!finished) console.log("FAIL  the run did not finish");
process.exit(finished && results.every(result => result.ok) ? 0 : 1);
