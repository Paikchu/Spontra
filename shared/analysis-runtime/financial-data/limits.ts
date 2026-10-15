/**
 * The largest single SEC document the pipeline downloads, archives and parses. Sized for the largest bank annual
 * reports, which file every statement and note in one inline XBRL document (JPMorgan's 2025 10-K is 12.9 MB).
 */
export const SEC_DOCUMENT_MAX_BYTES = 20_000_000;
