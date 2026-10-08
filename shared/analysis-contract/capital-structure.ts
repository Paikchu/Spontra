/** Where a statement came from. Every amount in a statement shares this filing's presentation. */
export type CapitalSource = { accession: string; url: string; filedAt: string; form: string };

/** Economic role of a balance-sheet line, read from its concept and original label. Unmatched lines stay "other". */
export type AssetGroup = "cash" | "receivables" | "inventory" | "productive" | "leaseAssets" | "intangibles" | "investments" | "other";
export type LiabilityGroup = "debt" | "leases" | "customerAdvances" | "payables" | "deferredTax" | "other";
export type EquityGroup = "paidIn" | "retained" | "otherEquity" | "noncontrolling" | "redeemable";
export type OperatingGroup = "netIncome" | "nonCash" | "workingCapital" | "other";
export type InvestingGroup = "capex" | "acquisitions" | "investments" | "other";
export type FinancingGroup = "debtIssued" | "debtRepaid" | "equityIssued" | "buybacks" | "dividends" | "leasePrincipal" | "other";
export type SupplementalGroup = "interestPaid" | "taxesPaid" | "unpaidCapex" | "leaseAssetsObtained" | "other";

/**
 * One statement row. `value` is a decimal string in base currency units with the sign the statement
 * presents: outflows, contra-assets, treasury stock and accumulated deficits are negative.
 */
export type CapitalLine<G extends string> = { id: string; label: string; concept: string; group: G; value: string };

/** Every line reconciles: assets to total assets, liabilities plus equity to the balancing total. */
export type BalanceSheet = {
  asOf: string;
  currency: string;
  assets: CapitalLine<AssetGroup>[];
  liabilities: CapitalLine<LiabilityGroup>[];
  /** Includes redeemable (temporary) equity and noncontrolling interests, each in its own group. */
  equity: CapitalLine<EquityGroup>[];
  totals: { assets: string; liabilities: string; equity: string; currentAssets: string | null; currentLiabilities: string | null };
  source: CapitalSource;
};

/** `lines` is null when the section's rows could not be reconciled to its reported total. */
export type CashFlowSection<G extends string> = { total: string; lines: CapitalLine<G>[] | null };

export type CashFlowStatement = {
  periodStart: string;
  periodEnd: string;
  currency: string;
  /** "derived" is the difference of two cumulative statements with the same fiscal-year start. */
  basis: "reported" | "derived";
  formula?: string;
  operating: CashFlowSection<OperatingGroup>;
  investing: CashFlowSection<InvestingGroup>;
  financing: CashFlowSection<FinancingGroup>;
  fxEffect: string | null;
  netChange: string;
  /** Disclosed below the statement (cash interest, unpaid capex, leased assets); not part of the totals. */
  supplemental: CapitalLine<SupplementalGroup>[];
  sources: CapitalSource[];
};

export type CapitalQuarter = {
  periodEnd: string;
  balanceSheet: BalanceSheet | null;
  /** Exactly three months: reported directly, or derived from adjacent cumulative statements. */
  cashFlow: CashFlowStatement | null;
  /** The cumulative statement as filed (three, six, nine or twelve months). */
  yearToDate: CashFlowStatement | null;
};

/** Supplementary to the business flow: quarters without a reconciled statement are omitted, never estimated. */
export type PublicCapitalStructure = { schemaVersion: "capital-structure.v1"; ticker: string; quarters: CapitalQuarter[] };

/** Served on its own route so the business flow never waits for statement projection. */
export type CapitalResponse = { schemaVersion: "capital-response.v1"; status: "ready" | "unavailable"; capital: PublicCapitalStructure | null };

/** Per-filing projection, stored beside the archived statements. */
export type CapitalFiling = {
  version: string;
  source: CapitalSource;
  balanceSheet: BalanceSheet | null;
  cashFlow: CashFlowStatement | null;
  issues: string[];
};
