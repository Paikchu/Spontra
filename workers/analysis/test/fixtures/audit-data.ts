import type { PublicBusinessFlow } from "../../../../shared/analysis-contract/business-flow.ts";
export const auditFlow: PublicBusinessFlow = { schemaVersion: "business-flow.v1", ticker: "ACME", fetchedAt: null, quarters: [["2026-01-01", "2026-03-31"], ["2026-04-01", "2026-06-30"]].map(([start, end]) => {
  const amount = (value: number) => ({ value: String(value), basis: "reported" as const, definition: "", comparabilityKey: "same", sourceIds: ["s1"], lineage: [{ accession: "s1", url: "https://www.sec.gov/Archives/edgar/data/1/report.htm", concept: "Revenue", contextId: "c1", periodStart: start!, periodEnd: end!, dimensions: {}, parserVersion: "test" }] });
  return { id: end!, label: end!, periodStart: start!, periodEnd: end!, periodType: "3M" as const, currency: "USD", scale: 1, incomeModel: "standard" as const, basisLabel: "reported", reportedAt: null,
    figures: { revenue: amount(100), cost: amount(40), gross: amount(60), operatingExpenses: amount(20), operating: amount(40), other: amount(0), pretax: amount(40), tax: amount(10), net: amount(30) },
    segmentsComplete: true, segments: [{ id: "total", name: "Total", revenue: amount(100), description: "", products: [], customers: null, monetization: null, disclosure: "", sourceIds: ["s1"] }], sources: [{ id: "s1", title: "10-Q", url: "https://www.sec.gov/Archives/edgar/data/1/report.htm", publishedAt: null }] };
}) };


/** Minimal read-only D1 fixture with ACME on the admin whitelist; fault injection happens before each query returns. */
export function auditDb(options: { fail?: (sql: string, binds: unknown[]) => boolean; audits?: unknown[]; quarters?: unknown[]; cache?: Record<string, unknown>; whitelist?: string[] } = {}) {
  const writes: Array<{ sql: string; binds: unknown[] }> = [];
  const reads: string[] = [];
  const cache = options.cache ?? {};
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const check = () => { reads.push(sql); if (options.fail?.(sql, binds)) throw new Error("injected read failure"); };
      const statement = {
        bind(...values: unknown[]) { binds = values; return statement; },
        async first() {
          check();
          if (sql.includes("SELECT COALESCE(")) return { cik: "0000000001" };
          if (sql.includes("SELECT v.payload_json")) return { payload_json: JSON.stringify(auditFlow) };
          if (sql.includes("sec_cache") && typeof binds[0] === "string" && binds[0] in cache) return { payload: JSON.stringify(cache[binds[0]]), fetchedAt: "2026-06-30T00:00:00Z" };
          return null;
        },
        async all() {
          check();
          if (sql.includes("json_remove(payload")) return { results: (options.audits ?? []).map(value => ({ payload: JSON.stringify(value) })) };
          if (sql.includes("SELECT payload FROM sec_cache WHERE cache_key LIKE")) return { results: (options.quarters ?? []).map(value => ({ payload: JSON.stringify(value) })) };
          if (sql.includes("FROM financial_company_settings")) return { results: (options.whitelist ?? ["ACME"]).map(ticker => ({ ticker, enabled: 1 })) };
          return { results: [] };
        },
        async run() { writes.push({ sql, binds }); return { success: true, meta: { changes: 1 } }; },
      };
      return statement;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) { return Promise.all(statements.map(statement => statement.run())); },
  } as unknown as D1Database;
  return { db, writes, reads, cache };
}
