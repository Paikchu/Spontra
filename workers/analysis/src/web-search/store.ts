import type { D1Like } from "../sec/d1-support.ts";
import type { RetrievalData } from "./types.ts";
export interface StoredResult { data: RetrievalData; fetchedAt: number; expiresAt: number }
export interface SearchStore {
  read(key: string): Promise<StoredResult | null>;
  claim(key: string, owner: string, now: number, until: number): Promise<boolean>;
  publish(key: string, owner: string, now: () => number, value: StoredResult): Promise<boolean>;
  release(key: string, owner: string): Promise<void>;
}
/** Narrow structural port accepts the actual R2 binding and an in-memory test double. */
export interface SearchBucket {
  get(key: string): Promise<{ json<T>(): Promise<T> } | null>;
  put(key: string, value: string): Promise<unknown>;
}
export class D1R2SearchStore implements SearchStore {
  private readonly db: D1Like;
  private readonly bucket: SearchBucket;
  constructor(db: D1Like, bucket: SearchBucket) { this.db = db; this.bucket = bucket; }
  async read(key: string): Promise<StoredResult | null> {
    const row = await this.db.prepare("SELECT object_key FROM web_search_cache WHERE cache_key = ?")
      .bind(key).first<{ object_key: string | null }>();
    if (!row?.object_key) return null;
    const object = await this.bucket.get(row.object_key);
    return object ? object.json<StoredResult>() : null;
  }
  async claim(key: string, owner: string, now: number, until: number): Promise<boolean> {
    const row = await this.db.prepare(`INSERT INTO web_search_cache (cache_key, lease_owner, lease_until)
      VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET lease_owner = excluded.lease_owner,
      lease_until = excluded.lease_until WHERE web_search_cache.lease_until <= ?
      RETURNING lease_owner`).bind(key, owner, until, now).first<{ lease_owner: string }>();
    return row?.lease_owner === owner;
  }
  async publish(key: string, owner: string, now: () => number, value: StoredResult): Promise<boolean> {
    // Unique immutable key: a timed-out owner cannot overwrite a newer owner's content.
    const objectKey = `web-search/v1/${key}/${owner}.json`;
    await this.bucket.put(objectKey, JSON.stringify(value));
    const row = await this.db.prepare(`UPDATE web_search_cache SET object_key = ?,
      lease_owner = NULL, lease_until = 0 WHERE cache_key = ? AND lease_owner = ? AND lease_until > ?
      RETURNING cache_key`).bind(objectKey, key, owner, now()).first<{ cache_key: string }>();
    return !!row;
  }
  async release(key: string, owner: string): Promise<void> {
    await this.db.prepare(`UPDATE web_search_cache SET lease_owner = NULL, lease_until = 0
      WHERE cache_key = ? AND lease_owner = ?`).bind(key, owner).run();
  }
}
