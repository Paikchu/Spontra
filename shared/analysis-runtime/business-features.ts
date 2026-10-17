import { FEATURES, type Feature } from "../analysis-contract/business-features.ts";

/** Whether a request names one of the switchable features. */
export const isFeature = (value: unknown): value is Feature => typeof value === "string" && (FEATURES as readonly string[]).includes(value);
