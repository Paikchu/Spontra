import { D1SecRepository } from '../sec/d1.ts';

/**
 * The names a filing gives its dimension members, as its own label linkbase writes them: `msft:IntelligentCloudMember`
 * reads "Intelligent Cloud". EDGAR renders every XBRL filing's labels into one `MetaLinks.json` beside the documents,
 * so one request covers the issuer's extension members and the standard ones it uses. The terse label is the one a
 * filing prints in its tables; the standard label is the fallback, without its " [Member]" suffix.
 */
export const MEMBER_LABELS_VERSION = 'member-labels.v1';
const cacheKey = (accession: string) => `sec:member-labels:v1:${accession}`;
export type StoredMemberLabels = { version: string; accession: string; labels: Record<string, string> };

type MetaLinksRole = { terseLabel?: unknown; label?: unknown };
type MetaLinks = { instance?: Record<string, { tag?: Record<string, { lang?: Record<string, { role?: MetaLinksRole }> }> }> };

/** MetaLinks keeps a label's XML escapes (`Compute &amp; Networking`). */
const unescape = (text: string) => text.replace(/&(?:#(\d+)|#x([\da-f]+)|(amp|lt|gt|quot|apos));/gi, (_, dec, hex, name) =>
  dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[name.toLowerCase()]);
const clean = (value: unknown) => typeof value === 'string' ? unescape(value).replace(/\s+/g, ' ').replace(/\s*\[Member\]$/i, '').trim().slice(0, 120) : '';

/** `prefix_LocalMember` → `prefix:LocalMember`, the form an instance names an explicit member in. */
export function parseMemberLabels(json: unknown): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const instance of Object.values((json as MetaLinks | null)?.instance ?? {})) {
    for (const [key, tag] of Object.entries(instance?.tag ?? {})) {
      const split = key.indexOf('_');
      if (split <= 0 || !key.endsWith('Member')) continue;
      const roles = tag?.lang?.['en-us']?.role ?? tag?.lang?.['en']?.role;
      const label = clean(roles?.terseLabel) || clean(roles?.label);
      if (label) labels[`${key.slice(0, split)}:${key.slice(split + 1)}`] = label;
    }
  }
  return labels;
}

/** A member the filing gave no label: its local name, words split, e.g. `AmericasSegmentMember` → "Americas Segment". */
export function memberName(member: string, labels?: Record<string, string>): string {
  const label = labels?.[member];
  if (label) return unescape(label);
  return member.split(':').at(-1)!.replace(/Member$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

/** Only an inline XBRL document with dimensional contexts names members. */
export const namesMembers = (html: string) => /<ix:nonFraction/i.test(html) && /explicitMember/i.test(html);

export async function storedMemberLabels(db: D1Database, accession: string): Promise<Record<string, string> | null> {
  const record = await new D1SecRepository(db).getCache<StoredMemberLabels>(cacheKey(accession));
  return record?.payload.version === MEMBER_LABELS_VERSION ? record.payload.labels : null;
}

/**
 * A filing's member labels, read from EDGAR once and kept by accession. Labels only name what the facts already
 * prove, so a filing whose `MetaLinks.json` cannot be read still parses, its members by their local names, and is
 * asked for again on its next parse; only an SEC access pause stops the caller.
 */
export async function filingMemberLabels(db: D1Database, read: (url: string) => Promise<Response>, documentUrl: string, accession: string): Promise<Record<string, string>> {
  const stored = await storedMemberLabels(db, accession);
  if (stored) return stored;
  const folder = documentUrl.slice(0, documentUrl.lastIndexOf('/') + 1);
  let labels: Record<string, string>;
  try {
    const response = await read(folder + 'MetaLinks.json');
    if (Number(response.headers.get('content-length')) > 12_000_000) return {};
    labels = parseMemberLabels(await response.json());
  } catch (error) {
    if (error instanceof Error && error.message === 'SEC_ACCESS_PAUSED') throw error;
    return {};
  }
  await new D1SecRepository(db).setCache<StoredMemberLabels>(cacheKey(accession), { version: MEMBER_LABELS_VERSION, accession, labels }, new Date().toISOString());
  return labels;
}
