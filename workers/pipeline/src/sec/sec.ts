import type { AnalysisFact, ManagerReview, PublishedSecReport, SecNodeSpecV2 } from "./analysis.ts";

export const SEC_SUMMARY_VERSION = 7;

const MAX_HEADING_CHARACTERS = 120;
const ITEM_HEADING_LEVEL = 2;
const BOLD_HEADING_LEVEL = 7;

export const BUSINESS_FILING_FORMS = new Set([
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

export type SecSummaryImportance = "high" | "medium" | "low";

/** What kind of event an 8-K/6-K discloses, used for differentiated presentation. */
export type SecEventCategory = "earnings_update" | "guidance" | "m&a" | "executive" | "legal" | "other";

export const SEC_EVENT_CATEGORIES: readonly SecEventCategory[] = ["earnings_update", "guidance", "m&a", "executive", "legal", "other"];

export function normalizeSecEventCategory(value: unknown): SecEventCategory | undefined {
  const candidate = String(value ?? "").trim().toLowerCase();
  return (SEC_EVENT_CATEGORIES as readonly string[]).includes(candidate) ? candidate as SecEventCategory : undefined;
}

export type SecSummaryBullet = {
  label: string;
  detail: string;
  importance: SecSummaryImportance;
};

export type SecHeadingCandidate = {
  title: string;
  level: number;
  start: number;
};

export type SecDocument = {
  text: string;
  headings: SecHeadingCandidate[];
};

export type SecNodeSpec = SecNodeSpecV2;

export type SecNodePlan = {
  nodes: SecNodeSpec[];
  outlineSections: number;
  clamped?: number;
  /** Planning defects worth publishing — invented history series ids. */
  warnings?: string[];
};

export type SecWorkflowEvidence = {
  start: number;
  end: number;
  score: number;
  reasons: string[];
  excerpt: string;
};

export type SecNodeResult = {
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
  readerVersion?: "sec-reader.v1";
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
  source: "deepseek" | "error";
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

const SEC_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1_000;

export function isSecFeedRefreshDue(feed: SecFilingFeed, nowMs = Date.now()): boolean {
  if (feed.status === "unsupported" || feed.status === "not_applicable") return false;
  if (feed.status === "pending" || feed.status === "stale" || !feed.fetchedAt) return true;
  const fetchedAt = Date.parse(feed.fetchedAt);
  return !Number.isFinite(fetchedAt) || nowMs - fetchedAt >= SEC_REFRESH_INTERVAL_MS;
}

export type SecCompany = {
  ticker: string;
  cik: string;
  cikNumber: number;
  name: string;
};

type SummaryFilingIdentity = Pick<SecFiling, "ticker" | "form" | "filingDate" | "accessionNumber">;

export function cleanSecTicker(value: string): string {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9.-]/g, "");
}

export function cleanSecAccession(value: string): string {
  return String(value ?? "").trim().replace(/[^0-9A-Za-z-]/g, "");
}

export function isBusinessFiling(form: string): boolean {
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

export function htmlToSecDocument(html: string): SecDocument {
  const source = stripSecNonContent(String(html ?? ""));
  const text = flattenSecHtml(source);
  const emphasis = collectSecEmphasis(source);
  const headings: SecHeadingCandidate[] = [];
  let cursor = 0;
  for (const line of text.split("\n")) {
    const title = line.trim();
    if (title) {
      const level = emphasis.get(title) ?? (isSecItemHeading(title) ? ITEM_HEADING_LEVEL : 0);
      if (level) headings.push({ title, level, start: cursor + line.length - line.trimStart().length });
    }
    cursor += line.length + 1;
  }
  return { text, headings };
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

function collectSecEmphasis(html: string): Map<string, number> {
  const levels = new Map<string, number>();
  const record = (raw: string, level: number) => {
    const title = flattenSecHtml(raw).replace(/\s+/g, " ").trim();
    if (!title || title.length > MAX_HEADING_CHARACTERS) return;
    levels.set(title, Math.min(levels.get(title) ?? level, level));
  };
  for (const match of html.matchAll(/<h([1-6])\b[^>]*>([\s\S]{0,400}?)<\/h\1\s*>/gi)) record(match[2], Number(match[1]));
  for (const match of html.matchAll(/<(b|strong)\b[^>]*>([\s\S]{0,400}?)<\/\1\s*>/gi)) record(match[2], BOLD_HEADING_LEVEL);
  for (const match of html.matchAll(/<([a-z]+)\b[^>]*font-weight\s*:\s*(?:bold(?:er)?|[6-9]00)[^>]*>([\s\S]{0,400}?)<\/\1\s*>/gi)) record(match[2], BOLD_HEADING_LEVEL);
  return levels;
}

function isSecItemHeading(value: string): boolean {
  return /^(?:part\s+[ivx]+|items?\s+\d{1,2}[a-z]?)\b/i.test(value.trim());
}

export function cleanSecNodeId(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** A single text document inside a SEC full-submission `<accession>.txt` stream. */
export type SecSubmissionPart = {
  /** SEC official `<TYPE>` marker, e.g. "8-K", "6-K", "EX-99.1". */
  type: string;
  filename: string;
  text: string;
};

/** Submission TYPE values worth parsing: the filing body plus real exhibits (XBRL exhibits excluded). */
const SEC_SUBMISSION_KEEP_TYPES = /^(?:(?:10-K|10-Q|20-F|8-K|6-K)(?:\/A)?|EX-(?!101)\S+)$/i;
/** Noise types that dominate submission size (GRAPHIC is base64 images) and must not enter memory. */
const SEC_SUBMISSION_DROP_TYPES = /^(GRAPHIC|XML|JSON|ZIP|EX-101\S*)$/i;

/**
 * Streams `<accession>.txt` (the SEC full-submission envelope) and returns only the text documents
 * that matter: the filing body and real exhibits like EX-99.1. The full envelope has a bounded
 * read budget; graphics are discarded once their document boundary is received.
 * The `<TYPE>` marker is authoritative and company-independent — file names are not (NVIDIA's press
 * release exhibits carry no "ex"/"99" hint at all).
 */
export async function streamSecSubmissionParts(
  cikNumber: number,
  accessionNumber: string,
  fetcher: typeof fetch,
  userAgent: string,
): Promise<SecSubmissionPart[]> {
  const accessionPath = accessionNumber.replaceAll("-", "");
  const url = `https://www.sec.gov/Archives/edgar/data/${cikNumber}/${accessionPath}/${accessionNumber}.txt`;
  const response = await fetcher(url, {
    cache: "no-store",
    headers: { accept: "text/plain,*/*", "user-agent": userAgent },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`SEC submission HTTP ${response.status}`);
  if (!response.body) throw new Error("SEC submission response had no body stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let documentChunks: string[] = [];
  const boundaryMarker = "</DOCUMENT>";
  const parts: SecSubmissionPart[] = [];
  let receivedBytes = 0;

  const handleDocument = (document: string) => {
    const type = (document.match(/<TYPE>[^\n<]*/) ?? [""])[0]?.replace(/<TYPE>/, "").trim() ?? "";
    if (!type || !SEC_SUBMISSION_KEEP_TYPES.test(type) || SEC_SUBMISSION_DROP_TYPES.test(type)) return;
    const filename = (document.match(/<FILENAME>[^\n<]*/) ?? [""])[0]?.replace(/<FILENAME>/, "").trim() ?? "";
    const bodyStart = document.indexOf("<TEXT>");
    const body = bodyStart === -1 ? "" : document.slice(bodyStart + 6);
    const text = body.replace(/<\/TEXT>[\s\S]*$/i, "").trim();
    if (text) parts.push({ type, filename, text });
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > 32 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("SEC submission exceeds 32 MiB text extraction budget");
    }
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf(boundaryMarker);
    while (boundary !== -1) {
      documentChunks.push(buffer.slice(0, boundary));
      handleDocument(documentChunks.join(""));
      documentChunks = [];
      buffer = buffer.slice(boundary + boundaryMarker.length);
      boundary = buffer.indexOf(boundaryMarker);
    }
    // Keep only the possible split delimiter. Re-scanning the entire accumulated filing on
    // every network chunk makes large annual submissions quadratic in CPU and allocations.
    const consumed = Math.max(0, buffer.length - (boundaryMarker.length - 1));
    if (consumed) documentChunks.push(buffer.slice(0, consumed));
    buffer = buffer.slice(consumed);
  }
  if ((documentChunks.join("") + buffer).includes("<DOCUMENT>")) throw new Error("SEC submission ended before document boundary");
  return parts;
}

/** Boilerplate fragments that identify filing-metadata bullets (signers, addresses, Item numbers). */
const EVENT_METADATA_PATTERNS = [
  /signat/i, /general counsel/i, /corporate secretary/i, /treasurer/i, /controller\b/i,
  /commission file/i, /irs employer/i, /date of report/i, /state of incorporation/i,
  /exact name of registrant/i, /address of principal/i, /item\s*\d/i, /exhibit\s*\d/i,
  /签署人?/, /报告日期/, /文件形式/, /注册地/, /委员会登记/, /主要办公地/,
] as const;

/** True when a bullet carries only filing metadata (form type, report date, signer, address, Item no.). */
export function isEventMetadataBullet(bullet: SecSummaryBullet): boolean {
  const sample = `${bullet.label}\n${bullet.detail}`;
  return EVENT_METADATA_PATTERNS.some((pattern) => pattern.test(sample));
}

/** True when every bullet is filing metadata — the model saw only the filing envelope, not the content. */
export function hasOnlyEventMetadataBullets(bullets: SecSummaryBullet[]): boolean {
  return bullets.length > 0 && bullets.every(isEventMetadataBullet);
}

export function normalizeSecSummary(
  value: unknown,
  filing: SummaryFilingIdentity,
  now = new Date(),
): SecFilingSummary {
  const input = asRecord(value) ?? {};
  const blocked = [/^.*did not contain readable text[.!]?$/i, /^(未找到|未定位到|无法读取)(原文|正文|文件)[。！]?$/, /^(需要|需|等待)(后续|人工)?复核[。！]?$/];
  const clean = (item: unknown, max: number) => String(item ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const useful = (item: string) => Boolean(item) && !blocked.some((pattern) => pattern.test(item));
  const rawBullets = Array.isArray(input.bullets) ? input.bullets : [];
  const bullets = rawBullets.flatMap((item): SecSummaryBullet[] => {
    const bullet = asRecord(item);
    const label = clean(bullet?.label, 24);
    const detail = clean(bullet?.detail, 320);
    if (!label || !useful(detail)) return [];
    const importance = bullet?.importance === "high" || bullet?.importance === "low" ? bullet.importance : "medium";
    return [{ label, detail, importance }];
  }).slice(0, 5);
  const headline = clean(input.headline, 180);
  const analystView = clean(input.analystView, 260);
  const eventCategory = normalizeSecEventCategory(input.eventCategory);
  const report = String(input.report ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 6_000);

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
    source: input.source === "error" ? "error" : "deepseek",
    generatedAt: typeof input.generatedAt === "string" ? input.generatedAt : now.toISOString(),
    ...(typeof input.error === "string" && input.error ? { error: clean(input.error, 240) } : {}),
  };
}

export function isSummaryRetryDue(summary: SecFilingSummary, nowMs = Date.now()): boolean {
  const fullReportForm = /^(10-K|10-Q|20-F)(\/A)?$/.test(summary.form);
  if (fullReportForm && summary.source !== "error" && (summary.version !== SEC_SUMMARY_VERSION || !summary.report)) return true;
  // Event summaries carry exhibit-grounded content from the current pipeline version; older ones
  // only contain filing-envelope metadata, so a version bump schedules one regeneration.
  const eventForm = /^(8-K|6-K)(\/A)?$/.test(summary.form);
  if (eventForm && summary.source !== "error" && summary.version !== SEC_SUMMARY_VERSION) return true;
  if (summary.headline || summary.bullets.length || summary.analystView) return false;
  if (summary.source !== "error") return true;
  if (summary.error === "DeepSeek HTTP 400") return true;
  const generatedAt = Date.parse(summary.generatedAt);
  return !Number.isFinite(generatedAt) || nowMs - generatedAt >= 24 * 60 * 60 * 1_000;
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
    const accessionPath = accessionNumber.replaceAll("-", "");
    const archiveRoot = `https://www.sec.gov/Archives/edgar/data/${company.cikNumber}/${accessionPath}`;
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
      indexUrl: `${archiveRoot}/${accessionNumber}-index.html`,
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
