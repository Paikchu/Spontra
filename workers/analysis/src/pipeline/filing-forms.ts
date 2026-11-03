/**
 * Which filings collection reads and which the SEC report analyses, so discovery and the event routes agree on the
 * ones only the `archive` task stores (docs/sec-archive.md).
 */

/** Forms the SEC report analyses: periodic reports and current reports, with amendments. */
export const reportedForm = (form: string) => /^(?:10-[QK]|20-F|40-F|8-K|6-K)(?:\/A)?$/.test(form);

/** Forms a collection job lists (provider.ts `readSecDocumentBatch`): an 8-K only when it reports results (Item 2.02). */
export const collectedForm = (form: string, items = "") => /^(?:10-[QK]|20-F)(?:\/A)?$/.test(form) || form === "6-K" || (form === "8-K" && /(^|,)\s*2\.02\b/.test(items));

/**
 * Filings the `archive` task stores: everything the SEC report reads except the unamended periodic reports collection
 * always lists (10-Q, 10-K, 20-F). Collection stores only some of the rest (an unamended earnings 8-K, a 6-K or an
 * amendment inside its incremental window) and a document it stored is not downloaded again, so the task reads those
 * from the archive and only downloads what is missing.
 */
export const archivedForm = (form: string) => reportedForm(form) && !/^(?:10-[QK]|20-F)$/.test(form);
