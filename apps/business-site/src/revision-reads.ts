import { MAP_RESOURCES, type MapResource, type MapRevisions } from "../../../shared/analysis-contract/revisions.ts";

/** Times that say when something was last looked at, not what it says; a change in them alone is not news. */
const BOOKKEEPING = new Set(["checkedAt", "lastAttemptAt", "generatedAt"]);
const comparable = (value: unknown) => JSON.stringify(value, (key, v: unknown) => BOOKKEEPING.has(key) ? undefined : v);

/** Newer data read at given revisions, for the resources it covers. */
export type Patch<T> = { revisions: MapRevisions; patch: Partial<T> };

/**
 * What reading the newer revisions found. Only resources whose read answered are settled: `same` matches the screen,
 * `filled` fills a part the screen holds nothing for, `differs` waits for the reader. A resource whose read failed, or
 * that read empty although a revision says it was published, is in none of them, so the next check reads it again.
 */
export type RevisionReads<T> = { same: MapRevisions; filled: Patch<T>; differs: Patch<T> };

/** The parts of the page's data a resource answers with. */
const partsOf = (resource: MapResource) => resource === "company" ? ["publication", "flow"] : [resource];

/** The resources published past what the screen shows, leaving out those already read at that revision and waiting. */
export function resourcesToRead(shown: MapRevisions, latest: MapRevisions, staged: MapRevisions = {}): MapResource[] {
  return MAP_RESOURCES.filter(r => latest[r] && latest[r] !== shown[r] && latest[r] !== staged[r]);
}

export async function readRevisions<T extends object>(
  resources: MapResource[], latest: MapRevisions, now: T,
  read: (resource: MapResource, rev: string) => Promise<Partial<T> | null>,
): Promise<RevisionReads<T>> {
  const parts = await Promise.all(resources.map(r => read(r, latest[r]!).catch(() => null)));
  const result: RevisionReads<T> = { same: {}, filled: { revisions: {}, patch: {} }, differs: { revisions: {}, patch: {} } };
  const screen = now as Record<string, unknown>;
  resources.forEach((resource, i) => {
    const part = parts[i];
    if (!part) return;
    // The flow is derived from the publication, which is compared in its place.
    const entries = Object.entries(part).filter(([name]) => name !== "flow");
    if (entries.every(([name, value]) => comparable(value) === comparable(screen[name]))) result.same[resource] = latest[resource];
    else {
      const into = entries.every(([name]) => screen[name] == null) ? result.filled : result.differs;
      into.revisions[resource] = latest[resource];
      Object.assign(into.patch, part);
    }
  });
  return result;
}

/**
 * The update to offer after a check: what was waiting, less the resources this check settled, with what now differs
 * laid over it. A resource whose read failed this time keeps what was waiting for it.
 */
export function nextPending<T>(waiting: Patch<T> | null, read: RevisionReads<T>): Patch<T> | null {
  const revisions: MapRevisions = { ...waiting?.revisions };
  const patch: Record<string, unknown> = { ...waiting?.patch };
  for (const resource of Object.keys({ ...read.same, ...read.filled.revisions }) as MapResource[]) {
    delete revisions[resource];
    for (const name of partsOf(resource)) delete patch[name];
  }
  Object.assign(revisions, read.differs.revisions);
  Object.assign(patch, read.differs.patch);
  return Object.keys(revisions).length ? { revisions, patch: patch as Partial<T> } : null;
}
