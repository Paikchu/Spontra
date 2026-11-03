/**
 * Which filings collection reads and which the SEC report analyses, so discovery and the event routes agree on the
 * ones only the `archive` task stores (docs/sec-archive.md).
 */

import { isProspectusSupplement } from "../../../../shared/analysis-runtime/events.ts";

/** Forms the SEC report analyses: periodic reports and current reports, with amendments. */
export const reportedForm = (form: string) => /^(?:10-[QK]|20-F|40-F|8-K|6-K)(?:\/A)?$/.test(form);

/** Forms a collection job lists (provider.ts `readSecDocumentBatch`): an 8-K only when it reports results (Item 2.02). */
export const collectedForm = (form: string, items = "") => /^(?:10-[QK]|20-F)(?:\/A)?$/.test(form) || form === "6-K" || (form === "8-K" && /(^|,)\s*2\.02\b/.test(items));

/**
 * Filings the `archive` task stores: everything the SEC report reads, and the prospectus supplements the item analysis
 * reads. Collection stores many of them too, but not reliably (an incremental collection's window and same-day rules
 * leave filings out), and a document it stored is read back, never downloaded again; so the task holds the whole
 * invariant that every filing a reader needs is archived, and only downloads what is missing.
 */
export const archivedForm = (form: string) => reportedForm(form) || isProspectusSupplement(form);
