import type { VerifiedFinding } from "@/shared/analysis-runtime/findings";
import { labels } from "@/packages/web/src/i18n";

export const KIND_LABEL: Record<VerifiedFinding["kind"], string> = labels({ risk: "Risk", strength: "Strength", shift: "Shift", watch: "Watch" }, { risk: "风险", strength: "优势", shift: "变化", watch: "跟踪" });
export const VIEW_LABEL = labels({ profit: "Profit", cash: "Cash flow", balance: "Balance sheet", valuation: "Valuation" }, { profit: "利润", cash: "现金流", balance: "资产负债表", valuation: "估值评估" });
