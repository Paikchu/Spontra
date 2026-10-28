import type { AdminMessage, AdminMessages } from '../../../../shared/analysis-contract/admin-messages.ts';
import type { Feature } from '../../../../shared/analysis-contract/business-features.ts';
import type { EventMessage } from '../pipeline/messages.ts';
import type { EventType } from '../pipeline/registry.ts';

/**
 * The admin's inbox (`admin_messages`): which company's feature finished a run, and how. A success is noted when the
 * feature publishes (the pipeline routes the event); a failure when a run fails, and then the company's switch for the
 * feature is turned off, so a failed feature stops retrying on its own and switching it on again is the retry.
 */
const RETENTION_MS = 30 * 24 * 60 * 60_000, LIST_LIMIT = 100;

/** Which feature each AI run kind and pipeline task writes. */
export const KIND_FEATURE: Record<string, Feature> = { guidance: 'reports', findings: 'findings', analyst: 'findings', items: 'findings', explainer: 'explainer', tree: 'tree', valuation: 'valuation' };
export const TASK_FEATURE: Record<string, Feature> = { 'sec-report': 'reports', guidance: 'reports', memory: 'findings', 'company-analysis': 'findings', findings: 'findings', analyst: 'findings', explainer: 'explainer', tree: 'tree', valuation: 'valuation' };
/** The tasks whose failed-input state holds a feature back: cleared when the feature is switched on again. */
export const FEATURE_TASKS = (feature: Feature) => Object.entries(TASK_FEATURE).filter(([, f]) => f === feature).map(([task]) => task);
/** The events that mean a feature published something for a company. */
const PUBLISHED: Partial<Record<EventType, Feature>> = {
  'report.published': 'reports', 'guidance.published': 'reports', 'findings.published': 'findings', 'dossier.published': 'findings',
  'explainer.published': 'explainer', 'tree.published': 'tree', 'items.published': 'findings', 'valuation.published': 'valuation',
};

function noteStatements(db: D1Database, ticker: string, feature: Feature, outcome: AdminMessage['outcome'], detail: string | null, at: string): D1PreparedStatement[] {
  return [
    db.prepare(`UPDATE admin_messages SET count = count + 1, detail = ?, updated_at = ? WHERE id = (
      SELECT id FROM admin_messages WHERE ticker = ? AND feature = ? AND outcome = ? AND read_at IS NULL ORDER BY updated_at DESC LIMIT 1)`)
      .bind(detail, at, ticker, feature, outcome),
    db.prepare(`INSERT INTO admin_messages (id, ticker, feature, outcome, detail, count, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, 1, ?, ? WHERE changes() = 0`)
      .bind(crypto.randomUUID(), ticker, feature, outcome, detail, at, at),
    db.prepare('DELETE FROM admin_messages WHERE updated_at < ?').bind(new Date(Date.parse(at) - RETENTION_MS).toISOString()),
  ];
}

/** Success entries for the publication events in a routed batch, written with the batch. */
export function messageStatements(db: D1Database, events: EventMessage[], at: string): D1PreparedStatement[] {
  return events.flatMap(event => {
    const feature = PUBLISHED[event.type];
    if (!feature || event.ticker === '*') return [];
    const detail = [event.type, event.detail?.form, event.detail?.accession].filter(Boolean).join(' · ');
    return noteStatements(db, event.ticker, feature, 'succeeded', detail, at);
  });
}

/**
 * A failed run of a company's feature: noted in the inbox, and the company's switch turned off. Only generation stops;
 * what was written stays shown (`display` keeps its value). The reports take the findings with them, as the switch does.
 * Never throws: bookkeeping must not fail the work it describes.
 */
export async function recordFeatureFailure(db: D1Database | undefined, ticker: string, feature: Feature | undefined, failure: string, at = new Date().toISOString()): Promise<void> {
  if (!db || !feature || ticker === '*') return;
  const off = (f: Feature) => db.prepare(`INSERT INTO business_feature_settings (ticker, feature, generate, display, updated_at) VALUES (?, ?, 0, 1, ?)
    ON CONFLICT (ticker, feature) DO UPDATE SET generate = 0, display = coalesce(business_feature_settings.display, business_feature_settings.generate, 1), updated_at = excluded.updated_at`)
    .bind(ticker, f, at);
  try {
    await db.batch([...noteStatements(db, ticker, feature, 'failed', failure.slice(0, 1000), at), off(feature), ...(feature === 'reports' ? [off('findings')] : [])]);
  } catch (error) {
    console.warn(JSON.stringify({ event: 'admin-message', ticker, feature, error: error instanceof Error ? error.message : String(error) }));
  }
}

/** The newest entry per company and feature, for the whitelist's feature states. */
export async function latestOutcomes(db: D1Database): Promise<Map<string, Pick<AdminMessage, 'outcome' | 'detail' | 'updatedAt'>>> {
  const { results } = await db.prepare(`SELECT ticker, feature, outcome, detail, max(updated_at) updatedAt FROM admin_messages GROUP BY ticker, feature`)
    .bind().all<{ ticker: string; feature: Feature; outcome: AdminMessage['outcome']; detail: string | null; updatedAt: string }>().catch(() => ({ results: [] }));
  return new Map(results.map(r => [`${r.feature}:${r.ticker}`, { outcome: r.outcome, detail: r.detail, updatedAt: r.updatedAt }]));
}

export async function listMessages(db: D1Database): Promise<AdminMessages> {
  const [rows, unread] = await Promise.all([
    db.prepare(`SELECT id, ticker, feature, outcome, detail, count, created_at createdAt, updated_at updatedAt, read_at readAt FROM admin_messages
      ORDER BY read_at IS NOT NULL, updated_at DESC LIMIT ?`).bind(LIST_LIMIT).all<AdminMessage>(),
    db.prepare('SELECT count(*) n FROM admin_messages WHERE read_at IS NULL').bind().first<{ n: number }>(),
  ]);
  return { messages: rows.results, unread: unread?.n ?? 0 };
}

/** Marks entries read: the ones named, or every unread one. */
export async function markRead(db: D1Database, ids: string[] | null, at = new Date().toISOString()): Promise<void> {
  if (ids) await db.prepare('UPDATE admin_messages SET read_at = ? WHERE read_at IS NULL AND id IN (SELECT value FROM json_each(?))').bind(at, JSON.stringify(ids)).run();
  else await db.prepare('UPDATE admin_messages SET read_at = ? WHERE read_at IS NULL').bind(at).run();
}
