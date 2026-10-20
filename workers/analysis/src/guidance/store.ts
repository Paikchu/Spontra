import type { GuidanceMaterialKind, GuidanceSourceKind } from "../../../../shared/analysis-contract/guidance.ts";
import { normalizeForMatch, type VerifiedGuidance } from "../../../../shared/analysis-runtime/guidance.ts";
import { sha256 } from "../company-analysis/api.ts";
import { GUIDANCE_EXTRACTOR_VERSION, guidanceWorkflowSuffix } from "./extract.ts";
import type { FoundMaterial } from "./sources.ts";

/** Longer than any Workflow runs: transcript waits of three days plus a few days waiting for the model budget. */
const STALLED_EVENT_MS = 14 * 86_400_000;

export type TextBucket = {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
};

export type EarningsEventRow = { ticker: string; accession: string; event_date: string; status: string; transcript_status: string };
export type MaterialRow = {
  id: string; ticker: string; event_accession: string; kind: GuidanceMaterialKind; source_kind: GuidanceSourceKind;
  title: string; source_url: string; published_at: string; text_key: string | null; status: "stored" | "extracted" | "unsupported" | "failed";
};
export type StoredMaterial = { id: string; kind: GuidanceMaterialKind; status: MaterialRow["status"] };

export class GuidanceStore {
  private readonly db: D1Database;
  private readonly bucket: TextBucket;
  constructor(db: D1Database, bucket: TextBucket) { this.db = db; this.bucket = bucket; }

  /** Idempotent: an event already known keeps its status. */
  async recordEvents(ticker: string, events: Array<{ accession: string; eventDate: string }>, now: string): Promise<void> {
    if (!events.length) return;
    await this.db.batch(events.map(e => this.db.prepare(`INSERT INTO earnings_events (ticker,accession,event_date,status,updated_at) VALUES (?,?,?,'queued',?)
      ON CONFLICT(ticker,accession) DO NOTHING`).bind(ticker, e.accession, e.eventDate, now)));
  }

  /**
   * Events to start a Workflow for: new ones first, then every event last run under an older extractor version,
   * so raising the version re-extracts the whole history with no migration. The Workflow id ends with the version
   * it ran under. A `started` event is left to its Workflow unless that has been silent long enough to be dead. An event
   * queued again (a transcript arrived after its run) still names its last instance, so its next one needs a new id.
   */
  async queuedEvents(tickers: string[], limit: number, version = GUIDANCE_EXTRACTOR_VERSION, now = Date.now()): Promise<Array<EarningsEventRow & { workflow_instance_id: string | null }>> {
    if (!tickers.length) return [];
    const stalled = new Date(now - STALLED_EVENT_MS).toISOString();
    const { results } = await this.db.prepare(`SELECT ticker,accession,event_date,status,transcript_status,workflow_instance_id FROM earnings_events
      WHERE ticker IN (${tickers.map(() => "?").join(",")}) AND (status='queued'
        OR ((status IN ('extracted','complete','failed') OR (status='started' AND updated_at < ?)) AND (workflow_instance_id IS NULL OR workflow_instance_id NOT LIKE ?)))
      ORDER BY status='queued' DESC, event_date DESC LIMIT ?`).bind(...tickers, stalled, `%-${guidanceWorkflowSuffix(version)}`, limit).all<EarningsEventRow & { workflow_instance_id: string | null }>();
    return results;
  }

  async updateEvent(ticker: string, accession: string, fields: { status?: string; transcriptStatus?: string; workflowInstanceId?: string }, now: string): Promise<void> {
    await this.db.prepare(`UPDATE earnings_events SET status=COALESCE(?,status), transcript_status=COALESCE(?,transcript_status),
      workflow_instance_id=COALESCE(?,workflow_instance_id), updated_at=? WHERE ticker=? AND accession=?`)
      .bind(fields.status ?? null, fields.transcriptStatus ?? null, fields.workflowInstanceId ?? null, now, ticker, accession).run();
  }

  async events(ticker: string): Promise<EarningsEventRow[]> {
    const { results } = await this.db.prepare(`SELECT ticker,accession,event_date,status,transcript_status FROM earnings_events WHERE ticker=? ORDER BY event_date`).bind(ticker).all<EarningsEventRow>();
    return results;
  }

  /**
   * Stores text under the hash of its normalized content, so the same document found twice (a
   * re-run, or a deck filed with the SEC and posted on the IR site) is one material and one
   * extraction. Unreadable documents are recorded by URL so coverage can report them.
   */
  async saveMaterial(ticker: string, eventAccession: string, found: FoundMaterial, now: string): Promise<StoredMaterial> {
    const readable = "text" in found;
    const id = readable ? await sha256(normalizeForMatch(found.text)) : await sha256(`unsupported:${found.url}`);
    const existing = await this.db.prepare(`SELECT id,kind,status FROM earnings_materials WHERE id=?`).bind(id).first<StoredMaterial>();
    if (existing) return existing;
    const textKey = readable ? `earnings-materials/v1/${ticker}/${id}.txt` : null;
    if (readable) await this.bucket.put(textKey!, found.text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
    const status = readable ? "stored" : "unsupported";
    await this.db.prepare(`INSERT INTO earnings_materials (id,ticker,event_accession,kind,source_kind,title,source_url,published_at,text_key,characters,status,error,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
      .bind(id, ticker, eventAccession, found.kind, found.sourceKind, found.title.slice(0, 300), found.url, found.publishedAt, textKey,
        readable ? found.text.length : 0, status, readable ? null : found.unsupported, now).run();
    return { id, kind: found.kind, status };
  }

  async material(id: string): Promise<MaterialRow | null> {
    return this.db.prepare(`SELECT id,ticker,event_accession,kind,source_kind,title,source_url,published_at,text_key,status FROM earnings_materials WHERE id=?`).bind(id).first<MaterialRow>();
  }

  async materials(ticker: string): Promise<MaterialRow[]> {
    const { results } = await this.db.prepare(`SELECT id,ticker,event_accession,kind,source_kind,title,source_url,published_at,text_key,status FROM earnings_materials WHERE ticker=?`).bind(ticker).all<MaterialRow>();
    return results;
  }

  async materialText(row: MaterialRow): Promise<string | null> {
    if (!row.text_key) return null;
    const object = await this.bucket.get(row.text_key);
    return object ? object.text() : null;
  }

  async hasExtraction(materialId: string, version: string): Promise<boolean> {
    return !!await this.db.prepare(`SELECT 1 FROM guidance_extractions WHERE material_id=? AND extractor_version=? AND status IN ('ok','empty')`).bind(materialId, version).first();
  }

  /** Replaces this material's items for this version and records the extraction in one batch. */
  async saveExtraction(material: MaterialRow, eventDate: string, version: string, result: { model: string; items: VerifiedGuidance[]; rejected: number; modelCalls: number; inputCharacters: number }, now: string): Promise<void> {
    const statements = [
      this.db.prepare(`DELETE FROM guidance_items WHERE material_id=? AND extractor_version=?`).bind(material.id, version),
      ...result.items.map((item, index) => this.db.prepare(`INSERT INTO guidance_items (id,ticker,material_id,extractor_version,event_accession,event_date,payload,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .bind(`${material.id}:${version}:${index}`, material.ticker, material.id, version, material.event_accession, eventDate, JSON.stringify(item), now)),
      this.db.prepare(`INSERT INTO guidance_extractions (material_id,extractor_version,model,status,model_calls,input_characters,accepted,rejected,created_at) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(material_id,extractor_version) DO UPDATE SET model=excluded.model,status=excluded.status,model_calls=guidance_extractions.model_calls+excluded.model_calls,
        input_characters=excluded.input_characters,accepted=excluded.accepted,rejected=excluded.rejected,created_at=excluded.created_at`)
        .bind(material.id, version, result.model, result.items.length ? "ok" : "empty", result.modelCalls, result.inputCharacters, result.items.length, result.rejected, now),
      this.db.prepare(`UPDATE earnings_materials SET status='extracted' WHERE id=?`).bind(material.id),
    ];
    await this.db.batch(statements);
  }

  async markMaterialFailed(id: string, error: string): Promise<void> {
    await this.db.prepare(`UPDATE earnings_materials SET status='failed', error=? WHERE id=?`).bind(error.slice(0, 500), id).run();
  }

  /**
   * Each material's items from its extraction under `version`; a material not yet extracted under it keeps the
   * items of its newest earlier extraction, so raising the version never empties the publication while the
   * history is re-extracted.
   */
  async items(ticker: string, version: string): Promise<Array<{ material_id: string; event_accession: string; event_date: string; payload: string }>> {
    const { results } = await this.db.prepare(`SELECT i.material_id,i.event_accession,i.event_date,i.payload FROM guidance_items i
      WHERE i.ticker=? AND (i.extractor_version=? OR (
        NOT EXISTS (SELECT 1 FROM guidance_extractions x WHERE x.material_id=i.material_id AND x.extractor_version=? AND x.status IN ('ok','empty'))
        AND i.extractor_version=(SELECT x.extractor_version FROM guidance_extractions x WHERE x.material_id=i.material_id AND x.status IN ('ok','empty') ORDER BY x.created_at DESC LIMIT 1)))
      ORDER BY i.event_date,i.id`)
      .bind(ticker, version, version).all<{ material_id: string; event_accession: string; event_date: string; payload: string }>();
    return results;
  }

  /** Every readable material already stored for one event, so a re-extraction reuses them instead of fetching again. */
  async eventMaterials(ticker: string, accession: string): Promise<StoredMaterial[]> {
    const { results } = await this.db.prepare(`SELECT id,kind,status FROM earnings_materials WHERE ticker=? AND event_accession=? AND status<>'unsupported' ORDER BY created_at`)
      .bind(ticker, accession).all<StoredMaterial>();
    return results;
  }

  /** Atomic check-and-increment; false once today's cap is reached. */
  async reserve(feature: string, day: string, cap: number): Promise<boolean> {
    if (cap < 1) return false;
    const row = await this.db.prepare(`INSERT INTO feature_budget (day,feature,units) VALUES (?,?,1)
      ON CONFLICT(day,feature) DO UPDATE SET units=units+1 WHERE units<? RETURNING units`).bind(day, feature, cap).first<{ units: number }>();
    return !!row;
  }
}
