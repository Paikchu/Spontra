import { SEC_DOCUMENT_MAX_BYTES } from "../../../../shared/analysis-runtime/financial-data/limits.ts";
import type { BusinessFlowQuarter, PublicBusinessFlow } from '../../../../shared/analysis-contract/business-flow.ts';
import type { PublicCapitalStructure } from '../../../../shared/analysis-contract/capital-structure.ts';
import { checkCompleteQuarter } from '../../../../shared/analysis-runtime/financial-data/completeness.ts';
import { readReportHistory } from '../../../../shared/analysis-runtime/financial-data/report-history.ts';
import { D1SecRepository } from '../sec/d1.ts';
import { assembleCapital } from './capital-history.ts';
import { readStoredAudits, type DisclosureArchiveEnv, type StoredAudit } from './disclosure-audit.ts';
import { extractDisclosedQuarters, hasDisclosureProfile, readReportedFacts, SEC_FLOW_PARSER_VERSION, type DocumentSource } from './parser.ts';
import { fiscalFourthQuarters, priorPresentationOnly } from './period-review.ts';
import { readCompletePublicationForTicker } from './publication.ts';
import { outboxStatement } from '../pipeline/outbox.ts';
import { namesMembers, storedMemberLabels } from './member-labels.ts';
import { storedCalculation } from './calculation.ts';

/**
 * Everything the business map reads beyond the published latest pair is prepared here, by the `map-derive` task
 * whenever a filing is archived or a statement published, never on a read: each archived filing is parsed for its
 * quarterly statements once and the result stored, then each company's older quarters and capital structure are
 * assembled into one snapshot. A read is a single D1 lookup, whatever the size of the filings behind it.
 */
export const REPORT_QUARTERS_VERSION = `report-quarters.v2:${SEC_FLOW_PARSER_VERSION}`;
const quartersPrefix = (ticker: string) => `sec:report-quarters:v1:${ticker}:`;
const snapshotKey = (ticker: string) => `sec:map-derived:v1:${ticker}`;

/** Two years of quarters behind the latest report, from at most this many filings. */
const REPORT_QUARTERS = 8, REPORT_FILINGS = 24;
/** Source bytes parsed per run; filings beyond it wait for the next run, which the task schedules at once. */
export const PARSE_BUDGET_BYTES = 32_000_000;

type Industry = DocumentSource['industry'];
/**
 * `contentSha256` covers every document read: an annual report's also names the third-quarter report its fourth quarters subtract.
 * `labels`: whether the filings' member labels and revenue structure named and reconciled their businesses, so a filing parsed before they were stored is parsed again once they are.
 */
type Labels = 'named' | 'missing' | 'unneeded';
type StoredQuarters = { documentId: string; contentSha256: string; version: string; industry: Industry; labels?: Labels; quarters: BusinessFlowQuarter[] };
type ReadFiling = { html: string; source: DocumentSource; labels: Labels };
export type MapDerived = {
  ticker: string;
  /** The publication these were assembled against; a newer publication makes the snapshot stale. */
  flowKey: string;
  inputs: string;
  builtAt: string;
  reports: PublicBusinessFlow | null;
  capital: PublicCapitalStructure | null;
  /** Filings still waiting to be parsed; the reports fill in as they are. */
  pendingFilings: number;
};

const flowKey = (flow: PublicBusinessFlow) => JSON.stringify([flow.ticker, flow.fetchedAt, flow.quarters.map(q => q.periodEnd)]);
const latestOf = (flow: PublicBusinessFlow) => flow.quarters.slice().sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
const industryOf = (flow: PublicBusinessFlow): Industry => {
  const model = latestOf(flow)?.incomeModel;
  return model === 'financial' || model === 'insurance' ? model : 'standard';
};

const issuerOf = (r: StoredAudit) => r.source.documentUrl.match(/\/Archives\/edgar\/data\/(\d+)\//)?.[1];
const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86400000;

/**
 * Filings that may carry the older quarterly statements, in the order their quarters are preferred: newest filing first.
 * A period is taken from the newest filing that presents it, so it is shown on that filing's basis, recast or
 * reclassified as the filing presents it, the same basis as the newer quarter it is the year-ago period of.
 */
function reportCandidates(audits: StoredAudit[], flow: PublicBusinessFlow): StoredAudit[] {
  const latest = latestOf(flow);
  const issuer = latest?.sources.map(s => s.url.match(/\/Archives\/edgar\/data\/(\d+)\//)?.[1]).find(Boolean);
  if (!latest || !issuer) return [];
  const cutoff = new Date(latest.periodEnd);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 2);
  const candidates = audits.filter(r => {
    try {
      const url = new URL(r.source.documentUrl), cik = url.pathname.match(/^\/Archives\/edgar\/data\/(\d+)\//)?.[1];
      return r.rawKey?.startsWith('financial-disclosures/') && r.sourceBytes > 0 && r.sourceBytes <= SEC_DOCUMENT_MAX_BYTES
        && /^10-[QK](?:\/A)?$|^[86]-K$/.test(r.source.form) && /^\d{10}-\d{2}-\d{6}$/.test(r.source.accessionNumber)
        && Date.parse(r.source.filedAt) > cutoff.getTime() && url.protocol === 'https:' && url.hostname === 'www.sec.gov'
        && !url.username && !url.password && !!cik && Number(cik) === Number(issuer);
    } catch { return false; }
  });
  // On the same day, earnings exhibits carry the cleanest quarter-only tables, then 10-Qs, then 10-Ks, then other current reports.
  const priority = (r: StoredAudit) => /ex[-_]?99/i.test(r.source.documentUrl) ? 0 : /^10-Q/.test(r.source.form) ? 1 : /^10-K/.test(r.source.form) ? 2 : 3;
  return candidates.sort((a, b) => b.source.filedAt.localeCompare(a.source.filedAt) || priority(a) - priority(b)).slice(0, REPORT_FILINGS);
}

/** The third-quarter report of the fiscal year an annual report closes: the issuer's 10-Q ending one quarter before it. */
function thirdQuarterReport(audits: StoredAudit[], annual: StoredAudit): StoredAudit | null {
  if (!/^10-K/.test(annual.source.form)) return null;
  return audits.filter(r => /^10-Q/.test(r.source.form) && issuerOf(r) === issuerOf(annual) && r.rawKey?.startsWith('financial-disclosures/')
    && r.sourceBytes > 0 && r.sourceBytes <= SEC_DOCUMENT_MAX_BYTES && !/ex[-_]?99/i.test(r.source.documentUrl)
    && daysBetween(r.source.reportDate, annual.source.reportDate) >= 70 && daysBetween(r.source.reportDate, annual.source.reportDate) <= 110)
    .sort((a, b) => b.source.filedAt.localeCompare(a.source.filedAt))[0] ?? null;
}

async function readFiling(env: DisclosureArchiveEnv, record: StoredAudit, industry: Industry): Promise<ReadFiling | null> {
  const raw = await env.SEC_FILINGS.get(record.rawKey);
  if (!raw) return null;
  const html = await raw.text();
  if (new TextEncoder().encode(html).byteLength !== record.sourceBytes) return null;
  const cik = issuerOf(record)!.padStart(10, '0');
  const needed = namesMembers(html), memberLabels = needed ? await storedMemberLabels(env.DB, record.source.accessionNumber) : null;
  const structure = needed ? await storedCalculation(env.DB, record.source.accessionNumber) : null;
  return { html, labels: !needed ? 'unneeded' : memberLabels && structure ? 'named' : 'missing',
    source: { url: record.source.documentUrl, cik, accession: record.source.accessionNumber, filedAt: record.source.filedAt, industry, ...(memberLabels ? { memberLabels } : {}), ...(structure?.revenue ? { revenueStructure: structure.revenue } : {}) } };
}

/**
 * The complete quarters one filing establishes. A filing that only reclassified prior periods to conform to its current
 * presentation is read as presented: its comparative columns are then on the current basis, which is what a
 * year-over-year comparison needs. An annual report adds the fourth quarters it and its third-quarter report establish,
 * unless the issuer is read through a disclosure profile, whose fourth quarters come from its own earnings releases.
 */
export function filingQuarters(filing: { html: string; source: DocumentSource }, thirdQuarter: { html: string; source: DocumentSource } | null): BusinessFlowQuarter[] {
  const reviewed = priorPresentationOnly(filing.html);
  let quarters = extractDisclosedQuarters(filing.html, filing.source, [], reviewed).quarters;
  if (thirdQuarter && !hasDisclosureProfile(filing.source.cik) && reviewed && priorPresentationOnly(thirdQuarter.html)) {
    const annual = readReportedFacts(filing.html, filing.source), nineMonths = readReportedFacts(thirdQuarter.html, thirdQuarter.source);
    if (!annual.issues.length && !nineMonths.issues.length) quarters = [...quarters, ...fiscalFourthQuarters(annual.facts, nineMonths.facts, filing.source.revenueStructure)];
  }
  return quarters.filter(q => checkCompleteQuarter(q).complete);
}

async function parseFiling(env: DisclosureArchiveEnv, record: StoredAudit, partner: StoredAudit | null, contentSha256: string, industry: Industry): Promise<StoredQuarters | null> {
  const filing = await readFiling(env, record, industry);
  if (!filing) return null;
  const thirdQuarter = partner ? await readFiling(env, partner, industry) : null;
  if (partner && !thirdQuarter) return null;
  let quarters: BusinessFlowQuarter[] = [];
  try { quarters = filingQuarters(filing, thirdQuarter); }
  catch { /* An unsupported layout yields no quarters, and is recorded so it is not parsed again. */ }
  const read = [filing.labels, thirdQuarter?.labels], labels: Labels = read.includes('missing') ? 'missing' : read.includes('named') ? 'named' : 'unneeded';
  return { documentId: record.documentId, contentSha256, version: REPORT_QUARTERS_VERSION, industry, labels, quarters };
}

/**
 * Brings one company's snapshot up to date, parsing at most `budget` source bytes. Returns the bytes spent.
 * Quarters are taken in candidate order, newest-preferred, until eight periods are covered. A rebuilt snapshot is
 * committed together with its `map.derived` event; an unchanged one emits nothing.
 */
export async function deriveCompany(env: DisclosureArchiveEnv, ticker: string, budget = PARSE_BUDGET_BYTES, causeId: string | null = null): Promise<{ spent: number; built: boolean; pending: number }> {
  const repository = new D1SecRepository(env.DB);
  const publication = await readCompletePublicationForTicker(env.DB, ticker);
  const flow = publication.status === 'ready' ? publication.flow : null;
  if (!flow) return { spent: 0, built: false, pending: 0 };
  const audits = await readStoredAudits(env.DB, ticker);
  const industry = industryOf(flow), latest = latestOf(flow)!;
  const cutoff = new Date(latest.periodEnd);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 2);

  const storedRows = await env.DB.prepare('SELECT payload FROM sec_cache WHERE cache_key LIKE ?').bind(quartersPrefix(ticker) + '%').all<{ payload: string }>();
  const stored = new Map<string, StoredQuarters>();
  for (const row of storedRows.results) { try { const s = JSON.parse(row.payload) as StoredQuarters; stored.set(s.documentId, s); } catch { /* re-parsed below */ } }

  const byPeriod = new Map(flow.quarters.map(q => [q.periodEnd, q]));
  let spent = 0, pending = 0;
  const used: string[] = [];
  for (const record of reportCandidates(audits, flow)) {
    if (byPeriod.size >= REPORT_QUARTERS) break;
    let entry = stored.get(record.documentId);
    const partner = thirdQuarterReport(audits, record);
    const contentSha256 = partner ? `${record.contentSha256}+${partner.contentSha256}` : record.contentSha256;
    const named = async (accession: string) => !!await storedMemberLabels(env.DB, accession) && !!await storedCalculation(env.DB, accession);
    const relabel = entry?.labels === 'missing' && (await named(record.source.accessionNumber) || (!!partner && await named(partner.source.accessionNumber)));
    if (!entry || relabel || entry.contentSha256 !== contentSha256 || entry.version !== REPORT_QUARTERS_VERSION || entry.industry !== industry) {
      const bytes = record.sourceBytes + (partner?.sourceBytes ?? 0);
      if (spent + bytes > budget) { pending++; continue; }
      spent += bytes;
      const parsed = await parseFiling(env, record, partner, contentSha256, industry).catch(() => null);
      if (!parsed) continue;
      await repository.setCache(quartersPrefix(ticker) + record.documentId, parsed, new Date().toISOString());
      entry = parsed;
    }
    used.push(`${record.documentId}:${contentSha256}:${entry.labels ?? ''}`);
    for (const q of entry.quarters) {
      if (q.periodEnd > latest.periodEnd || Date.parse(q.periodEnd) <= cutoff.getTime() || byPeriod.has(q.periodEnd)) continue;
      byPeriod.set(q.periodEnd, q);
    }
  }

  const capitalInputs = audits.filter(r => r.capital).map(r => `${r.documentId}:${r.contentSha256}:${r.capital!.version}`);
  const inputs = JSON.stringify([REPORT_QUARTERS_VERSION, flowKey(flow), used, pending, capitalInputs]);
  const previous = await repository.getCache<MapDerived>(snapshotKey(ticker));
  if (previous?.payload.inputs === inputs) return { spent, built: false, pending };
  const snapshot: MapDerived = {
    ticker, flowKey: flowKey(flow), inputs, builtAt: new Date().toISOString(),
    reports: readReportHistory({ ...flow, quarters: [...byPeriod.values()] }, ticker) ?? flow,
    capital: assembleCapital(audits, flow),
    pendingFilings: pending,
  };
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at')
      .bind(snapshotKey(ticker), JSON.stringify(snapshot), snapshot.builtAt),
    outboxStatement(env.DB, { type: 'map.derived', ticker, causeId }, snapshot.builtAt),
  ]);
  return { spent, built: true, pending };
}

/** The prepared snapshot for this publication, or null until the `map-derive` task has assembled it. */
export async function readMapDerived(db: D1Database, flow: PublicBusinessFlow): Promise<MapDerived | null> {
  const record = await new D1SecRepository(db).getCache<MapDerived>(snapshotKey(flow.ticker));
  return record?.payload.flowKey === flowKey(flow) ? record.payload : null;
}
