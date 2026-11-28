import type { MaterialState } from "./contract.ts";
import { materialDigest } from "./store.ts";

export const BLANK_ROW_HEADER_REVISION = "blank-row-header.v1";
export type BlankRowHeaderRepair = { revision: typeof BLANK_ROW_HEADER_REVISION; sourceFilename: string; failureHash: string };
/** Only the proven representational null-header fault, never grid/number/review failures. */
export async function blankRowHeaderRepairId(state: MaterialState, requestId: string, repair: BlankRowHeaderRepair): Promise<string | null> {
  if (state.status !== "blocked" || state.issues.length !== 1 || !/^[^/\\]+\.(?:jpg|jpeg|png|webp)$/i.test(repair.sourceFilename)) return null;
  const issue = state.issues[0]!, prefix = `${repair.sourceFilename}: `;
  if (!issue.startsWith(prefix) || await materialDigest(issue) !== repair.failureHash) return null;
  try {
    const errors: unknown = JSON.parse(issue.slice(prefix.length));
    if (!Array.isArray(errors) || !errors.length || errors.some(e => !e || e.code !== "invalid_type" || e.expected !== "string" || e.message !== "Invalid input: expected string, received null" || !Array.isArray(e.path) || e.path.length !== 3 || e.path[0] !== "tables" || !Number.isInteger(e.path[1]) || e.path[1] < 0 || e.path[2] !== "rowHeader")) return null;
  } catch { return null; }
  const hash = await materialDigest(JSON.stringify({ ticker:state.filing.ticker,accession:state.filing.accession,requestId,...repair }));
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
}
