import { requireDb } from "../core.ts";
import type { SecPipelineEnv } from "../operations.ts";
import { readyTranscripts } from "../transcripts/library.ts";
import { GuidanceStore } from "./store.ts";

const DAY = 86_400_000;
/** A results release follows its quarter's end by days to a few weeks; a release later than this reports another period. */
const RELEASE_WINDOW_DAYS = 100;

/** The release that reports a period: the first one filed after the period ends, within the window. */
export function releaseForPeriod<T extends { accession: string; eventDate: string }>(releases: T[], periodEnd: string): T | null {
  const until = new Date(Date.parse(`${periodEnd}T00:00:00Z`) + RELEASE_WINDOW_DAYS * DAY).toISOString().slice(0, 10);
  return [...releases].sort((a, b) => a.eventDate.localeCompare(b.eventDate)).find(r => r.eventDate > periodEnd && r.eventDate <= until) ?? null;
}

/**
 * Gives every call the transcript library stored for this company to its earnings event, as that event's `transcript`
 * material: the 8-K Item 2.02 release that reports the call's quarter, or, with no such release (a foreign issuer's
 * 6-K results, a company that releases with its 10-Q), an event of its own under the accession of the filing the
 * library found the period in. An event that gains a transcript is queued again; its Workflow extracts only what it
 * has not extracted, so the release's material is not read twice. Returns the events queued.
 */
export async function attachLibraryTranscripts(env: SecPipelineEnv, ticker: string, releases: Array<{ accession: string; eventDate: string }>, now: Date, lookbackDays = 400): Promise<string[]> {
  const db = requireDb(env);
  const store = new GuidanceStore(db, env.SEC_FILINGS);
  const stamp = now.toISOString();
  const since = new Date(now.getTime() - lookbackDays * DAY).toISOString().slice(0, 10);
  for (const call of await readyTranscripts(db, ticker, since)) {
    const event = releaseForPeriod(releases, call.periodEnd) ?? { accession: call.accession, eventDate: call.filedAt };
    await store.recordEvents(ticker, [event], stamp);
    const attached = await db.prepare("SELECT 1 FROM earnings_materials WHERE ticker=? AND event_accession=? AND kind='transcript' LIMIT 1").bind(ticker, event.accession).first();
    if (attached) continue;
    await store.saveMaterial(ticker, event.accession, {
      kind: "transcript", sourceKind: "transcript_api", title: call.title, url: call.sourceUrl, publishedAt: event.eventDate, text: call.content,
    }, stamp);
  }
  // Data-driven, so a transcript attached while the event's Workflow was finishing is not left unread.
  const { results } = await db.prepare(`UPDATE earnings_events SET status='queued',updated_at=? WHERE ticker=? AND status IN ('extracted','complete','failed')
    AND accession IN (SELECT event_accession FROM earnings_materials WHERE ticker=? AND kind='transcript' AND status='stored') RETURNING accession`)
    .bind(stamp, ticker, ticker).all<{ accession: string }>();
  return results.map(r => r.accession);
}
