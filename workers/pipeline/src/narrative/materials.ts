import type { ExplainerSource } from "../../../../shared/analysis-contract/business-explainer.ts";
import { earningsEvents } from "../guidance/workflow.ts";
import { streamSecSubmissionParts, type SecFilingFeed } from "../sec/sec.ts";

/**
 * What the narrative writer reads: the business section of the latest annual report, the latest
 * earnings release, and the material-agreement and other-event items of recent current reports.
 * Each material travels with its source so every claim can cite it, and the writer sees nothing
 * it cannot cite. Text is capped per material so one long filing does not crowd the rest out.
 */
export type NarrativeMaterial = { source: ExplainerSource; kind: "annual_report" | "quarterly_report" | "earnings_release" | "current_report"; text: string };

const CAP = { annual_report: 48_000, quarterly_report: 24_000, earnings_release: 24_000, current_report: 6_000 } as const;
const MAX_CURRENT_REPORTS = 10;
const MONTHS_BACK = 15;

/** The annual report's business narrative: Item 1 up to the risk factors, or the first stretch of the document when the headings are not found. */
function businessSection(text: string): string {
  const start = text.search(/\bItem\s+1\.?\s+Business\b/i);
  const from = start >= 0 ? start : 0;
  const end = text.slice(from).search(/\bItem\s+1A\.?\s+Risk\s+Factors\b/i);
  return text.slice(from, end > 0 ? from + end : undefined);
}

/** A current report's own items, without the signature and exhibit index. */
function currentReportBody(text: string): string {
  const start = text.search(/\bItem\s+\d\.\d{2}\b/);
  const body = text.slice(start >= 0 ? start : 0);
  const end = body.search(/\bSIGNATURES?\b|\bItem\s+9\.01\b/);
  return end > 0 ? body.slice(0, end) : body;
}

const clip = (text: string, cap: number) => text.length <= cap ? text : `${text.slice(0, cap)}\n[...]`;

/** Reads the materials for one company from EDGAR, newest first; a part that cannot be read is skipped, never invented. */
export async function collectNarrativeMaterials(feed: SecFilingFeed, companyName: string, fetcher: typeof fetch, userAgent: string, now = Date.now()): Promise<NarrativeMaterial[]> {
  const sorted = [...feed.filings].sort((a, b) => b.filingDate.localeCompare(a.filingDate));
  const since = new Date(now); since.setUTCMonth(since.getUTCMonth() - MONTHS_BACK);
  const sinceDate = since.toISOString().slice(0, 10);
  const annual = sorted.find(f => /^(10-K|20-F)$/.test(f.form));
  const quarterly = sorted.find(f => f.form === "10-Q" && (!annual || f.filingDate > annual.filingDate));
  const earnings = new Set(earningsEvents(feed, now).map(e => e.accession));
  const release = sorted.find(f => earnings.has(f.accessionNumber));
  const currents = sorted.filter(f => /^(8-K|6-K)$/.test(f.form) && !earnings.has(f.accessionNumber) && f.filingDate >= sinceDate).slice(0, MAX_CURRENT_REPORTS);

  const out: NarrativeMaterial[] = [];
  const read = async (filing: SecFilingFeed["filings"][number], kind: NarrativeMaterial["kind"], pick: (parts: Awaited<ReturnType<typeof streamSecSubmissionParts>>) => string | null) => {
    try {
      const parts = await streamSecSubmissionParts(filing.cikNumber, filing.accessionNumber, fetcher, userAgent);
      const text = pick(parts);
      if (!text || text.trim().length < 400) return;
      out.push({ kind, text: clip(text, CAP[kind]), source: { id: `f-${filing.accessionNumber}`, title: `${companyName} ${filing.form} ${filing.filingDate}`, url: filing.documentUrl, kind: "sec", publishedAt: filing.filingDate } });
    } catch { /* One unreadable filing must not stop the others. */ }
  };
  const main = (form: string) => (parts: Awaited<ReturnType<typeof streamSecSubmissionParts>>) => parts.find(p => p.type.replace(/\/A$/, "") === form.replace(/\/A$/, ""))?.text ?? null;
  if (annual) await read(annual, "annual_report", parts => { const t = main(annual.form)(parts); return t ? businessSection(t) : null; });
  if (release) await read(release, "earnings_release", parts => parts.filter(p => /^EX-99/i.test(p.type)).map(p => p.text).join("\n\n") || null);
  if (quarterly) await read(quarterly, "quarterly_report", parts => { const t = main("10-Q")(parts); if (!t) return null; const i = t.search(/\bItem\s+2\.?\s+Management/i); return i >= 0 ? t.slice(i) : t; });
  for (const filing of currents) await read(filing, "current_report", parts => { const t = main(filing.form)(parts); return t ? currentReportBody(t) : null; });
  return out;
}
