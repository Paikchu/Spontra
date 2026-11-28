import type { FilingReportBundleMeta, FilingReportSourceRef, FilingReportStage } from "./filings-contract.ts";
import type { MaterialBrief, MaterialRef, MaterialSnapshot } from "../filing-material/contract.ts";
import { listFilingMaterials, readMaterialBrief, readMaterialSnapshot } from "../filing-material";
import type { AnalysisEnv } from "../../operations.ts";
import type { SecFiling } from "./sec/sec.ts";
import { earningsReleasePeriod } from "./earnings-handoff.ts";
import { transcripts } from "./research.ts";

const PERIODIC_FORM = /^(?:10-Q|10-K|20-F|40-F)(?:\/A)?$/i;
const AMENDMENT_FORM = /\/A$/i;
const EARNINGS_FORM = /^(?:8-K|6-K)(?:\/A)?$/i;

export type QuarterBriefSummary = {
  accession: string;
  form: string;
  filedAt: string;
  disclosureKind: FilingReportSourceRef["disclosureKind"];
  headline: string;
  keyTakeaways: Array<{ text: string; sourceIds: string[] }>;
  metricsCount: number;
  guidanceCount: number;
  risksCount: number;
  signalsCount: number;
  tablesDescribed: number;
};

export type QuarterBundleSpec = {
  meta: FilingReportBundleMeta;
  companionMaterials: MaterialRef[];
  briefs: QuarterBriefSummary[];
};

const quarterBundleKey = (ticker: string, periodEnd: string) => `filing-quarter-report:v1:${ticker}:${periodEnd}`;
const quarterBundlePrefix = (ticker: string) => `filing-quarter-report:v1:${ticker}:`;
const quarterAliasKey = (ticker: string, accession: string) => `filing-quarter-alias:v1:${ticker}:${accession}`;

function sameQuarterEnd(a: string, b: string): boolean {
  if (a === b) return true;
  const da = Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  const db = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(da) || !Number.isFinite(db)) return false;
  return Math.abs(da - db) <= 10 * 86_400_000;
}

function classifyDisclosure(
  form: string,
  brief: MaterialBrief | null,
  isEarningsFallback: boolean,
): FilingReportSourceRef["disclosureKind"] {
  if (brief?.disclosureMeta.disclosureKind) return brief.disclosureMeta.disclosureKind;
  if (AMENDMENT_FORM.test(form)) return "amendment";
  if (PERIODIC_FORM.test(form)) return "periodic-report";
  if (isEarningsFallback) return "earnings-release";
  return "non-earnings-event";
}

function summarizeBrief(
  accession: string,
  form: string,
  filedAt: string,
  disclosureKind: FilingReportSourceRef["disclosureKind"],
  brief: MaterialBrief,
): QuarterBriefSummary {
  return {
    accession,
    form,
    filedAt,
    disclosureKind,
    headline: brief.headline,
    keyTakeaways: brief.keyTakeaways.slice(0, 8),
    metricsCount: brief.metrics.length,
    guidanceCount: brief.guidanceAndChanges.length,
    risksCount: brief.risksAndFootnotes.length,
    signalsCount: brief.industrySignals.length,
    tablesDescribed: brief.tableCatalog.length,
  };
}

/**
 * Discovers all same-quarter earnings materials (8-K Item 2.02, 10-Q/10-K/20-F/40-F + /A, and earnings call transcript)
 * for a filing. Returns null for non-earnings 8-K/6-K events so they remain standalone in the event stream.
 */
export async function buildQuarterBundle(
  env: AnalysisEnv,
  ticker: string,
  filing: SecFiling,
  snapshot: MaterialSnapshot,
): Promise<QuarterBundleSpec | null> {
  const isPeriodic = PERIODIC_FORM.test(filing.form);
  const primaryBriefRes = await readMaterialBrief(env, snapshot.ref).catch(() => null);
  const primaryBrief = primaryBriefRes?.brief ?? null;

  let periodEnd: string | null = null;
  let fiscalPeriod: string | null = primaryBrief?.disclosureMeta.fiscalPeriod ?? null;
  let primaryIsEarnings = false;

  if (isPeriodic) {
    periodEnd = (filing.reportDate || primaryBrief?.disclosureMeta.coveredPeriodEnd || "").slice(0, 10) || null;
  } else if (EARNINGS_FORM.test(filing.form)) {
    const releasePeriod = earningsReleasePeriod(filing, snapshot);
    primaryIsEarnings = primaryBrief?.disclosureMeta.isEarningsRelease === true
      || primaryBrief?.disclosureMeta.disclosureKind === "earnings-release"
      || Boolean(releasePeriod);
    if (!primaryIsEarnings) return null;
    periodEnd = (primaryBrief?.disclosureMeta.coveredPeriodEnd || releasePeriod || "").slice(0, 10) || null;
  } else {
    return null;
  }

  if (!periodEnd) return null;

  const readyMaterials = (await listFilingMaterials(env, ticker)).filter(m => m.status === "ready");
  const sources: FilingReportSourceRef[] = [];
  const companionMaterials: MaterialRef[] = [];
  const briefs: QuarterBriefSummary[] = [];

  const primaryKind = classifyDisclosure(filing.form, primaryBrief, primaryIsEarnings);
  sources.push({
    accessionNumber: filing.accessionNumber,
    form: filing.form,
    filingDate: filing.filingDate,
    disclosureKind: primaryKind,
    edgarUrl: filing.indexUrl,
  });
  if (primaryBrief) {
    briefs.push(summarizeBrief(filing.accessionNumber, filing.form, filing.filingDate, primaryKind, primaryBrief));
  }

  for (const mat of readyMaterials) {
    if (mat.status !== "ready" || mat.filing.accession === filing.accessionNumber) continue;
    const matIsPeriodic = PERIODIC_FORM.test(mat.filing.form);
    const matIsCurrent = EARNINGS_FORM.test(mat.filing.form);
    if (!matIsPeriodic && !matIsCurrent) continue;

    // Fast pre-filter by filing date window (±95 days around periodEnd) to avoid reading unrelated historical briefs.
    const matFiledMs = Date.parse(`${mat.filing.filedAt.slice(0, 10)}T00:00:00Z`);
    const periodMs = Date.parse(`${periodEnd}T00:00:00Z`);
    if (Number.isFinite(matFiledMs) && Number.isFinite(periodMs)) {
      const diffDays = (matFiledMs - periodMs) / 86_400_000;
      if (diffDays < -15 || diffDays > 140) continue;
    }

    const matBriefRes = await readMaterialBrief(env, mat.ref).catch(() => null);
    const matBrief = matBriefRes?.brief ?? null;

    let matPeriodEnd: string | null = null;
    let matIsEarnings = false;
    if (matIsPeriodic) {
      matPeriodEnd = (mat.filing.reportDate || matBrief?.disclosureMeta.coveredPeriodEnd || "").slice(0, 10) || null;
    } else {
      if (matBrief) {
        matIsEarnings = matBrief.disclosureMeta.isEarningsRelease || matBrief.disclosureMeta.disclosureKind === "earnings-release";
        matPeriodEnd = matIsEarnings ? (matBrief.disclosureMeta.coveredPeriodEnd || "").slice(0, 10) || null : null;
      } else {
        const matSnap = await readMaterialSnapshot(env, mat.ref).catch(() => null);
        if (matSnap) {
          const fakeFiling: SecFiling = {
            ticker: mat.filing.ticker,
            cik: mat.filing.cik,
            cikNumber: Number(mat.filing.cik),
            companyName: mat.filing.companyName,
            form: mat.filing.form,
            filingDate: mat.filing.filedAt,
            acceptedAt: mat.filing.acceptedAt,
            reportDate: mat.filing.reportDate,
            accessionNumber: mat.filing.accession,
            primaryDocument: mat.filing.primaryDocument,
            description: mat.filing.form,
            items: mat.filing.items ?? "",
            documentUrl: mat.filing.documentUrl,
            indexUrl: mat.filing.indexUrl,
          };
          matPeriodEnd = earningsReleasePeriod(fakeFiling, matSnap);
          matIsEarnings = Boolean(matPeriodEnd);
        }
      }
    }

    if (!matPeriodEnd || !sameQuarterEnd(matPeriodEnd, periodEnd)) continue;
    if (!fiscalPeriod && matBrief?.disclosureMeta.fiscalPeriod) {
      fiscalPeriod = matBrief.disclosureMeta.fiscalPeriod;
    }

    const matKind = classifyDisclosure(mat.filing.form, matBrief, matIsEarnings);
    sources.push({
      accessionNumber: mat.filing.accession,
      form: mat.filing.form,
      filingDate: mat.filing.filedAt,
      disclosureKind: matKind,
      edgarUrl: mat.filing.indexUrl,
    });
    companionMaterials.push(mat.ref);
    if (matBrief) {
      briefs.push(summarizeBrief(mat.filing.accession, mat.filing.form, mat.filing.filedAt, matKind, matBrief));
    }
  }

  let hasTranscript = false;
  if (env.DB) {
    const calls = await transcripts(env.DB, ticker, 12).catch(() => []);
    hasTranscript = calls.some(call => sameQuarterEnd(call.periodEnd, periodEnd));
  }

  // Order sources: periodic reports first (newest filingDate first), then earnings releases.
  sources.sort((a, b) => {
    const ap = PERIODIC_FORM.test(a.form) ? 0 : 1;
    const bp = PERIODIC_FORM.test(b.form) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return b.filingDate.localeCompare(a.filingDate) || b.accessionNumber.localeCompare(a.accessionNumber);
  });

  const periodicSource = sources.find(s => PERIODIC_FORM.test(s.form));
  const stage: FilingReportStage = periodicSource ? "full_report" : "earnings_flash";
  const canonicalAccession = periodicSource?.accessionNumber ?? filing.accessionNumber;

  return {
    meta: {
      periodEnd,
      fiscalPeriod,
      stage,
      canonicalAccession,
      sources,
      hasTranscript,
    },
    companionMaterials,
    briefs,
  };
}

/** D1 statements that persist the quarter bundle metadata and alias pointers for companion accessions. */
export function quarterBundleStatements(
  db: D1Database,
  ticker: string,
  meta: FilingReportBundleMeta,
  at: string,
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [
    db.prepare("INSERT INTO sec_cache(cache_key, payload, fetched_at) VALUES(?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at")
      .bind(quarterBundleKey(ticker, meta.periodEnd), JSON.stringify(meta), at),
  ];
  for (const src of meta.sources) {
    if (src.accessionNumber === meta.canonicalAccession) continue;
    stmts.push(
      db.prepare("INSERT INTO sec_cache(cache_key, payload, fetched_at) VALUES(?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at")
        .bind(quarterAliasKey(ticker, src.accessionNumber), JSON.stringify({ canonicalAccession: meta.canonicalAccession, periodEnd: meta.periodEnd, stage: meta.stage }), at),
    );
  }
  return stmts;
}

/** Reads all persisted quarter bundles for a company, indexed by canonicalAccession and by every member accession. */
export async function readQuarterBundles(
  db: D1Database,
  ticker: string,
): Promise<Map<string, FilingReportBundleMeta>> {
  const prefix = quarterBundlePrefix(ticker);
  const rows = await db.prepare("SELECT payload FROM sec_cache WHERE cache_key >= ? AND cache_key < ?")
    .bind(prefix, `${prefix}\uffff`).all<{ payload: string }>();
  const byAccession = new Map<string, FilingReportBundleMeta>();
  for (const row of rows.results) {
    try {
      const meta = JSON.parse(row.payload) as FilingReportBundleMeta;
      byAccession.set(meta.canonicalAccession, meta);
      for (const src of meta.sources) {
        if (!byAccession.has(src.accessionNumber)) byAccession.set(src.accessionNumber, meta);
      }
    } catch { /* ignore malformed row */ }
  }
  return byAccession;
}

/** Resolves a companion accession (e.g. legacy 8-K URL) to its upgraded canonical quarterly report accession. */
export async function resolveQuarterCanonicalAccession(
  db: D1Database,
  ticker: string,
  accession: string,
): Promise<{ canonicalAccession: string; periodEnd: string; stage: FilingReportStage } | null> {
  const row = await db.prepare("SELECT payload FROM sec_cache WHERE cache_key = ?")
    .bind(quarterAliasKey(ticker, accession)).first<{ payload: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.payload) as { canonicalAccession: string; periodEnd: string; stage: FilingReportStage };
  } catch {
    return null;
  }
}
