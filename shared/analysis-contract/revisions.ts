/**
 * The revision of each resource the business map reads for a company: the time of the latest Spontra Analysis event that
 * published into it, as an ISO string. A reader compares revisions to learn newer data is out, and asks for each
 * resource at its revision so no cache in between answers with an older copy. An absent resource has never been
 * published through an event.
 */
export const PRIMARY_MAP_RESOURCES = ["company", "capital", "findings", "fundamentals", "valuation"] as const;
export const STREAM_MAP_RESOURCES = ["events", "filings"] as const;
export const MAP_RESOURCES = [...PRIMARY_MAP_RESOURCES, ...STREAM_MAP_RESOURCES] as const;
export type MapResource = (typeof MAP_RESOURCES)[number];
export type MapRevisions = Partial<Record<MapResource, string>>;

/** Live display-switch fingerprint (`map,tree,findings,filings,valuation` + `-` + `stageEnabled`), keying cached reads. */
export const DISPLAY_CONFIG_TOKEN = /^[01]{5}-[01]$/;

export type RevisionsResponse = { schemaVersion: "revisions.v1"; ticker: string; revisions: MapRevisions; config?: string };

/** A revision as it travels in a query string: an ISO time, nothing longer. */
export const REVISION = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
