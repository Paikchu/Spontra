import {
  COMPANY_ANALYSIS_BLOCK_TYPES,
  COMPANY_ANALYSIS_MAX_BLOCKS_PER_HIGHLIGHT,
  COMPANY_ANALYSIS_MAX_HIGHLIGHTS,
  COMPANY_ANALYSIS_MIN_HIGHLIGHTS,
  COMPANY_ANALYSIS_OVERVIEW_LABEL,
} from "../../../../shared/analysis-contract/company-analysis.ts";
import type { BusinessDeepDive, CompanyAnalysisBlock, CompanyAnalysisCoverageStatus, CompanyAnalysisOverview, PublicCompanyAnalysisResponse } from "../../../../shared/analysis-contract/company-analysis.ts";
import type { ReportBlockImportance, ReportBlockTone } from "../../../../shared/analysis-contract/report-blocks.ts";
import { FUNDAMENTAL_METRIC_CATALOG, isFundamentalMetricKey, type FundamentalMetricKey } from "../fundamentals/fundamental-metrics.ts";
import {
  FUNDAMENTAL_CHART_MAX_AXES,
  FUNDAMENTAL_CHART_MAX_SERIES,
  type FundamentalTransform,
} from "../../../../shared/analysis-contract/fundamentals.ts";
export type { CompanyAnalysisCoverageStatus, CompanyAnalysisHighlight, CompanyAnalysisOverview, PublicCompanyAnalysisResponse } from "../../../../shared/analysis-contract/company-analysis.ts";
import { normalizeTrackedTicker } from "../sec/config.ts";
import type { AnalysisRunSummary } from "../../../../shared/analysis-contract/filings.ts";
import { ANALYSIS_API_SCHEMA_VERSION } from "../read-api/contract-support/versions.ts";

export const COMPANY_ANALYSIS_SCHEMA_VERSION = "company-analysis.v1";
/**
 * Bumped whenever the editorial prompt changes, not merely when the payload does. It feeds the
 * run's input hash, so a company already analysed under the previous label would otherwise be
 * deduplicated against that publication and never see the new prompt's output at all.
 */
export const COMPANY_ANALYSIS_PROMPT_VERSION = "business-deep-dive-react.v1";

export type CompanyAnalysisRunStatus =
  | "waiting_fundamentals"
  | "calculating"
  | "analyzing"
  | "validating"
  | "ready"
  | "insufficient_data"
  | "failed";

export type CompanyAnalysisPublication = {
  schemaVersion: typeof COMPANY_ANALYSIS_SCHEMA_VERSION;
  analysisId: string;
  ticker: string;
  triggerRef: string;
  periodId: string;
  periodEnd: string;
  reportLabel: string;
  inputHash: string;
  memoryVersion: number;
  fundamentalsDataVersion: string;
  status: Extract<CompanyAnalysisRunStatus, "ready">;
  coverageStatus: CompanyAnalysisCoverageStatus;
  overview: CompanyAnalysisOverview;
  modelVersion: string;
  promptVersion: string;
  generatedAt: string;
};

/** Where a run summary comes from when the backend could not read run history at all. */
export const UNKNOWN_ANALYSIS_RUN: AnalysisRunSummary = { state: "unknown", updatedAt: null, errorCode: null };
export const NO_ANALYSIS_RUN: AnalysisRunSummary = { state: "none", updatedAt: null, errorCode: null };

export class CompanyAnalysisValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanyAnalysisValidationError";
  }
}

export function normalizeCompanyAnalysisPublication(value: unknown): CompanyAnalysisPublication {
  const item = record(value);
  const ticker = normalizeTrackedTicker(text(item?.ticker));
  const analysisId = bounded(item?.analysisId, 160);
  const triggerRef = bounded(item?.triggerRef, 240);
  const periodId = bounded(item?.periodId, 200);
  const periodEnd = date(item?.periodEnd);
  const reportLabel = bounded(item?.reportLabel, 80);
  const inputHash = hash(item?.inputHash);
  const fundamentalsDataVersion = hash(item?.fundamentalsDataVersion);
  const modelVersion = bounded(item?.modelVersion, 120);
  const promptVersion = bounded(item?.promptVersion, 120);
  const generatedAt = timestamp(item?.generatedAt);
  const memoryVersion = integer(item?.memoryVersion, 0);
  const coverageStatus = item?.coverageStatus === "partial" ? "partial" : item?.coverageStatus === "complete" ? "complete" : null;
  if (
    item?.schemaVersion !== COMPANY_ANALYSIS_SCHEMA_VERSION || item?.status !== "ready" || !ticker ||
    !analysisId || !triggerRef || !periodId || !periodEnd || !reportLabel || !inputHash ||
    !fundamentalsDataVersion || !modelVersion || !promptVersion || !generatedAt ||
    memoryVersion === null || !coverageStatus
  ) throw new CompanyAnalysisValidationError("Company analysis publication metadata is invalid.");

  return {
    schemaVersion: COMPANY_ANALYSIS_SCHEMA_VERSION,
    analysisId,
    ticker,
    triggerRef,
    periodId,
    periodEnd,
    reportLabel,
    inputHash,
    memoryVersion,
    fundamentalsDataVersion,
    status: "ready",
    coverageStatus,
    overview: normalizeCompanyAnalysisOverview(item.overview),
    modelVersion,
    promptVersion,
    generatedAt,
  };
}

export function toPublicCompanyAnalysis(
  publication: CompanyAnalysisPublication,
  latestRun: AnalysisRunSummary = NO_ANALYSIS_RUN,
): PublicCompanyAnalysisResponse {
  return {
    apiSchemaVersion: ANALYSIS_API_SCHEMA_VERSION,
    schemaVersion: COMPANY_ANALYSIS_SCHEMA_VERSION,
    ticker: publication.ticker,
    status: "ready",
    analysisId: publication.analysisId,
    period: { periodId: publication.periodId, periodEnd: publication.periodEnd, label: publication.reportLabel },
    generatedAt: publication.generatedAt,
    coverageStatus: publication.coverageStatus,
    // Evidence references travel with the highlight they support. They used to be stripped here,
    // which left a consumer with prose and no way to reach the underlying observation.
    overview: publication.overview,
    latestRun,
    versions: {
      apiSchema: ANALYSIS_API_SCHEMA_VERSION,
      payloadSchema: COMPANY_ANALYSIS_SCHEMA_VERSION,
      contentRevision: publication.inputHash,
      model: publication.modelVersion,
      prompt: publication.promptVersion,
    },
  };
}

export function unavailableCompanyAnalysis(
  ticker: string,
  latestRun: AnalysisRunSummary = NO_ANALYSIS_RUN,
): PublicCompanyAnalysisResponse {
  return {
    apiSchemaVersion: ANALYSIS_API_SCHEMA_VERSION,
    schemaVersion: COMPANY_ANALYSIS_SCHEMA_VERSION,
    ticker,
    status: "unavailable",
    analysisId: null,
    period: null,
    generatedAt: null,
    coverageStatus: null,
    overview: null,
    latestRun,
    versions: {
      apiSchema: ANALYSIS_API_SCHEMA_VERSION,
      payloadSchema: COMPANY_ANALYSIS_SCHEMA_VERSION,
      contentRevision: null,
      model: null,
      prompt: null,
    },
  };
}

export type CompanyAnalysisOverviewOptions = {
  /**
   * The metric keys the analysis actually observed. Supplied when publishing, so a chart cannot
   * name a series the run never saw; absent when reading a stored publication back, where the
   * blocks already passed that check and the underlying feature pack is long gone.
   */
  chartMetricKeys?: ReadonlySet<string>;
};

export function normalizeCompanyAnalysisOverview(
  value: unknown,
  options: CompanyAnalysisOverviewOptions = {},
): CompanyAnalysisOverview {
  const item = record(value);
  // Applied on the read path too, so a publication written under the old free-form label re-frames
  // itself without waiting to be regenerated.
  const label = COMPANY_ANALYSIS_OVERVIEW_LABEL;
  const headline = prose(item?.headline, 180);
  const introduction = prose(item?.introduction, 1_200);
  // A generation that runs long is trimmed rather than rejected: the judgments are ordered by
  // importance, so the tail is what the editorial phase itself ranked least worth saying.
  const highlights = (Array.isArray(item?.highlights) ? item.highlights : [])
    .slice(0, COMPANY_ANALYSIS_MAX_HIGHLIGHTS)
    .map((raw, index) => {
      const highlight = record(raw);
      const ordinal = String(index + 1).padStart(2, "0");
      const blocks = normalizeHighlightBlocks(highlight?.blocks, ordinal, options);
      return {
        ordinal,
        title: prose(highlight?.title, 100),
        body: prose(highlight?.body, 700),
        evidenceRefs: strings(highlight?.evidenceRefs, 16, 240),
        ...(blocks.length ? { blocks } : {}),
      };
    });
  if (!headline || !introduction
    || highlights.length < COMPANY_ANALYSIS_MIN_HIGHLIGHTS
    || highlights.some((highlight) => !highlight.title || !highlight.body || !highlight.evidenceRefs.length)) {
    throw new CompanyAnalysisValidationError(`Company analysis overview must contain one headline, one introduction, and at least ${COMPANY_ANALYSIS_MIN_HIGHLIGHTS} evidence-backed highlights.`);
  }
  const deepDive = item?.deepDive === undefined ? undefined : normalizeBusinessDeepDive(item.deepDive);
  return { label: deepDive ? "公司业务拆解" : label, headline, introduction, highlights, ...(deepDive ? { deepDive } : {}) };
}

const BUSINESS_SECTION_KEYS = new Set<BusinessDeepDive["sections"][number]["key"]>([
  "business", "mechanics", "customers", "revenue", "economics", "financials", "industry", "moat", "risks", "investment",
]);
const REQUIRED_BUSINESS_KEYS = ["business", "mechanics", "revenue", "financials", "industry", "moat", "risks", "investment"] as const;

export function normalizeBusinessDeepDive(value: unknown): BusinessDeepDive {
  const item = record(value);
  const headline = prose(item?.headline, 180);
  const introduction = prose(item?.introduction, 1_200);
  const sources = (Array.isArray(item?.sources) ? item.sources : []).slice(0, 32).map((raw) => {
    const source = record(raw);
    const url = bounded(source?.url, 2_000);
    let validUrl = false;
    try {
      const parsed = new URL(url);
      validUrl = parsed.protocol === "https:" && !parsed.username && !parsed.password;
    } catch { /* Invalid source. */ }
    return {
      id: bounded(source?.id, 80), title: prose(source?.title, 240), url, validUrl,
      kind: source?.kind === "sec" ? "sec" as const : "web" as const,
      publishedAt: typeof source?.publishedAt === "string" && timestamp(source.publishedAt) ? source.publishedAt : null,
      retrievedAt: timestamp(source?.retrievedAt),
    };
  });
  const sourceIds = new Set(sources.map((source) => source.id));
  if (!headline || !introduction || !sources.length || sources.some((source) => !source.id || !source.title || !source.validUrl || !source.retrievedAt)
    || sourceIds.size !== sources.length) throw new CompanyAnalysisValidationError("Business analysis sources are invalid.");

  const sections = (Array.isArray(item?.sections) ? item.sections : []).slice(0, 12).map((raw) => {
    const section = record(raw);
    const key = text(section?.key);
    const paragraphs = (Array.isArray(section?.paragraphs) ? section.paragraphs : []).slice(0, 5).map((rawParagraph) => {
      const paragraph = record(rawParagraph);
      const rawIds = paragraph?.sourceIds;
      if (!Array.isArray(rawIds) || rawIds.length < 1 || rawIds.length > 8
        || rawIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 80 || !sourceIds.has(id.trim()))) {
        throw new CompanyAnalysisValidationError("Business analysis contains a fabricated citation.");
      }
      return { text: prose(paragraph?.text, 1_500), sourceIds: rawIds.map((id: string) => id.trim()) };
    });
    if (!BUSINESS_SECTION_KEYS.has(key as BusinessDeepDive["sections"][number]["key"]) || !prose(section?.title, 120)
      || !paragraphs.length || paragraphs.some((paragraph) => !paragraph.text || !paragraph.sourceIds.length
        || paragraph.sourceIds.some((id) => !sourceIds.has(id)))) {
      throw new CompanyAnalysisValidationError("Business analysis contains an unsupported or unsourced section.");
    }
    return { key: key as BusinessDeepDive["sections"][number]["key"], title: prose(section?.title, 120), paragraphs };
  });
  const keys = new Set(sections.map((section) => section.key));
  if (keys.size !== sections.length || REQUIRED_BUSINESS_KEYS.some((key) => !keys.has(key))) {
    throw new CompanyAnalysisValidationError("Business analysis is missing a core business-model section.");
  }
  return {
    headline, introduction, sections,
    sources: sources.map(({ validUrl: _validUrl, ...source }) => source),
    limitations: strings(item?.limitations, 12, 400),
  };
}

/**
 * A judgment's chosen forms, narrowed to what the page can render.
 *
 * An unusable block is dropped rather than failing the overview: the judgment's title and prose are
 * what carry it, and losing a whole quarter's analysis because one chart named a metric the run did
 * not observe trades a small omission for a large one. The prose is never dropped this way.
 */
function normalizeHighlightBlocks(
  value: unknown,
  ordinal: string,
  options: CompanyAnalysisOverviewOptions,
): CompanyAnalysisBlock[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<string>(COMPANY_ANALYSIS_BLOCK_TYPES);
  return value
    .slice(0, COMPANY_ANALYSIS_MAX_BLOCKS_PER_HIGHLIGHT)
    .flatMap((raw, index): CompanyAnalysisBlock[] => {
      const block = record(raw);
      const type = text(block?.type);
      if (!block || !allowed.has(type)) return [];
      // Positional, like the ordinal above: an id the model chose would not survive regeneration.
      const id = `company-block-${ordinal}-${index + 1}`;
      if (type === "prose") {
        const body = prose(block.text, 700);
        return body ? [{ type: "prose" as const, id, ...titleOf(block), text: body }] : [];
      }
      if (type === "callout") {
        const body = prose(block.text, 400);
        const tone: ReportBlockTone = TONES.has(text(block.tone)) ? text(block.tone) as ReportBlockTone : "neutral";
        return body ? [{ type: "callout" as const, id, tone, ...titleOf(block), text: body }] : [];
      }
      if (type === "key_points") {
        const points = (Array.isArray(block.points) ? block.points : []).slice(0, 5).flatMap((entry) => {
          const point = record(entry);
          const label = prose(point?.label, 40);
          const detail = prose(point?.detail, 240);
          if (!label && !detail) return [];
          const importance: ReportBlockImportance = IMPORTANCE.has(text(point?.importance))
            ? text(point?.importance) as ReportBlockImportance
            : "medium";
          return [{ label, detail, importance }];
        });
        return points.length ? [{ type: "key_points" as const, id, ...titleOf(block), points }] : [];
      }
      const title = prose(block.title, 100);
      const series = chartSeriesFor(block.series, options);
      if (!title || !series.length) return [];
      return [{
        type: "chart" as const,
        id,
        title,
        ...(prose(block.caption, 200) ? { caption: prose(block.caption, 200) } : {}),
        series,
      }];
    });
}

type ChartSeries = Extract<CompanyAnalysisBlock, { type: "chart" }>["series"];

/**
 * Narrows a chart to one the renderer can actually build.
 *
 * `buildFundamentalChartModel` throws on an empty series, too many series, an unknown metric, an
 * unsupported transform, a duplicate `metricKey:transform`, or more than two distinct axis units.
 * The renderer catches its own throw and shows 「这组指标暂时不能叠加」 —話術 written for someone
 * picking metrics interactively, not something to publish into an analysis. So every one of those
 * conditions is settled here instead, and `tests/company-analysis.test.ts` feeds this function's
 * output straight into the renderer's builder to keep the two from drifting apart.
 */
function chartSeriesFor(value: unknown, options: CompanyAnalysisOverviewOptions): ChartSeries {
  const parsed = (Array.isArray(value) ? value : []).flatMap(chartSeries(options));
  const seen = new Set<string>();
  const axisKeys = new Set<string>();
  const series: ChartSeries = [];
  for (const entry of parsed) {
    // The renderer keys a series by metric and transform, and rejects a repeat outright.
    const id = `${entry.metricKey}:${entry.transform}`;
    if (seen.has(id)) continue;
    // Two axes is the ceiling. A third unit family would take the chart down, so it is left out
    // rather than allowed to replace the whole panel with an error.
    const axisKey = chartAxisKey(entry.metricKey, entry.transform);
    if (!axisKeys.has(axisKey) && axisKeys.size >= FUNDAMENTAL_CHART_MAX_AXES) continue;
    seen.add(id);
    axisKeys.add(axisKey);
    series.push(entry);
    if (series.length >= FUNDAMENTAL_CHART_MAX_SERIES) break;
  }
  return series;
}

/**
 * Mirrors `axisKeyForSeries` in the Web service, which the architecture boundary keeps out of
 * reach. Currency and per-share units carry the company's own currency there; within one company
 * that is a single value, so the family alone partitions the series the same way.
 */
function chartAxisKey(metricKey: FundamentalMetricKey, transform: FundamentalTransform | undefined): string {
  if (transform && transform !== "value") return "percent";
  const unitFamily = FUNDAMENTAL_METRIC_CATALOG[metricKey].unitFamily;
  return unitFamily === "percent" ? "percent" : unitFamily;
}

function chartSeries(options: CompanyAnalysisOverviewOptions) {
  return (raw: unknown): ChartSeries => {
    const entry = record(raw);
    const metricKey = text(entry?.metricKey);
    if (!isFundamentalMetricKey(metricKey)) return [];
    if (options.chartMetricKeys && !options.chartMetricKeys.has(metricKey)) return [];
    const definition = FUNDAMENTAL_METRIC_CATALOG[metricKey];
    const transform = definition.allowedTransforms.find((allowedTransform) => allowedTransform === text(entry?.transform));
    const mark = text(entry?.mark) === "bar" || text(entry?.mark) === "line" ? text(entry?.mark) as "bar" | "line" : definition.defaultMark;
    // No axis is carried through, whatever the model wrote. Dropping the field from the type does
    // not stop a spread from putting it on the object at runtime, and an explicitly requested side
    // is the only way a chart reaches AXIS_CONFLICT.
    return [{ metricKey, mark, transform: transform ?? definition.allowedTransforms[0]! }];
  };
}

const TONES = new Set<string>(["neutral", "positive", "negative", "caution"] satisfies ReportBlockTone[]);
const IMPORTANCE = new Set<string>(["high", "medium", "low"] satisfies ReportBlockImportance[]);

function titleOf(block: Record<string, unknown>): { title?: string } {
  const title = prose(block.title, 100);
  return title ? { title } : {};
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function bounded(value: unknown, max: number): string {
  const result = text(value);
  return result && result.length <= max ? result : "";
}

/**
 * Prose written by a model, kept rather than refused when it runs long.
 *
 * `bounded` returns "" past its limit, which is right for an identifier — a truncated analysisId is
 * a corrupt one — and wrong for prose. A body one character over the cap emptied the field, failed
 * the overview and took the whole run with it, so a model with no character counter could lose a
 * quarter's analysis by writing a long paragraph. Length is a layout constraint, not a validity
 * one; it is enforced by cutting.
 *
 * Split into code points so a cut cannot land inside a surrogate pair and leave a broken character.
 */
function prose(value: unknown, max: number): string {
  const result = text(value);
  const characters = Array.from(result);
  return characters.length <= max ? result : `${characters.slice(0, max - 1).join("")}…`;
}

function strings(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(text).filter((item) => item && item.length <= maxLength).slice(0, maxItems);
}

function hash(value: unknown): string {
  const result = text(value);
  return /^[a-zA-Z0-9:_-]{8,256}$/.test(result) ? result : "";
}

function date(value: unknown): string {
  const result = text(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : "";
}

function timestamp(value: unknown): string {
  const result = text(value);
  return result && Number.isFinite(Date.parse(result)) ? result : "";
}

function integer(value: unknown, min: number): number | null {
  return Number.isInteger(value) && Number(value) >= min ? Number(value) : null;
}
