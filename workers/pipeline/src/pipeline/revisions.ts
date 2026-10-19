import { MAP_RESOURCES, type MapResource, type MapRevisions } from "../../../../shared/analysis-contract/revisions.ts";
import type { EventMessage } from "./messages.ts";
import type { EventType } from "./registry.ts";

/**
 * Which of the map's resources each event publishes into. Generous on purpose: a revision that moves without a visible
 * change costs the reader one comparison, while a missed one leaves the page stale.
 */
export const REVISES: Partial<Record<EventType, readonly MapResource[]>> = {
  "financials.published": ["company", "capital"],
  "map.derived": ["company", "capital"],
  "report.published": ["company", "filings"],
  "filings.indexed": ["filings"],
  "analysis.published": ["filings"],
  "fundamentals.updated": ["fundamentals"],
  "guidance.published": ["company"],
  "explainer.published": ["company"],
  "tree.published": ["company"],
  // A feature switched shown or hidden: every resource a feature publishes into, so the reader reloads what changed.
  "feature.settings": ["company", "filings", "findings", "events"],
  "findings.published": ["findings"],
  "dossier.published": ["findings"],
  // Cited peers ride with the findings; comparable peers ride with the capital structure for the checkup's ranks.
  "peers.published": ["findings", "capital"],
  "events.published": ["events"],
  "translations.published": ["company", "findings", "events", "filings"],
};

/**
 * One upsert per company and resource the events publish into, at the latest event's time. Keeping the larger value makes
 * a redelivered or late batch harmless: an event's data committed with it, so a reader at a later revision already has it.
 */
export function revisionStatements(db: D1Database, events: Pick<EventMessage, "type" | "ticker" | "at">[]): D1PreparedStatement[] {
  const latest = new Map<string, { ticker: string; resource: MapResource; at: string }>();
  for (const event of events) {
    for (const resource of REVISES[event.type] ?? []) {
      const key = `${event.ticker}\u0000${resource}`;
      const seen = latest.get(key);
      if (!seen || event.at > seen.at) latest.set(key, { ticker: event.ticker, resource, at: event.at });
    }
  }
  return [...latest.values()].map(row => db.prepare(`INSERT INTO publication_revisions (ticker, resource, revision) VALUES (?, ?, ?)
    ON CONFLICT (ticker, resource) DO UPDATE SET revision = max(revision, excluded.revision)`).bind(row.ticker, row.resource, row.at));
}

/** A company's revisions, a global publication's (ticker '*') counting for every company. */
export async function readRevisions(db: D1Database, ticker: string): Promise<MapRevisions> {
  const rows = (await db.prepare("SELECT resource, max(revision) revision FROM publication_revisions WHERE ticker IN (?, '*') GROUP BY resource")
    .bind(ticker).all<{ resource: string; revision: string }>()).results;
  const revisions: MapRevisions = {};
  for (const row of rows) if ((MAP_RESOURCES as readonly string[]).includes(row.resource)) revisions[row.resource as MapResource] = row.revision;
  return revisions;
}
