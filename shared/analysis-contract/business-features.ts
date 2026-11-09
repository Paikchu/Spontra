/**
 * The five analysis layers a company is switched through (docs/spontra-architecture-upgrade.md), lowest first. Each
 * layer reads only the products of the layers below it:
 *  1. `map`       the financial map: every past report's statements from EDGAR, nothing else. Its switch is the
 *                 whitelist (`financial_company_settings`).
 *  2. `filings`   SEC filing analysis: the filing library, each filing's summary, memory and item analysis —
 *                 the only layer that reads filing text.
 *  3. `findings`  company-level synthesis across filings: company analysis, findings, analyst dossiers, checkup notes.
 *  4. `tree`      the business breakdown: the mind map and the written explanation of each business, with web research.
 *  5. `valuation` the valuation assessment over everything below.
 */
export const LAYERS = ["map", "filings", "findings", "tree", "valuation"] as const;
export type Layer = typeof LAYERS[number];
/** The four layers above the map, whose switches live in `business_feature_settings`. */
export const FEATURES = ["filings", "findings", "tree", "valuation"] as const;
export type Feature = typeof FEATURES[number];
/** The layer each needs on first: the ladder. Opening a layer needs this one on; closing a layer closes every layer above. */
export const LAYER_REQUIRES: Record<Layer, Layer | null> = { map: null, filings: "map", findings: "filings", tree: "findings", valuation: "tree" };
/** A feature's switches as they apply to one company: whether Spontra Analysis runs it and whether the map shows it. */
export type FeatureSwitches = { generate: boolean; display: boolean };
