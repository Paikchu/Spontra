import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { migrateLegacyPortfolio, markPortfolioActivation, unfreezeLegacyPortfolio, type MigrationDatabase } from "../scripts/portfolio-migration.ts";

function database(schema: string) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL(schema, import.meta.url), "utf8"));
  const db: MigrationDatabase = {
    async query<T>(sql: string, params: unknown[] = []) { return sqlite.prepare(sql).all(...params as SQLInputValue[]) as T[]; },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        for (const { sql, params = [] } of statements) sqlite.prepare(sql).run(...params as SQLInputValue[]);
        sqlite.exec("COMMIT");
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  return { sqlite, db };
}

test("migration freezes old writes, preserves the full payload/history, and retries without overwriting active data", async () => {
  const source = database("../drizzle/0006_gigantic_pepper_potts.sql");
  const target = database("../workers/sec-cron/migrations/0001_portfolio.sql");
  try {
    const payload = JSON.stringify({ trades: [{ tradeId: "historical" }], capitalFlows: { accountId: "private", flows: [{ amount: 123 }] } });
    source.sqlite.prepare("INSERT INTO portfolio_state VALUES ('current', '2026-10-05', '2026-10-06T06:01:00Z', ?, '2026-10-06 06:01:00')").run(payload);
    source.sqlite.exec("INSERT INTO portfolio_history VALUES ('2026-10-06', '2026-10-06T06:01:00Z', '1000', '500')");
    const first = await migrateLegacyPortfolio(source.db, target.db);
    assert.equal(first.status, "copied");
    assert.equal(first.history, 1);
    assert.equal(target.sqlite.prepare("SELECT payload FROM portfolio_state").get()?.payload, payload);
    assert.equal(target.sqlite.prepare("SELECT synced_at FROM portfolio_state").get()?.synced_at, "2026-10-06T06:01:00.000Z");
    assert.throws(() => source.sqlite.exec("UPDATE portfolio_state SET report_date = '2026-10-06'"), /storage migrated/);
    assert.throws(() => source.sqlite.exec("DELETE FROM portfolio_history"), /storage migrated/);
    assert.equal((await migrateLegacyPortfolio(source.db, target.db)).digest, first.digest);
    await markPortfolioActivation(target.db, "activating");
    target.sqlite.exec("UPDATE portfolio_state SET payload = '{\"new\":true}'");
    assert.equal((await migrateLegacyPortfolio(source.db, target.db)).status, "already_active");
    assert.equal(target.sqlite.prepare("SELECT payload FROM portfolio_state").get()?.payload, '{"new":true}');
  } finally { source.sqlite.close(); target.sqlite.close(); }
});

test("before activation, unfreezing restores old writes and a later migration recopies their updates", async () => {
  const source = database("../drizzle/0006_gigantic_pepper_potts.sql");
  const target = database("../workers/sec-cron/migrations/0001_portfolio.sql");
  try {
    await migrateLegacyPortfolio(source.db, target.db);
    await unfreezeLegacyPortfolio(source.db);
    source.sqlite.exec("INSERT INTO portfolio_state VALUES ('current', '2026-10-05', '2026-10-06T06:01:00Z', '{}', '2026-10-06 06:01:00')");
    const copied = await migrateLegacyPortfolio(source.db, target.db);
    assert.equal(copied.snapshots, 1);
    assert.throws(() => source.sqlite.exec("DELETE FROM portfolio_state"), /storage migrated/);
  } finally { source.sqlite.close(); target.sqlite.close(); }
});

test("failed target transaction keeps the previous import intact", async () => {
  const source = database("../drizzle/0006_gigantic_pepper_potts.sql");
  const target = database("../workers/sec-cron/migrations/0001_portfolio.sql");
  try {
    await migrateLegacyPortfolio(source.db, target.db);
    await unfreezeLegacyPortfolio(source.db);
    source.sqlite.exec("INSERT INTO portfolio_state VALUES ('current', '2026-10-05', '2026-10-06T06:01:00Z', '{}', '2026-10-06 06:01:00')");
    target.sqlite.exec("CREATE TRIGGER fail_import BEFORE INSERT ON portfolio_state BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    await assert.rejects(migrateLegacyPortfolio(source.db, target.db), /test failure/);
    assert.equal(target.sqlite.prepare("SELECT COUNT(*) AS n FROM portfolio_state").get()?.n, 0);
    await unfreezeLegacyPortfolio(source.db);
    source.sqlite.exec("DELETE FROM portfolio_state");
  } finally { source.sqlite.close(); target.sqlite.close(); }
});

test("activation by another release between copy reads and writes never overwrites new service data", async () => {
  const source = database("../drizzle/0006_gigantic_pepper_potts.sql");
  const target = database("../workers/sec-cron/migrations/0001_portfolio.sql");
  try {
    source.sqlite.exec("INSERT INTO portfolio_state VALUES ('current', '2026-10-05', '2026-10-06T06:01:00Z', '{}', '2026-10-06 06:01:00')");
    await migrateLegacyPortfolio(source.db, target.db);
    const racingTarget: MigrationDatabase = {
      query: target.db.query,
      async batch(statements) {
        await markPortfolioActivation(target.db, "active");
        target.sqlite.exec("UPDATE portfolio_state SET payload = '{\"new\":true}'");
        await target.db.batch(statements);
      },
    };
    assert.equal((await migrateLegacyPortfolio(source.db, racingTarget)).status, "already_active");
    assert.equal(target.sqlite.prepare("SELECT payload FROM portfolio_state").get()?.payload, '{"new":true}');
  } finally { source.sqlite.close(); target.sqlite.close(); }
});
