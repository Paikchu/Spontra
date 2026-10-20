import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const ANALYSIS_WORKER_CONFIG_PATH = "workers/analysis/wrangler.jsonc";

/**
 * Deploying the Worker and applying D1 migrations are two separate commands, and nothing used to
 * notice when only the first one ran. A catalog that wrote a new `unit_family` shipped against a
 * database whose CHECK constraint still rejected it, so every fundamentals sync failed on the
 * constraint while the stored snapshot stayed a catalog version behind — which in turn marked it
 * permanently stale, so every single request queued another doomed sync. This check compares the
 * migrations in the build against the ones the database records and refuses a deploy that would
 * put newer code on an older schema.
 */

const execFileAsync = promisify(execFile);

// Spontra Analysis Worker owns the analysis database and its migrations, so this check moved here with
// them. It still only needs a config naming a DB binding with a migrations_dir, and the two
// override variables are kept so existing scripts and tests keep working unchanged.
const configPath = process.env.SEC_WRANGLER_CONFIG ?? process.env.SEC_WEB_WRANGLER_CONFIG ?? ANALYSIS_WORKER_CONFIG_PATH;
// `npx` resolves the pinned devDependency; the override lets a test stand in for the real CLI.
const [wranglerCommand, ...wranglerArgs] = (process.env.SEC_WRANGLER_BIN ?? process.env.SEC_WEB_WRANGLER_BIN ?? "npx wrangler").split(" ");

// The Web Worker's config is generated JSON; Spontra Analysis's is the committed JSONC. Wrangler's
// JSONC allows whole-line comments, and value strings such as URLs keep their slashes.
const config = JSON.parse((await readFile(configPath, "utf8")).replace(/^\s*\/\/.*$/gm, "")) as {
  d1_databases?: Array<{
    binding: string;
    database_name?: string;
    migrations_dir?: string;
    migrations_table?: string;
  }>;
};

const database = config.d1_databases?.find((binding) => binding.binding === "DB");
if (!database?.database_name || !database.migrations_dir) {
  throw new Error(`${configPath} has no named DB D1 binding with a migrations_dir`);
}

const databaseName = database.database_name;
const migrationsDirectory = resolve(dirname(configPath), database.migrations_dir);
const migrationsTable = database.migrations_table ?? "d1_migrations";

const bundled = (await readdir(migrationsDirectory)).filter((entry) => entry.endsWith(".sql")).sort();
const applied = await readAppliedMigrations();
const unapplied = bundled.filter((name) => !applied.has(name));
const unknown = [...applied].filter((name) => !bundled.includes(name)).sort();
const problems: string[] = [];

if (unapplied.length) {
  problems.push(
    `is behind this build by ${unapplied.length} migration(s): ${unapplied.join(", ")}`,
    `  apply them first: npx wrangler d1 migrations apply ${databaseName} --remote --config ${configPath}`,
  );
}

if (unknown.length) {
  // The reverse drift: the build predates migrations the database already ran, so its schema
  // assumptions are the stale ones. Rebuilding from the branch that owns them is the fix.
  problems.push(`has ${unknown.length} migration(s) this build does not carry: ${unknown.join(", ")}`);
}

if (problems.length) {
  throw new Error([`D1 database ${databaseName} is not ready for this build:`, ...problems.map((problem) => `  - ${problem}`)].join("\n"));
}

console.log(JSON.stringify({
  configPath,
  databaseName,
  migrationsDirectory,
  bundledMigrations: bundled.length,
  appliedMigrations: applied.size,
  latestMigration: bundled.at(-1) ?? null,
}));

async function readAppliedMigrations(): Promise<Set<string>> {
  const args = [
    ...wranglerArgs,
    "d1",
    "execute",
    databaseName,
    "--remote",
    "--json",
    "--config",
    configPath,
    "--command",
    `SELECT name FROM ${migrationsTable}`,
  ];

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(wranglerCommand!, args));
  } catch (error) {
    // A database that has never been migrated has no bookkeeping table, which is drift the caller
    // can still fix by applying everything. Any other failure is the check itself being broken.
    const output = `${describe(error)}${readStream(error, "stdout")}${readStream(error, "stderr")}`;
    if (/no such table/i.test(output)) return new Set();
    throw new Error(`Could not read applied migrations from ${databaseName}: ${output.trim()}`);
  }

  // Wrangler keeps its banner and warnings on stderr, but the slice makes the parse independent
  // of anything it decides to print ahead of the payload.
  const payload = JSON.parse(stdout.slice(stdout.indexOf("["))) as Array<{ results?: Array<{ name?: unknown }> }>;
  return new Set(
    payload
      .flatMap((result) => result.results ?? [])
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0),
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readStream(error: unknown, stream: "stdout" | "stderr"): string {
  const value = (error as Record<string, unknown> | null)?.[stream];
  return typeof value === "string" ? value : "";
}
