import type { BusinessFlowQuarter, PublicBusinessFlow } from '../../../../shared/analysis-contract/business-flow.ts';
import type { PublicCapitalStructure } from '../../../../shared/analysis-contract/capital-structure.ts';
import { checkCompleteQuarter } from '../../../../shared/analysis-runtime/financial-data/completeness.ts';
import { readReportHistory } from '../../../../shared/analysis-runtime/financial-data/report-history.ts';
import { financialPolicy } from '../../../../shared/analysis-runtime/financial-data/policy.ts';
import { D1SecRepository } from '../sec/d1.ts';
import { assembleCapital } from './capital-history.ts';
import { companyPolicyEnvironment } from './company-policy.ts';
import { readStoredAudits, type DisclosureArchiveEnv, type StoredAudit } from './disclosure-audit.ts';
import { extractDisclosedQuarters, SEC_FLOW_PARSER_VERSION, type DocumentSource } from './parser.ts';
import { readCompletePublicationForTicker } from './publication.ts';

/**
 * Everything the business map reads beyond the published latest pair is prepared here, on the schedule,
 * never on a read: each archived filing is parsed for its quarterly statements once and the result stored,
 * then each company's older quarters and capital structure are assembled into one snapshot. A read is a
 * single D1 lookup, whatever the size of the filings behind it.
 */
export const REPORT_QUARTERS_VERSION = `report-quarters.v1:${SEC_FLOW_PARSER_VERSION}`;
const quartersPrefix = (ticker: string) => `sec:report-quarters:v1:${ticker}:`;
const snapshotKey = (ticker: string) => `sec:map-derived:v1:${ticker}`;

/** Two years of quarters behind the latest report, from at most this many filings. */
const REPORT_QUARTERS = 8, REPORT_FILINGS = 24;
/** Source bytes parsed per tick across all companies; the rest waits for the next tick. */
const PARSE_BUDGET_BYTES = 32_000_000;

type Industry = DocumentSource['industry'];
type StoredQuarters = { documentId: string; contentSha256: string; version: string; industry: Industry; quarters: BusinessFlowQuarter[] };
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

/** Filings that may carry the older quarterly statements, in the order their quarters are preferred. */
function reportCandidates(audits: StoredAudit[], flow: PublicBusinessFlow): StoredAudit[] {
  const latest = latestOf(flow);
  const issuer = latest?.sources.map(s => s.url.match(/\/Archives\/edgar\/data\/(\d+)\//)?.[1]).find(Boolean);
  if (!latest || !issuer) return [];
  const cutoff = new Date(latest.periodEnd);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 2);
  const candidates = audits.filter(r => {
    try {
      const url = new URL(r.source.documentUrl), cik = url.pathname.match(/^\/Archives\/edgar\/data\/(\d+)\//)?.[1];
      return r.rawKey?.startsWith('financial-disclosures/') && r.sourceBytes > 0 && r.sourceBytes <= 12_000_000
        && /^10-[QK](?:\/A)?$|^8-K$/.test(r.source.form) && /^\d{10}-\d{2}-\d{6}$/.test(r.source.accessionNumber)
        && Date.parse(r.source.filedAt) > cutoff.getTime() && url.protocol === 'https:' && url.hostname === 'www.sec.gov'
        && !url.username && !url.password && !!cik && Number(cik) === Number(issuer);
    } catch { return false; }
  });
  // Earnings exhibits carry the cleanest quarter-only tables, then 10-Qs, then 10-Ks, then other 8-Ks.
  const priority = (r: StoredAudit) => /ex[-_]?99/i.test(r.source.documentUrl) ? 0 : /^10-Q/.test(r.source.form) ? 1 : /^10-K/.test(r.source.form) ? 2 : 3;
  return candidates.sort((a, b) => priority(a) - priority(b) || b.source.filedAt.localeCompare(a.source.filedAt)).slice(0, REPORT_FILINGS);
}

async function parseFiling(env: DisclosureArchiveEnv, record: StoredAudit, industry: Industry): Promise<StoredQuarters | null> {
  const raw = await env.SEC_FILINGS.get(record.rawKey);
  if (!raw) return null;
  const html = await raw.text();
  if (new TextEncoder().encode(html).byteLength !== record.sourceBytes) return null;
  const cik = record.source.documentUrl.match(/\/Archives\/edgar\/data\/(\d+)\//)![1]!.padStart(10, '0');
  const source: DocumentSource = { url: record.source.documentUrl, cik, accession: record.source.accessionNumber, filedAt: record.source.filedAt, industry };
  let quarters: BusinessFlowQuarter[] = [];
  try { quarters = extractDisclosedQuarters(html, source).quarters.filter(q => checkCompleteQuarter(q).complete); }
  catch { /* An unsupported layout yields no quarters, and is recorded so it is not parsed again. */ }
  return { documentId: record.documentId, contentSha256: record.contentSha256, version: REPORT_QUARTERS_VERSION, industry, quarters };
}

/**
 * Brings one company's snapshot up to date, parsing at most `budget` source bytes. Returns the bytes spent.
 * Quarters are taken in candidate order, newest-preferred, until eight periods are covered.
 */
async function deriveCompany(env: DisclosureArchiveEnv, ticker: string, budget: number): Promise<{ spent: number; built: boolean; pending: number }> {
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
    if (!entry || entry.contentSha256 !== record.contentSha256 || entry.version !== REPORT_QUARTERS_VERSION || entry.industry !== industry) {
      if (spent + record.sourceBytes > budget) { pending++; continue; }
      spent += record.sourceBytes;
      const parsed = await parseFiling(env, record, industry).catch(() => null);
      if (!parsed) continue;
      await repository.setCache(quartersPrefix(ticker) + record.documentId, parsed, new Date().toISOString());
      entry = parsed;
    }
    used.push(`${record.documentId}:${record.contentSha256}`);
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
  await repository.setCache(snapshotKey(ticker), snapshot, snapshot.builtAt);
  return { spent, built: true, pending };
}

/** One scheduled pass over every company the data policy collects. No SEC fetch, model call or Workflow. */
export async function runMapDerivationTick(rawEnv: DisclosureArchiveEnv & { SEC_DATA_TICKERS?: string; SEC_TRACKED_TICKERS?: string }) {
  const env = await companyPolicyEnvironment(rawEnv);
  const tickers = [...financialPolicy({ SEC_DATA_TICKERS: env.SEC_DATA_TICKERS, SEC_TRACKED_TICKERS: env.SEC_TRACKED_TICKERS, SEC_AI_ENABLED: 'false' }).dataTickers].sort();
  let budget = PARSE_BUDGET_BYTES;
  const built: string[] = [], pending: Record<string, number> = {}, failed: string[] = [];
  for (const ticker of tickers) {
    try {
      const result = await deriveCompany(env, ticker, budget);
      budget -= result.spent;
      if (result.built) built.push(ticker);
      if (result.pending) pending[ticker] = result.pending;
    } catch { failed.push(ticker); }
  }
  return { built, pending, failed, parsedBytes: PARSE_BUDGET_BYTES - budget };
}

/** The prepared snapshot for this publication, or null until the schedule has assembled it. */
export async function readMapDerived(db: D1Database, flow: PublicBusinessFlow): Promise<MapDerived | null> {
  const record = await new D1SecRepository(db).getCache<MapDerived>(snapshotKey(flow.ticker));
  return record?.payload.flowKey === flowKey(flow) ? record.payload : null;
}
