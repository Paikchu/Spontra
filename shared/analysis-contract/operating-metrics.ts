import type { ExplainerSource } from "./business-explainer.ts";

/**
 * Operating quantities a company reports about itself outside the financial statements: power
 * in use and under contract, data centers, GPUs delivered, cloud regions, customers, employees.
 * Each observation is a number copied from a sentence the company wrote, and the sentence travels
 * with it; an observation whose number is not in its quote, or whose quote is not in the source,
 * is never published. The vocabulary is open: the extractor names each metric from the company's
 * own words, so a nuclear developer and a GPU cloud do not share a fixed list.
 */
export const OPERATING_UNITS = ["MW", "count", "percent"] as const;
export type OperatingUnit = (typeof OPERATING_UNITS)[number];

/** What the series measures, so figures know which pairs belong on one chart. */
export const OPERATING_ROLES = ["in_use", "contracted", "pipeline", "delivered", "installed", "customers", "other"] as const;
export type OperatingRole = (typeof OPERATING_ROLES)[number];

export type OperatingObservation = {
  /** The date the value is true at (a balance) or the end of the period it covers. */
  asOf: string;
  /** In the metric's unit; GW are stored as MW, "more than" and "approximately" as the number stated. */
  value: number;
  /** `point` for a balance at `asOf`; `period` for a flow over the quarter or year ending there. */
  basis: "point" | "period";
  /** Verbatim from the source, at most 300 characters, containing the number. */
  quote: string;
  sourceId: string;
};

export type OperatingMetric = {
  /** Stable slug the extractor assigns, e.g. `active_power`; figures bind to it. */
  key: string;
  /** At most 16 characters, Simplified Chinese. */
  label: string;
  unit: OperatingUnit;
  role: OperatingRole;
  /** A metric this one is the counterpart of (contracted power for active power), by key. */
  pairWith?: string | null;
  /** The company's own term for what is counted, e.g. "active power", "data centers". */
  subject: string;
  observations: OperatingObservation[];
};

export type OperatingMetricsPublication = {
  schemaVersion: "operating-metrics.v1";
  ticker: string;
  generatedAt: string;
  /** Model name, or "authored" for a human-written set. */
  model: string;
  metrics: OperatingMetric[];
  sources: ExplainerSource[];
};

export type OperatingMetricsResponse = {
  schemaVersion: "operating-metrics-response.v1";
  status: "ready" | "preparing";
  metrics: OperatingMetricsPublication | null;
};
