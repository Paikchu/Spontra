import type { TranslatedResource } from "../analysis-runtime/translation.ts";
import type { Locale } from "../analysis-runtime/locale.ts";

/** One resource of one company as the translator sees it: how many of its prose strings are translated. */
export type TranslationResourceSummary = {
  resource: TranslatedResource;
  /** A filing's accession for one full report; empty for the company-wide resources. */
  scope: string;
  total: number;
  translated: number;
  rejected: number;
  /** When the read API's table for it was last written; null before the first run. */
  publishedAt: string | null;
};

/** One English string with what the translator did with it. `pending` has not been translated yet. */
export type TranslationEntry = {
  resource: TranslatedResource;
  scope: string;
  source: string;
  text: string | null;
  status: "ready" | "rejected" | "pending";
  problems: string[];
  at: string | null;
};

export type TranslationsAdmin = {
  ticker: string;
  locale: Locale;
  version: string;
  enabled: boolean;
  /** Model calls used today across all companies, against the daily cap. */
  budget: { day: string; used: number; cap: number };
  /** The translation run in progress, if any. */
  run: { instanceId: string; startedAt: string } | null;
  resources: TranslationResourceSummary[];
  /** Rejected first, then pending, then translated; capped for the page. */
  entries: TranslationEntry[];
  truncated: boolean;
};
