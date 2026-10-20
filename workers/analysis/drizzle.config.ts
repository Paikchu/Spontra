import { defineConfig } from "drizzle-kit";

/**
 * The analysis data model belongs to this Worker, so its generated migrations land beside it.
 * `db/schema.ts` stays where it is — it is the schema source, imported by nothing at runtime.
 */
export default defineConfig({
  out: "./workers/analysis/migrations",
  schema: "./workers/analysis/src/db/schema.ts",
  dialect: "sqlite",
});
