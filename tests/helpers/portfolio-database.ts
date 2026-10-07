import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { PortfolioDatabase } from "../../workers/sec-cron/portfolio-store.ts";

export function createPortfolioDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../../workers/sec-cron/migrations/0001_portfolio.sql", import.meta.url), "utf8"));
  const queries = new WeakMap<object, { sql: string; values: unknown[] }>();
  const database: PortfolioDatabase = {
    prepare(sql) {
      const query = { sql, values: [] as unknown[] };
      const statement = {
        bind(...values: unknown[]) { query.values = values; return this; },
        async first<T>() { return (sqlite.prepare(sql).get(...query.values as SQLInputValue[]) as T | undefined) ?? null; },
      };
      queries.set(statement, query);
      return statement;
    },
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(statement => {
          const query = queries.get(statement)!;
          const result = sqlite.prepare(query.sql).run(...query.values as SQLInputValue[]);
          return { meta: { changes: Number(result.changes) } };
        });
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { database, sqlite };
}
