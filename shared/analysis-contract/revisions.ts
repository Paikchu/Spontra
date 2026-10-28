/**
 * The revision of each resource the business map reads for a company: the time of the latest Spontra Analysis event that
 * published into it, as an ISO string. A reader compares revisions to learn newer data is out, and asks for each
 * resource at its revision so no cache in between answers with an older copy. An absent resource has never been
 * published through an event.
 */
export const MAP_RESOURCES = ["company", "capital", "findings", "fundamentals", "events", "filings", "valuation"] as const;
export type MapResource = (typeof MAP_RESOURCES)[number];
export type MapRevisions = Partial<Record<MapResource, string>>;

export type RevisionsResponse = { schemaVersion: "revisions.v1"; ticker: string; revisions: MapRevisions };

/** A revision as it travels in a query string: an ISO time, nothing longer. */
export const REVISION = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
