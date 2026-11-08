/**
 * Launch timings and memory of a built desktop app: each launch is a fresh process, against an empty disk cache (cold)
 * or one the previous launches filled (warm). Reports medians; `--gate` fails when one is over budget.
 *
 *   npm run desktop:perf -- --app <Spontra.app> [--runs 7] [--out docs/perf/desktop.json] [--gate] [--budget-scale 2]
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { app: { type: "string" }, runs: { type: "string", default: "7" }, out: { type: "string" }, gate: { type: "boolean", default: false }, "budget-scale": { type: "string", default: "1" }, "hold-ms": { type: "string", default: "6000" } } });
if (!values.app) throw new Error("--app is required");

const BUDGET = { warmContentMs: 800, coldContentMs: 1500, memoryMb: 180, appMb: 25 };
const scale = Number(values["budget-scale"]);
const work = mkdtempSync(join(tmpdir(), "spontra-perf-"));
const cacheDir = join(work, "cache"), log = join(work, "perf.log");
const hold = Number(values["hold-ms"]);

const median = (list: number[]) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] ?? NaN;
const round = (value: number) => Math.round(value * 10) / 10;
const webkit = () => new Set(execFileSync("pgrep", ["-f", "com.apple.WebKit"], { encoding: "utf8" }).trim().split("\n").filter(Boolean));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const safeWebkit = () => { try { return webkit(); } catch { return new Set<string>(); } };
/** Physical footprint, the figure Activity Monitor shows; RSS counts the memory these processes share once each. */
const footprintMb = (pids: string[]) => pids.reduce((sum, pid) => {
  try {
    const match = /Footprint:\s+([\d.]+)\s+(KB|MB|GB)/.exec(execFileSync("footprint", ["-p", pid], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    return sum + (match ? Number(match[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[match[2] as "KB" | "MB" | "GB"] : 0);
  } catch { return sum; }
}, 0);
function folderBytes(path: string): number {
  return readdirSync(path, { withFileTypes: true }).reduce((sum, entry) => {
    const inner = join(path, entry.name);
    return sum + (entry.isDirectory() ? folderBytes(inner) : entry.isFile() ? statSync(inner).size : 0);
  }, 0);
}

type Sample = { page: string; spawnToContentMs: number; processToContentMs: number; webviewContentMs: number; memoryMb: number };
async function launch(): Promise<Sample> {
  const before = safeWebkit();
  rmSync(log, { force: true });
  const spawnedAt = Date.now();
  const child = spawn(join(values.app!, "Contents/MacOS/spontra-desktop"), [], { env: { ...process.env, SPONTRA_CACHE_DIR: cacheDir, SPONTRA_PERF_LOG: log, SPONTRA_PERF_EXIT_AFTER_MS: String(hold), SPONTRA_NO_UPDATE: "1" }, stdio: "ignore" });
  const exited = new Promise(resolve => child.once("exit", resolve));
  await sleep(hold - 800);
  while (!existsSync(log) && Date.now() - spawnedAt < 30000) await sleep(100);
  const started = [...safeWebkit()].filter(pid => !before.has(pid));
  const memoryMb = footprintMb([String(child.pid), ...started]);
  await Promise.race([exited, sleep(hold + 30000)]);
  child.kill();
  const entry = readFileSync(log, "utf8").trim().split("\n").find(row => row.includes('"launch"'));
  if (!entry) throw new Error("the launch reported no content: the page never marked its main content");
  const line = JSON.parse(entry) as { at: number; page: string; processToContentMs: number; webviewContentMs: number };
  return { page: line.page, spawnToContentMs: line.at - spawnedAt, processToContentMs: line.processToContentMs, webviewContentMs: line.webviewContentMs, memoryMb };
}

const runs = Number(values.runs);
const cold: Sample[] = [], warm: Sample[] = [];
for (let run = 0; run < runs; run++) { rmSync(cacheDir, { recursive: true, force: true }); cold.push(await launch()); }
rmSync(cacheDir, { recursive: true, force: true });
await launch();
for (let run = 0; run < runs; run++) warm.push(await launch());

const summary = (samples: Sample[]) => ({ page: samples[0]?.page, spawnToContentMs: round(median(samples.map(s => s.spawnToContentMs))), processToContentMs: round(median(samples.map(s => s.processToContentMs))), webviewContentMs: round(median(samples.map(s => s.webviewContentMs))), memoryMb: round(median(samples.map(s => s.memoryMb))) });
const result = { app: values.app, at: new Date().toISOString(), runs, appMb: round(folderBytes(values.app) / 1024 / 1024), cold: summary(cold), warm: summary(warm), samples: { cold, warm } };
console.log(JSON.stringify({ ...result, samples: undefined }, null, 2));
if (values.out) writeFileSync(values.out, JSON.stringify(result, null, 2) + "\n");
rmSync(work, { recursive: true, force: true });

if (values.gate) {
  const failures = [
    result.warm.spawnToContentMs > BUDGET.warmContentMs * scale && `warm launch ${result.warm.spawnToContentMs} ms`,
    result.cold.spawnToContentMs > BUDGET.coldContentMs * scale && `cold launch ${result.cold.spawnToContentMs} ms`,
    result.warm.memoryMb > BUDGET.memoryMb * scale && `memory ${result.warm.memoryMb} MB`,
    result.appMb > BUDGET.appMb && `app size ${result.appMb} MB`,
  ].filter(Boolean);
  if (failures.length) { console.error(`over budget: ${failures.join(", ")}`); process.exit(1); }
}
