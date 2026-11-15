import { clampThinkingLevel, type Model, type ModelThinkingLevel, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

/**
 * Reasoning levels come from the Agent SDK catalogs, not a list kept in this repo. A model the catalogs
 * already name is used as-is. A new id from a known vendor uses the closest catalog model of that vendor.
 * An unknown vendor is sent the requested level unchanged, so connecting it does not take a code change.
 */
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ModelThinkingLevel[];
const PASSTHROUGH: ThinkingLevelMap = { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

type Known = { id: string; map: ThinkingLevelMap };

let known: Known[] | undefined;

function catalogs(): Known[] {
  if (known) return known;
  known = [...deepseekProvider().getModels(), ...openaiProvider().getModels()].flatMap((model) =>
    model.thinkingLevelMap ? [{ id: model.id, map: model.thinkingLevelMap }] : []);
  return known;
}

const vendorOf = (id: string) => id.slice(0, Math.max(id.indexOf("-"), 0));

function commonPrefix(a: string, b: string): number {
  let i = 0;
  const end = Math.min(a.length, b.length);
  while (i < end && a[i] === b[i]) i++;
  return i;
}

/** The SDK map for this model id. */
export function reasoningMap(modelId: string): ThinkingLevelMap {
  const rows = catalogs();
  const exact = rows.find((row) => row.id === modelId);
  if (exact) return exact.map;
  const vendor = vendorOf(modelId);
  if (!vendor) return PASSTHROUGH;
  let best: Known | undefined;
  let bestLen = vendor.length;
  for (const row of rows) {
    if (vendorOf(row.id) !== vendor) continue;
    const len = commonPrefix(row.id, modelId);
    if (len > bestLen) { best = row; bestLen = len; }
  }
  return best?.map ?? rows.find((row) => vendorOf(row.id) === vendor)?.map ?? PASSTHROUGH;
}

/** The thinking level Pi stores. The model map turns it into that model's `reasoning_effort`. */
export function piThinkingLevel(modelId: string, effort: string): ModelThinkingLevel {
  const model = { reasoning: true, thinkingLevelMap: reasoningMap(modelId) } as Model<"openai-completions">;
  const level = (LEVELS as readonly string[]).includes(effort) ? effort as ModelThinkingLevel : "high";
  return clampThinkingLevel(model, level);
}

/** The `reasoning_effort` this model is sent for a requested level. */
export function reasoningEffort(modelId: string, requested: string): string {
  const level = piThinkingLevel(modelId, requested);
  const wire = reasoningMap(modelId)[level];
  return typeof wire === "string" ? wire : "high";
}
