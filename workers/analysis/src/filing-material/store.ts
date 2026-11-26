import type { MaterialBriefState, MaterialFiling, MaterialRef, MaterialSnapshot, MaterialState } from "../../../../shared/analysis-contract/filing-material.ts";
import type { AnalysisEnv } from "../operations.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { outboxStatement } from "../pipeline/outbox.ts";
import { MATERIAL_ARCHIVE_INVENTORY_VERSION, MATERIAL_BRIEF_VERSION, MATERIAL_LAYOUT_VERSION, MATERIAL_VERSION } from "../../../../shared/analysis-contract/filing-material.ts";
import { MATERIAL_PARSER_VERSION } from "../../../../shared/analysis-runtime/filing-material.ts";

export const MATERIAL_PREFIX = "sec-materials/v1/";
export const MATERIAL_PREPARATION_VERSION = `${MATERIAL_VERSION}:${MATERIAL_PARSER_VERSION}:${MATERIAL_LAYOUT_VERSION}:${MATERIAL_ARCHIVE_INVENTORY_VERSION}`;
export const materialStatePrefix = (ticker: string) => `filing-material:state:v1:${ticker}:`;
export const materialStateKey = (ticker: string, accession: string) => `${materialStatePrefix(ticker)}${accession}`;
export const materialPilotKey = (ticker: string, accession: string) => `filing-material:pilot:v1:${ticker}:${accession}`;
export async function isPilotMaterial(env: Pick<AnalysisEnv, "DB">, ticker: string, accession: string): Promise<boolean> {
  return !!await env.DB!.prepare("SELECT 1 FROM sec_cache WHERE cache_key=?").bind(materialPilotKey(ticker, accession)).first();
}
export const materialReconciliationKey = (ticker: string, accession: string, sourceId: string, sourceHash: string) => `filing-material:reconciliation:v1:${ticker}:${accession}:${sourceId}:${sourceHash}`;
export const materialRecoveryKey = (ticker: string, accession: string) => `filing-material:recovery:v1:${ticker}:${accession}`;
export const materialBase = (ref: MaterialRef) => `${MATERIAL_PREFIX}${ref.ticker}/${ref.accession}/${ref.version}`;
export const materialSnapshotKey = (ref: MaterialRef) => `${materialBase(ref)}/index.json`;
export const materialBriefStateKey = (ticker: string, accession: string, version: string) => `filing-material:brief:v1:${ticker}:${accession}:${version}`;
export const materialBriefBase = (ref: MaterialRef) => `${materialBase(ref)}/brief/${MATERIAL_BRIEF_VERSION}`;
export const materialBriefJsonKey = (ref: MaterialRef) => `${materialBriefBase(ref)}/brief.json`;
export const materialBriefMarkdownKey = (ref: MaterialRef) => `${materialBriefBase(ref)}/brief.md`;
const leaseKey = (filing: MaterialFiling) => `filing-material:lease:v1:${filing.ticker}:${filing.accession}`;

export async function materialDigest(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), n => n.toString(16).padStart(2, "0")).join("");
}

export async function readFilingMaterialState(env: Pick<AnalysisEnv, "DB">, ticker: string, accession: string): Promise<MaterialState | null> {
  return (await new D1SecRepository(env.DB!).getCache<MaterialState>(materialStateKey(ticker, accession)))?.payload ?? null;
}

export async function getFilingMaterial(env: Pick<AnalysisEnv, "DB">, ticker: string, accession: string): Promise<MaterialState | null> {
  const state = (await new D1SecRepository(env.DB!).getCache<MaterialState>(materialStateKey(ticker, accession)))?.payload ?? null;
  if (state?.status === "ready" && state.preparationVersion !== MATERIAL_PREPARATION_VERSION) return requestFilingMaterial(env, state.filing);
  return state;
}

export async function listFilingMaterials(env: Pick<AnalysisEnv, "DB">, ticker: string): Promise<MaterialState[]> {
  const prefix = materialStatePrefix(ticker);
  const rows = await env.DB!.prepare("SELECT payload FROM sec_cache WHERE cache_key >= ? AND cache_key < ? ORDER BY fetched_at DESC")
    .bind(prefix, `${prefix}\uffff`).all<{ payload: string }>();
  return rows.results.map(row => JSON.parse(row.payload));
}

export async function readMaterialSnapshot(env: { SEC_FILINGS: { get(key: string): Promise<{ text(): Promise<string> } | null> } }, ref: MaterialRef): Promise<MaterialSnapshot> {
  const object = await env.SEC_FILINGS.get(materialSnapshotKey(ref));
  if (!object) throw new Error(`MATERIAL_VERSION_MISSING:${ref.ticker}:${ref.accession}:${ref.version}`);
  const snapshot: MaterialSnapshot = JSON.parse(await object.text());
  if (snapshot.ref.ticker !== ref.ticker || snapshot.ref.accession !== ref.accession || snapshot.ref.version !== ref.version) throw new Error("MATERIAL_VERSION_MISMATCH");
  return snapshot;
}

export async function claimMaterialLease(env: Pick<AnalysisEnv, "DB">, filing: MaterialFiling, owner: string): Promise<boolean> {
  const now = Date.now(), payload = JSON.stringify({ owner, expiresAt: now + 15 * 60_000 });
  const result = await env.DB!.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at WHERE json_extract(sec_cache.payload, '$.expiresAt') <= ?")
    .bind(leaseKey(filing), payload, new Date(now).toISOString(), now).run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function ownsMaterialLease(env: Pick<AnalysisEnv, "DB">, filing: MaterialFiling, owner: string): Promise<boolean> {
  return !!await env.DB!.prepare("SELECT 1 FROM sec_cache WHERE cache_key = ? AND json_extract(payload, '$.owner') = ? AND json_extract(payload, '$.expiresAt') > ?")
    .bind(leaseKey(filing), owner, Date.now()).first();
}

export async function releaseMaterialLease(env: Pick<AnalysisEnv, "DB">, filing: MaterialFiling, owner: string): Promise<void> {
  await env.DB!.prepare("DELETE FROM sec_cache WHERE cache_key = ? AND json_extract(payload, '$.owner') = ?").bind(leaseKey(filing), owner).run();
}

export async function writeMaterialState(env: Pick<AnalysisEnv, "DB">, state: MaterialState): Promise<void> {
  const ticker = state.filing.ticker, accession = state.filing.accession;
  await new D1SecRepository(env.DB!).setCache(materialStateKey(ticker, accession), state, new Date().toISOString());
}

export async function requestFilingMaterial(env: Pick<AnalysisEnv, "DB">, filing: MaterialFiling): Promise<MaterialState> {
  const existing = (await new D1SecRepository(env.DB!).getCache<MaterialState>(materialStateKey(filing.ticker, filing.accession)))?.payload;
  if (existing && await isPilotMaterial(env, filing.ticker, filing.accession)) return existing;
  if (existing && (existing.status !== "ready" || existing.preparationVersion === MATERIAL_PREPARATION_VERSION)) return existing;
  const state: MaterialState = { status: "preparing", filing, progress: "awaiting accession archive" };
  const at = new Date().toISOString(), db = env.DB!;
  await db.batch([
    db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at")
      .bind(materialStateKey(filing.ticker, filing.accession), JSON.stringify(state), at),
    outboxStatement(db, { type: "filing.material.requested", ticker: filing.ticker, cik: filing.cik,
      detail: { accession: filing.accession, form: filing.form } }, at, { sql: "changes() > 0", binds: [] }),
  ]);
  return state;
}

export async function getMaterialBriefState(env: Pick<AnalysisEnv, "DB">, ref: MaterialRef): Promise<MaterialBriefState> {
  return (await new D1SecRepository(env.DB!).getCache<MaterialBriefState>(materialBriefStateKey(ref.ticker, ref.accession, ref.version)))?.payload ?? { status: "idle" };
}

export async function writeMaterialBriefState(env: Pick<AnalysisEnv, "DB">, ref: MaterialRef, state: MaterialBriefState): Promise<void> {
  await new D1SecRepository(env.DB!).setCache(materialBriefStateKey(ref.ticker, ref.accession, ref.version), state, new Date().toISOString());
}

export async function publishMaterialState(env: Pick<AnalysisEnv, "DB">, state: Extract<MaterialState, { status: "ready" }>, owner: string, causeId?: string): Promise<boolean> {
  const db = env.DB!, at = state.preparedAt, filing = state.filing;
  const pilot = await isPilotMaterial(env, filing.ticker, filing.accession);
  const results = await db.batch([
    db.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM sec_cache WHERE cache_key = ? AND json_extract(payload, '$.owner') = ? AND json_extract(payload, '$.expiresAt') > ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at")
      .bind(materialStateKey(filing.ticker, filing.accession), JSON.stringify(state), at, leaseKey(filing), owner, Date.now()),
    outboxStatement(db, { type: "filing.material.ready", ticker: filing.ticker, cik: filing.cik, causeId,
      detail: { accession: filing.accession, form: filing.form, ...(pilot ? { mode: "shadow-pilot" } : {}) } }, at, { sql: "changes() > 0", binds: [] }),
  ]);
  return (results[0]?.meta?.changes ?? 0) > 0;
}
