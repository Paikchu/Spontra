import type { BusinessFlowQuarter, PublicBusinessFlow } from "@/shared/analysis-contract/business-flow";
import type { CapitalMetric, FindingPassage, FindingsPublication } from "@/shared/analysis-contract/findings";
import type { PeersPublication } from "@/shared/analysis-contract/peers";
import type { PublicCapitalStructure } from "@/shared/analysis-contract/capital-structure";
import type { GuidancePublication } from "@/shared/analysis-contract/guidance";
import type { RevenueHistory } from "@/shared/analysis-contract/revenue-history";
import { verifyFindings, type FindingData, type FindingFundamentals, type VerifiedFinding } from "@/shared/analysis-runtime/findings";
import { getLocale, labels, type Locale } from "@/packages/web/src/i18n";

export type { VerifiedFinding };

export const KIND_LABEL: Record<VerifiedFinding["kind"], string> = labels({ risk: "Risk", strength: "Strength", shift: "Shift", watch: "Watch" }, { risk: "风险", strength: "优势", shift: "变化", watch: "跟踪" });
export const VIEW_LABEL = labels({ profit: "Profit", cash: "Cash flow", balance: "Balance sheet" }, { profit: "利润", cash: "现金流", balance: "资产负债表" });

export function findingData(flow: PublicBusinessFlow, history: RevenueHistory | null, capital: PublicCapitalStructure | null, fundamentals: FindingFundamentals | null, guidance: GuidancePublication | null, peers: PeersPublication | null = null, passages: FindingPassage[] | null = null): FindingData {
  return { quarters: flow.quarters, history, capital, fundamentals, guidance, peers, passages };
}

/** Findings the page can stand behind, most severe first; their figures named in the reader's language. */
export function verifiedFindings(publication: FindingsPublication | null, data: FindingData, locale: Locale = getLocale()): VerifiedFinding[] {
  return publication ? verifyFindings(publication, data, locale).verified : [];
}

/** Sankey node names a finding lights on the profit statement: its businesses, and the statement lines it names. */
export function anchorNodeNames(f: VerifiedFinding, quarter: BusinessFlowQuarter | undefined, items: Array<{ id: string; key: string }>): Set<string> {
  const names = new Set<string>();
  for (const id of f.anchors.nodeIds) { const item = items.find(i => i.id === id); if (item) names.add("segment:" + item.key); }
  for (const metric of f.anchors.metrics) {
    // Operating-expense lines are drawn as their disclosed components when the quarter has them.
    const group = metric === "research" || metric === "sales" || metric === "administration" ? metric : metric === "operatingExpenses" ? "direct" : null;
    const components = group ? quarter?.expenseComponents?.filter(c => c.group === group) ?? [] : [];
    if (components.length) components.forEach(c => names.add("expense:" + c.id));
    else if (metric === "other" && quarter?.otherComponents?.length) quarter.otherComponents.forEach(c => names.add("other:" + c.id));
    else names.add(metric);
  }
  return names;
}

/** Pool item keys a finding lights on the cash-flow or balance-sheet pool (see capital-model's item keys). */
export function anchorPoolKeys(f: VerifiedFinding): Set<string> {
  const keys = new Set<string>();
  const add = (...list: string[]) => list.forEach(k => keys.add(k));
  for (const metric of f.anchors.capital ?? []) {
    switch (metric as CapitalMetric) {
      case "operatingCashFlow": add("operating", "operating-burn"); break;
      case "capex": add("capex", "capex-out"); break;
      case "freeCashFlow": add("operating", "operating-burn", "capex", "capex-out"); break;
      case "financing": add("debt-issued", "debt-issued-out", "debt-repaid", "debt-repaid-out", "equity", "equity-out", "buybacks", "buybacks-out", "dividends", "dividends-out", "lease", "lease-out"); break;
      case "debtIssued": add("debt-issued", "debt-issued-out"); break;
      case "debtRepaid": add("debt-repaid", "debt-repaid-out"); break;
      case "equityIssued": add("equity", "equity-out"); break;
      case "buybacks": add("buybacks", "buybacks-out"); break;
      case "dividends": add("dividends", "dividends-out"); break;
      case "debt": add("debt"); break;
      case "cash": add("cash", "cash-added", "cash-used"); break;
      case "equity": add("paid-in", "retained", "equity-other"); break;
      case "totalAssets": add("productive", "lease-assets", "cash", "receivables", "inventory", "intangibles", "investments", "assets-other"); break;
      case "leases": add("leases"); break;
      case "customerAdvances": add("customer"); break;
      case "payables": add("payables"); break;
      case "productive": add("productive"); break;
      case "leaseAssets": add("lease-assets"); break;
      case "receivables": add("receivables"); break;
      case "inventory": add("inventory"); break;
      case "intangibles": add("intangibles"); break;
      case "investments": add("investments"); break;
      case "leasePrincipal": add("lease", "lease-out"); break;
      default: break;
    }
  }
  return keys;
}
