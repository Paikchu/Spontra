import type { FlowMetric } from "@/shared/analysis-contract/business-flow";

/* ---------- The four headline figures ---------- */

export type CoreSlot = { key: "revenue" | "gross" | "pretax" | "operating" | "net"; metric: FlowMetric; value: number | null; missing: null | "model" | "undisclosed" };

/**
 * The four headline figures of the income statement, always four: revenue, gross profit (or income before taxes for a
 * model without one), operating income, net income. A figure the filing does not carry stays as an empty slot with its
 * reason: not part of the industry's statement model (a bank: no gross profit or operating income, but a pretax line),
 * or not disclosed. When operating income is missing but income before taxes is known and not shown yet, it takes the slot.
 */
export function coreSlots(figure: (key: FlowMetric) => number | null, options: { hideGross?: boolean } = {}): CoreSlot[] {
  const gross = options.hideGross ? null : figure("gross"), pretax = figure("pretax"), operating = figure("operating");
  const financial = gross == null && operating == null && pretax != null;
  const missing = (value: number | null): CoreSlot["missing"] => value != null ? null : financial ? "model" : "undisclosed";
  const second: CoreSlot = gross != null || pretax == null
    ? { key: "gross", metric: "gross", value: gross, missing: missing(gross) }
    : { key: "pretax", metric: "pretax", value: pretax, missing: null };
  const third: CoreSlot = operating == null && pretax != null && second.key === "gross"
    ? { key: "pretax", metric: "pretax", value: pretax, missing: null }
    : { key: "operating", metric: "operating", value: operating, missing: missing(operating) };
  const revenue = figure("revenue"), net = figure("net");
  return [
    { key: "revenue", metric: "revenue", value: revenue, missing: revenue == null ? "undisclosed" : null },
    second, third,
    { key: "net", metric: "net", value: net, missing: net == null ? "undisclosed" : null },
  ];
}
