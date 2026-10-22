import type { TranslationEntry, TranslationsAdmin } from "../../../../shared/analysis-contract/translations-admin.ts";
import type { Locale } from "../../../../shared/analysis-runtime/locale.ts";
import type { AnalysisEnv } from "../operations.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { readSources, sha256, tableKey, TRANSLATION_VERSION, type TranslationSource } from "./translate.ts";

const MAX_ENTRIES = 1500;
const DEFAULT_DAILY_CALLS = 300;
type Row = { source_sha256: string; text: string | null; status: "ready" | "rejected"; problems: string | null; created_at: string };

/**
 * What the admin shows for one company's Chinese: per resource how much is translated and when its table was
 * written, today's model calls, the run in progress, and every string with its translation or the reasons it was
 * rejected. Read-only; computed from the same sources the translator reads.
 */
export async function translationsAdmin(env: AnalysisEnv, ticker: string, now = new Date(), locale: Locale = "zh-CN",
  read: () => Promise<TranslationSource[]> = () => readSources(env.DB!, ticker)): Promise<TranslationsAdmin> {
  const db = env.DB!;
  const repository = new D1SecRepository(db);
  const sources = await read();
  const unique = [...new Set(sources.flatMap(s => s.strings))];
  const hashes = await Promise.all(unique.map(sha256));
  const hashOf = new Map(unique.map((text, i) => [text, hashes[i]!]));
  const rows = new Map<string, Row>();
  for (let i = 0; i < hashes.length; i += 500) {
    for (const row of (await db.prepare("SELECT source_sha256, text, status, problems, created_at FROM i18n_strings WHERE locale = ? AND source_sha256 IN (SELECT value FROM json_each(?))")
      .bind(locale, JSON.stringify(hashes.slice(i, i + 500))).all<Row>()).results) rows.set(row.source_sha256, row);
  }
  const day = now.toISOString().slice(0, 10);
  const [budget, started] = await Promise.all([
    db.prepare("SELECT units FROM feature_budget WHERE day = ? AND feature = 'translate-calls'").bind(day).first<{ units: number }>().catch(() => null),
    repository.getCache<{ instanceId: string; startedAt: string }>(`pipeline:workflow:translate:${ticker}`).catch(() => null),
  ]);
  const entries: TranslationEntry[] = [];
  const resources = await Promise.all(sources.map(async source => {
    let translated = 0, rejected = 0;
    for (const text of source.strings) {
      const row = rows.get(hashOf.get(text)!);
      const status = row?.status ?? "pending";
      if (status === "ready") translated++; else if (status === "rejected") rejected++;
      entries.push({ resource: source.resource, scope: source.scope, source: text, text: row?.text ?? null, status, problems: row?.problems ? JSON.parse(row.problems) as string[] : [], at: row?.created_at ?? null });
    }
    const table = (await repository.getCache<{ at: string }>(tableKey(locale, source.resource, ticker, source.scope)).catch(() => null))?.payload;
    return { resource: source.resource, scope: source.scope, total: source.strings.length, translated, rejected, publishedAt: table?.at ?? null };
  }));
  const order = { rejected: 0, pending: 1, ready: 2 } as const;
  entries.sort((a, b) => order[a.status] - order[b.status]);
  return {
    ticker, locale, version: TRANSLATION_VERSION, enabled: env.TRANSLATION_ENABLED !== "false" && !!env.DEEPSEEK_API_KEY,
    budget: { day, used: budget?.units ?? 0, cap: Number(env.TRANSLATION_DAILY_CALLS) || DEFAULT_DAILY_CALLS },
    run: started?.payload ?? null,
    resources: resources.filter(r => r.total > 0 || r.publishedAt),
    entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES,
  };
}
