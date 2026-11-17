import type { ImpactCalculation } from "./price-impact.ts";

/** The financial bridge of one reviewed filing edition, distinct from a company valuation. */
export type FilingInvestmentChain = {
  id: string; priorAssumption: string; newEvidence: string; revisedAssumption: string;
  financialEffect: string; valuationEffect: string;
  quantificationStatus: "quantifiable" | "sensitivity_only" | "not_quantifiable";
  sourceIds: string[]; computationRefs: string[]; missingInputs: string[];
  counterEvidence: string; verification: string; window: string;
};

/** Immutable, content-addressed data shared by the filing summary and its valuation detail. */
export type FilingImpactPublication = {
  schemaVersion: "filing-impact.v1";
  resultId: string;
  artifact: { id: string; ticker: string; accession: string; version: number; hash: string };
  title: string;
  financialPeriodEnd: string;
  sourcePublishedAt: string;
  researchAsOf: string;
  generatedAt: string;
  inputFingerprint: string;
  material: { ticker: string; accession: string; version: string };
  sourceMaterials: Array<{ ticker: string; accession: string; version: string }>;
  /** Technical validation is not a claim of human approval or public promotion. */
  validation: { kind: "technical"; semanticDigest: string; semanticReceipt: string };
  chains: FilingInvestmentChain[];
  calculations: Record<string, ImpactCalculation>;
  arithmetic: Record<string, { id: string; label: string; formula: string; inputs: Record<string, number>; value: number; unit: string }>;
  sources: Array<{ id: string; title: string; url: string | null; kind: "sec" | "web" | "data"; text: string; value?: number; unit?: string; shown?: string; periodStart?: string | null; periodEnd?: string | null }>;
  /** Financial sensitivities alone cannot establish a per-share event valuation. */
  priceEffect: { quantificationStatus: "not_quantifiable"; eventChange: null; referenceQuote: null; modelVersion: null; missingInputs: string[] };
};
