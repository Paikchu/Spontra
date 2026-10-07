import { createHash } from "node:crypto";

export interface MigrationStatement { sql: string; params?: unknown[] }
export interface MigrationDatabase {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  batch(statements: MigrationStatement[]): Promise<void>;
}

type LegacyState = { id: string; report_date: string; generated_at: string; payload: string; updated_at: string };
type HistoryRow = { date: string; generated_at: string; net_liquidation: string; net_deposits: string };
type Archive = { state: LegacyState[]; history: HistoryRow[] };
type Manifest = { source_digest: string; phase: "copied" | "activating" | "active" };
const migrationId = "legacy-portfolio-v1";
const tables = ["portfolio_state", "portfolio_history"];
const operations = ["INSERT", "UPDATE", "DELETE"];

export async function readMigration(database: MigrationDatabase): Promise<Manifest | undefined> {
  return (await database.query<Manifest>("SELECT source_digest, phase FROM portfolio_migration WHERE id = ?", [migrationId]))[0];
}

async function readArchive(database: MigrationDatabase): Promise<Archive> {
  const state = await database.query<LegacyState>("SELECT id, report_date, generated_at, payload, updated_at FROM portfolio_state WHERE id = 'current'");
  const history = await database.query<HistoryRow>("SELECT date, generated_at, net_liquidation, net_deposits FROM portfolio_history ORDER BY date");
  return { state, history };
}

function digest(archive: Archive) { return createHash("sha256").update(JSON.stringify(archive)).digest("hex"); }

export async function freezeLegacyPortfolio(database: MigrationDatabase) {
  await database.batch(tables.flatMap(table => operations.map(operation => ({
    sql: `CREATE TRIGGER IF NOT EXISTS freeze_${table}_${operation.toLowerCase()} BEFORE ${operation} ON ${table}
      BEGIN SELECT RAISE(ABORT, 'Portfolio storage migrated'); END`,
  }))));
}

export async function unfreezeLegacyPortfolio(database: MigrationDatabase) {
  await database.batch(tables.flatMap(table => operations.map(operation => ({ sql: `DROP TRIGGER IF EXISTS freeze_${table}_${operation.toLowerCase()}` }))));
}

/** CI-only caller freezes writes before copying; all target inserts and the marker commit together. */
export async function migrateLegacyPortfolio(source: MigrationDatabase, target: MigrationDatabase, now = new Date()) {
  const previous = await readMigration(target);
  await freezeLegacyPortfolio(source);
  // Once a deployment may have begun, the target is authoritative, even when the caller lost its response.
  if (previous && previous.phase !== "copied") return { status: "already_active", digest: previous.source_digest };
  const existing = await readArchive(target);
  if (previous ? digest(existing) !== previous.source_digest : existing.state.length || existing.history.length) {
    throw new Error("Target portfolio has independent data; migration stopped");
  }
  const archive = await readArchive(source);
  const hash = digest(archive);
  // Check the activation phase inside the write transaction too: another CI run
  // may have activated the service since the reads above.
  const mayCopy = `EXISTS (SELECT 1 FROM portfolio_migration WHERE id = '${migrationId}' AND phase = 'copied')`;
  const statements: MigrationStatement[] = [
    { sql: `INSERT INTO portfolio_migration (id, source_digest, phase, copied_at) VALUES (?, ?, 'copied', ?)
      ON CONFLICT(id) DO UPDATE SET source_digest = excluded.source_digest, copied_at = excluded.copied_at
      WHERE portfolio_migration.phase = 'copied'`, params: [migrationId, hash, now.toISOString()] },
    ...["portfolio_state", "portfolio_history", "portfolio_sync_attempt"].map(table => ({ sql: `DELETE FROM ${table} WHERE ${mayCopy}` })),
  ];
  for (const row of archive.state) {
    const syncedAt = new Date(row.generated_at).toISOString();
    statements.push({ sql: `INSERT INTO portfolio_state (id, report_date, generated_at, payload, updated_at, synced_at, successful_attempt_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${mayCopy}`, params: [row.id, row.report_date, row.generated_at, row.payload, row.updated_at, syncedAt, syncedAt] });
    statements.push({ sql: `INSERT INTO portfolio_sync_attempt (id, started_at, status) SELECT ?, ?, 'success' WHERE ${mayCopy}`, params: [row.id, syncedAt] });
  }
  for (const row of archive.history) statements.push({ sql: `INSERT INTO portfolio_history (date, generated_at, net_liquidation, net_deposits) SELECT ?, ?, ?, ? WHERE ${mayCopy}`,
    params: [row.date, row.generated_at, row.net_liquidation, row.net_deposits] });
  await target.batch(statements);
  const marker = (await readMigration(target))!;
  if (marker.phase !== "copied") return { status: "already_active", digest: marker.source_digest };
  const copied = await readArchive(target);
  if (digest(copied) !== hash) throw new Error("Portfolio migration verification failed");
  return { status: "copied", digest: hash, snapshots: copied.state.length, history: copied.history.length };
}

export async function markPortfolioActivation(database: MigrationDatabase, phase: "activating" | "active") {
  await database.batch([{ sql: "UPDATE portfolio_migration SET phase = ? WHERE id = ?", params: [phase, migrationId] }]);
}

/** Administrative REST access is restricted to the CI migration process, never a Worker runtime. */
export function migrationDatabase(accountId: string, databaseId: string, token: string): MigrationDatabase {
  async function execute(body: { sql: string; params?: unknown[] } | { batch: MigrationStatement[] }) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const payload = await response.json() as { success: boolean; result: Array<{ success: boolean; results: unknown[] }> };
    if (!response.ok || !payload.success || payload.result.some(result => !result.success)) {
      throw new Error(`Portfolio migration database request failed (HTTP ${response.status})`);
    }
    return payload.result;
  }
  return {
    async query<T>(sql: string, params: unknown[] = []) { return (await execute({ sql, params }))[0].results as T[]; },
    async batch(statements) { await execute({ batch: statements }); },
  };
}
