import type { AnalysisFact, ManagerReview, PublishedSecReport, SecNodeSpecV2 } from "./analysis.ts";
import { canonicalTicker } from "../../../../shared/analysis-runtime/financial-data/policy.ts";
import { secArchiveDocumentUrl, secArchiveRoot } from "../../../../shared/analysis-runtime/sec-sources.ts";

/** 8: English summaries with English-sized limits (7 was the last Chinese one). */
export const SEC_SUMMARY_VERSION = 8;

/**
 * Event-summary field limits, sized for English (about 2.5x the Chinese characters). They stay within
 * the events publication schema (shared/analysis-runtime/events.ts: headline 400, label 120, detail 1200,
 * analystView 1200), which copies these summaries onto the event rail.
 */
const SEC_SUMMARY_LIMITS = { label: 60, detail: 800, headline: 400, analystView: 650, report: 15_000, error: 240 } as const;

/**
 * Shortens text to at most `max` characters on a word boundary, ending with an ellipsis. Text with no
 * usable space before the limit (CJK, long tokens) is cut at the limit instead.
 */
function clipText(value: string, max: number): string {
  if (value.length <= max) return value;
  const room = value.slice(0, Math.max(0, max - 1));
  const boundary = room.search(/\s\S*$/);
  const cut = boundary >= max * 0.6 ? room.slice(0, boundary) : room;
  return `${cut.replace(/[\s,;:.\-–—(]+$/, "")}…`;
}

const BUSINESS_FILING_FORMS = new Set([
  "10-K",
  "10-Q",
  "8-K",
  "20-F",
  "6-K",
  "10-K/A",
  "10-Q/A",
  "8-K/A",
  "20-F/A",
  "6-K/A",
]);

type SecSummaryImportance = "high" | "medium" | "low";

/** What kind of event an 8-K/6-K discloses, used for differentiated presentation. */
type SecEventCategory = "earnings_update" | "guidance" | "m&a" | "executive" | "legal" | "other";

const SEC_EVENT_CATEGORIES: readonly SecEventCategory[] = ["earnings_update", "guidance", "m&a", "executive", "legal", "other"];

function normalizeSecEventCategory(value: unknown): SecEventCategory | undefined {
  const candidate = String(value ?? "").trim().toLowerCase();
  return (SEC_EVENT_CATEGORIES as readonly string[]).includes(candidate) ? candidate as SecEventCategory : undefined;
}

type SecSummaryBullet = {
  label: string;
  detail: string;
  importance: SecSummaryImportance;
};

type SecNodeSpec = SecNodeSpecV2;

type SecNodePlan = {
  nodes: SecNodeSpec[];
  outlineSections: number;
  clamped?: number;
  /** Planning defects worth publishing — invented history series ids. */
  warnings?: string[];
};

type SecWorkflowEvidence = {
  start: number;
  end: number;
  score: number;
  reasons: string[];
  excerpt: string;
};

type SecNodeResult = {
  id: string;
  title: string;
  status: "complete" | "empty" | "error";
  findings: SecSummaryBullet[];
  narrative: string;
  facts?: AnalysisFact[];
  evidence: SecWorkflowEvidence[];
  evidenceIds?: string[];
  error?: string;
};

export type SecFiling = {
  earningsGroup?: import("../../../../shared/analysis-contract/report.ts").SecEarningsGroup;
  ticker: string;
  cik: string;
  cikNumber: number;
  companyName: string;
  form: string;
  filingDate: string;
  reportDate: string;
  accessionNumber: string;
  primaryDocument: string;
  description: string;
  items: string;
  documentUrl: string;
  indexUrl: string;
};

export type SecFilingSummary = {
  readerVersion?: "sec-reader.v1" | "sec-reader.v2";
  discovery?: import("../../../../shared/analysis-contract/report.ts").SecDiscovery;
  earningsGroup?: import("../../../../shared/analysis-contract/report.ts").SecEarningsGroup;
  ticker: string;
  form: string;
  filingDate: string;
  accessionNumber: string;
  headline: string;
  bullets: SecSummaryBullet[];
  analystView: string;
  /** Event filings only: what kind of 8-K/6-K this is. */
  eventCategory?: SecEventCategory;
  report?: string;
  version?: number;
  nodes?: SecNodeResult[];
  plan?: SecNodePlan;
  managerReview?: ManagerReview;
  repairRounds?: number;
  /** Who wrote the summary: "filing" is the document's own statement; older model summaries keep "deepseek"; "error" marks a failed run. */
  source: "claude" | "deepseek" | "filing" | "error";
  /** Written by the filing path's Pi session; such a summary carries the whole report and supersedes any earlier analysis. */
  generatedBy?: "pi";
  generatedAt: string;
  error?: string;
};

export type SecFilingWithSummary = SecFiling & {
  summary: SecFilingSummary | null;
  analysis?: PublishedSecReport | null;
};

export type SecFilingFeed = {
  ticker: string;
  company: { ticker: string; cik: string; name: string } | null;
  filings: SecFilingWithSummary[];
  fetchedAt: string | null;
  status: "ready" | "empty" | "pending" | "unsupported" | "not_applicable" | "stale";
  error?: string;
};

export type SecCompany = {
  ticker: string;
  cik: string;
  cikNumber: number;
  name: string;
};

type SummaryFilingIdentity = Pick<SecFiling, "ticker" | "form" | "filingDate" | "accessionNumber">;

/** A ticker as the request wrote it, canonical (a second share class is the class the data is kept under), with stray characters dropped. */
export function cleanSecTicker(value: string): string {
  return canonicalTicker(String(value ?? "")).replace(/[^A-Z0-9.-]/g, "");
}

export function cleanSecAccession(value: string): string {
  return String(value ?? "").trim().replace(/[^0-9A-Za-z-]/g, "");
}

function isBusinessFiling(form: string): boolean {
  return BUSINESS_FILING_FORMS.has(form);
}

export function sortSecFilings(filings: SecFiling[]): SecFiling[] {
  return [...filings].sort((left, right) => {
    const filingDate = right.filingDate.localeCompare(left.filingDate);
    if (filingDate !== 0) return filingDate;
    return 0;
  });
}

export function htmlToSecText(html: string): string {
  return flattenSecHtml(stripSecNonContent(String(html ?? "")));
}

function stripSecNonContent(html: string): string {
  return html
    .replace(/<ix:header[\s\S]*?<\/ix:header>/gi, " ")
    .replace(/<xbrli:context[\s\S]*?<\/xbrli:context>/gi, " ")
    .replace(/<xbrli:unit[\s\S]*?<\/xbrli:unit>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
}

function flattenSecHtml(html: string): string {
  return decodeEntities(html
    .replace(/<\/(p|div|tr|table|section|article|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim());
}

export function normalizeSecSummary(
  value: unknown,
  filing: SummaryFilingIdentity,
  now = new Date(),
): SecFilingSummary {
  const input = asRecord(value) ?? {};
  const blocked = [/^.*did not contain readable text[.!]?$/i, /^(?:not found|could not (?:locate|find|read)) (?:the )?(?:source|filing|document|text)[.!]?$/i,
    /^(?:needs?|requires?|awaiting|pending) (?:further |manual |follow-up )?review[.!]?$/i,
    /^(未找到|未定位到|无法读取)(原文|正文|文件)[。！]?$/, /^(需要|需|等待)(后续|人工)?复核[。！]?$/];
  const clean = (item: unknown, max: number) => clipText(String(item ?? "").replace(/\s+/g, " ").trim(), max);
  const useful = (item: string) => Boolean(item) && !blocked.some((pattern) => pattern.test(item));
  const rawBullets = Array.isArray(input.bullets) ? input.bullets : [];
  const bullets = rawBullets.flatMap((item): SecSummaryBullet[] => {
    const bullet = asRecord(item);
    const label = clean(bullet?.label, SEC_SUMMARY_LIMITS.label);
    const detail = clean(bullet?.detail, SEC_SUMMARY_LIMITS.detail);
    if (!label || !useful(detail)) return [];
    const importance = bullet?.importance === "high" || bullet?.importance === "low" ? bullet.importance : "medium";
    return [{ label, detail, importance }];
  }).slice(0, 5);
  const headline = clean(input.headline, SEC_SUMMARY_LIMITS.headline);
  const analystView = clean(input.analystView, SEC_SUMMARY_LIMITS.analystView);
  const eventCategory = normalizeSecEventCategory(input.eventCategory);
  const report = clipText(String(input.report ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim(), SEC_SUMMARY_LIMITS.report);

  return {
    ticker: cleanSecTicker(filing.ticker),
    form: String(filing.form ?? ""),
    filingDate: String(filing.filingDate ?? ""),
    accessionNumber: cleanSecAccession(filing.accessionNumber),
    headline: useful(headline) ? headline : "",
    bullets,
    analystView: useful(analystView) ? analystView : "",
    ...(eventCategory ? { eventCategory } : {}),
    ...(useful(report) ? { report } : {}),
    ...(Number.isInteger(input.version) ? { version: Number(input.version) } : {}),
    source: input.source === "error" ? "error" : input.source === "deepseek" ? "deepseek" : input.source === "filing" ? "filing" : "claude",
    generatedAt: typeof input.generatedAt === "string" ? input.generatedAt : now.toISOString(),
    ...(typeof input.error === "string" && input.error ? { error: clean(input.error, SEC_SUMMARY_LIMITS.error) } : {}),
  };
}

export function parseSecSubmissions(payload: unknown, company: SecCompany, limit = 5): SecFiling[] {
  const root = asRecord(payload);
  const filingsRoot = asRecord(root?.filings);
  const recent = asRecord(filingsRoot?.recent);
  const accessions = asArray(recent?.accessionNumber);
  const forms = asArray(recent?.form);
  const filingDates = asArray(recent?.filingDate);
  const reportDates = asArray(recent?.reportDate);
  const primaryDocuments = asArray(recent?.primaryDocument);
  const descriptions = asArray(recent?.primaryDocDescription);
  const items = asArray(recent?.items);
  const companyName = typeof root?.name === "string" && root.name ? root.name : company.name;

  const filings = accessions.flatMap((accessionValue, index): SecFiling[] => {
    const accessionNumber = String(accessionValue ?? "");
    const form = String(forms[index] ?? "");
    const primaryDocument = String(primaryDocuments[index] ?? "");
    if (!isBusinessFiling(form) || !accessionNumber || !primaryDocument) return [];
    const archiveRoot = secArchiveRoot(company.cikNumber, accessionNumber);
    return [{
      ticker: company.ticker,
      cik: company.cik,
      cikNumber: company.cikNumber,
      companyName,
      form,
      filingDate: String(filingDates[index] ?? ""),
      reportDate: String(reportDates[index] ?? ""),
      accessionNumber,
      primaryDocument,
      description: String(descriptions[index] ?? ""),
      items: String(items[index] ?? ""),
      documentUrl: `${archiveRoot}/${primaryDocument}`,
      indexUrl: secArchiveDocumentUrl(archiveRoot, `${accessionNumber}-index.html`),
    }];
  });

  return sortSecFilings(filings).slice(0, Math.max(0, limit));
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16)));
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}
