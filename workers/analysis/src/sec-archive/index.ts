/**
 * SEC archive (docs/sec-archive.md): the one module that reads EDGAR, and the one place every other feature reads SEC
 * filings from. Listings (`edgarListings`) say what exists; documents are downloaded only by an `archivingReader`,
 * which stores them; everything else reads what was stored (`archivedFiling`, `archivedExhibits`, `readArchivedDocument`).
 */
import type { AnalysisEnv } from "../operations.ts";
import { edgarListingsFor, type EdgarListings, type GatewayOptions } from "./gateway.ts";

export type { EdgarListings, GatewayOptions } from "./gateway.ts";
export { archiveRoot } from "./gateway.ts";
export { archivedExhibits, archivedFiling, archiveDocuments, archiveHolds, archivingReader, exhibitType, readArchivedDocument, type ArchivedDocument, type ArchivedFiling, type ArchiveEnv } from "./archive.ts";

/** EDGAR's listings for this Worker: the contact user-agent from the environment, a test's fetcher when given. */
export function edgarListings(env: Pick<AnalysisEnv, "SEC_USER_AGENT">, options: GatewayOptions = {}): EdgarListings {
  return edgarListingsFor(env.SEC_USER_AGENT, { delayMs: 200, ...options });
}
