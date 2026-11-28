import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import { AI_EFFORTS, type AiEffort } from "../../api/admin/types/ai-models-admin.ts";

/** A model the admin connected. The key stays on the server. */
export type StoredEndpoint = { name: string; url: string; apiKey: string; thinkingLevel: AiEffort };

type EndpointRow = { name: string; base_url: string; api_key: string; thinking_level: string };

const isLevel = (value: string): value is AiEffort => (AI_EFFORTS as readonly string[]).includes(value);

/** Rows saved from the admin. A missing table reads as none. */
export async function listEndpoints(db: D1Database): Promise<StoredEndpoint[]> {
  const rows = await db.prepare("SELECT name, base_url, api_key, thinking_level FROM ai_endpoints ORDER BY name").all<EndpointRow>().catch(() => null);
  return (rows?.results ?? []).flatMap((row) => isLevel(row.thinking_level) ? [{ name: row.name, url: row.base_url, apiKey: row.api_key, thinkingLevel: row.thinking_level }] : []);
}

/** Endpoints carried on the request environment as `AI_ENDPOINTS`. */
export function readEndpoints(env: { AI_ENDPOINTS?: string }): StoredEndpoint[] {
  if (!env.AI_ENDPOINTS) return [];
  try {
    const rows = JSON.parse(env.AI_ENDPOINTS) as StoredEndpoint[];
    return Array.isArray(rows) ? rows.filter((row) => row && typeof row.name === "string" && typeof row.url === "string" && typeof row.apiKey === "string" && isLevel(row.thinkingLevel)) : [];
  } catch { return []; }
}

export function endpointFor(env: { AI_ENDPOINTS?: string }, name: string): StoredEndpoint | undefined {
  return readEndpoints(env).find((row) => row.name === name);
}

/** Every requested level sends the thinking level the admin set for this model. */
export function fixedThinkingMap(level: string): ThinkingLevelMap {
  return { off: level, minimal: level, low: level, medium: level, high: level, xhigh: level, max: level };
}
