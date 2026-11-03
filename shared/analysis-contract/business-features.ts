/**
 * The reader-facing features the admin switches per company (docs/whitelist-feature-switches-design.md). Each maps to
 * Spontra Analysis tasks that produce it; the financial map itself is the whitelist and has no switch. `tree` is the
 * business breakdown the map shows as one panel: the mind map and the written explanation of each business.
 */
export const FEATURES = ["reports", "findings", "tree", "valuation"] as const;
export type Feature = typeof FEATURES[number];

/** A feature's switches as they apply to one company: whether Spontra Analysis runs it and whether the map shows it. */
export type FeatureSwitches = { generate: boolean; display: boolean };
