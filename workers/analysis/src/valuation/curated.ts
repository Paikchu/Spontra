import { z } from "zod";
import type { ManagementTargetSet, StoredManagementTargets, ValuationCompanyInputs } from "../../../../shared/analysis-contract/valuation.ts";
import { MANAGEMENT_TARGET_METRICS } from "../../../../shared/analysis-contract/valuation.ts";

/**
 * Valuation inputs an admin maintains per company, kept in D1
 * `valuation_company_inputs`: the comparable set the cross-check tries first, and management's public targets with
 * their sources. Code names no company; every company without a row is valued the same way, from its business-tag
 * peers and without a management case. Both inputs pass the same schema on write and on read, so a stored typo is
 * refused at the admin, not found in a run.
 */
const ticker = z.string().regex(/^[A-Z][A-Z0-9.-]{0,11}$/);
const peersSchema = z.array(ticker).min(1).max(12);
const source = z.object({ id: z.string().min(3).max(80), title: z.string().min(3).max(300), url: z.string().url().startsWith("https://"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const target = z.object({
  metric: z.enum(MANAGEMENT_TARGET_METRICS), segment: z.string().max(80).optional(), fiscalYear: z.number().int().min(2000).max(2100),
  value: z.number().finite(), unit: z.enum(["currency", "ratio", "per_share"]), basis: z.enum(["gaap", "non_gaap"]), kind: z.enum(["target", "floor", "ceiling", "derived"]), sourceIds: z.array(z.string()).min(1).max(6), note: z.string().max(600).optional(),
});
const targetsSchema = z.object({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), sources: z.array(source).min(1).max(20), targets: z.array(target).min(1).max(60) }).strict();
/** A target set older than this before the research date is no longer management's current plan and is not used. */
const MANAGEMENT_TARGETS_MAX_AGE_DAYS = 540;
const DAY = 86_400_000;

const issues = (error: z.ZodError) => error.issues.slice(0, 3).map(i => `${i.path.join(".") || "value"}: ${i.message}`).join("; ");

/** A company's comparable set: distinct tickers, never the company itself. */
export function parsePeers(company: string, value: unknown): string[] {
  const parsed = peersSchema.safeParse(value);
  if (!parsed.success) throw new Error(`可比公司：${issues(parsed.error)}`);
  const peers = [...new Set(parsed.data)];
  if (peers.includes(company)) throw new Error(`可比公司：${company} 不能是自己的可比公司`);
  return peers;
}

/** Management's targets: every target cites a source the set lists, and no source id repeats. */
export function parseTargets(value: unknown): StoredManagementTargets {
  const parsed = targetsSchema.safeParse(value);
  if (!parsed.success) throw new Error(`管理层目标：${issues(parsed.error)}`);
  const set = parsed.data;
  const ids = new Set(set.sources.map(s => s.id));
  if (ids.size !== set.sources.length) throw new Error("管理层目标：来源 id 重复");
  for (const t of set.targets) for (const id of t.sourceIds) if (!ids.has(id)) throw new Error(`管理层目标：${t.metric} FY${t.fiscalYear} 引用了不存在的来源 ${id}`);
  return set;
}

type Row = { peers_json: string | null; targets_json: string | null; reassess: number; updated_at: string };

/** The company's stored inputs; a row that no longer passes the schema reads as absent rather than failing the run. */
export async function readValuationCompanyInputs(db: D1Database, company: string): Promise<Omit<ValuationCompanyInputs, "fiscalYearEndMonth">> {
  const row = await db.prepare("SELECT peers_json, targets_json, reassess, updated_at FROM valuation_company_inputs WHERE ticker = ?").bind(company).first<Row>();
  const read = <T>(text: string | null, parse: (value: unknown) => T): T | null => { if (!text) return null; try { return parse(JSON.parse(text)); } catch { return null; } };
  return { ticker: company, peers: read(row?.peers_json ?? null, v => parsePeers(company, v)), targets: read(row?.targets_json ?? null, parseTargets), reassess: row?.reassess === 1, updatedAt: row?.updated_at ?? null };
}

/** Saves the inputs at once; null clears peers or targets. A row with nothing set is deleted. */
export async function writeValuationCompanyInputs(db: D1Database, company: string, input: { peers: unknown; targets: unknown; reassess: boolean }, now: string): Promise<Omit<ValuationCompanyInputs, "fiscalYearEndMonth">> {
  const peers = input.peers == null ? null : parsePeers(company, input.peers);
  const targets = input.targets == null ? null : parseTargets(input.targets);
  const kept = !!peers || !!targets || input.reassess;
  if (!kept) await db.prepare("DELETE FROM valuation_company_inputs WHERE ticker = ?").bind(company).run();
  else await db.prepare(`INSERT INTO valuation_company_inputs (ticker, peers_json, targets_json, reassess, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(ticker) DO UPDATE SET peers_json = excluded.peers_json, targets_json = excluded.targets_json, reassess = excluded.reassess, updated_at = excluded.updated_at`)
    .bind(company, peers ? JSON.stringify(peers) : null, targets ? JSON.stringify(targets) : null, input.reassess ? 1 : 0, now).run();
  return { ticker: company, peers, targets, reassess: input.reassess, updatedAt: kept ? now : null };
}

/**
 * The target set a run may use: the fiscal-year end comes from the company's filings, not from the stored set, and a
 * set older than MANAGEMENT_TARGETS_MAX_AGE_DAYS before the research date is left out. The notes say why a stored set
 * was not used.
 */
export function managementTargetSet(company: string, stored: StoredManagementTargets | null, fiscalYearEndMonth: number | null, researchAsOf: string): { set: ManagementTargetSet | null; notes: string[] } {
  if (!stored) return { set: null, notes: [] };
  if (fiscalYearEndMonth == null || fiscalYearEndMonth < 1 || fiscalYearEndMonth > 12) return { set: null, notes: [`management targets as of ${stored.asOf} not used: the filings give no fiscal-year end to place them on`] };
  const age = Math.floor((Date.parse(researchAsOf.slice(0, 10)) - Date.parse(stored.asOf)) / DAY);
  if (age > MANAGEMENT_TARGETS_MAX_AGE_DAYS) return { set: null, notes: [`management targets as of ${stored.asOf} not used: ${age} days before the research date, past the ${MANAGEMENT_TARGETS_MAX_AGE_DAYS}-day limit`] };
  return { set: { ticker: company, fiscalYearEndMonth, ...stored }, notes: [] };
}
