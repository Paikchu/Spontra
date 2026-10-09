import { FUNDAMENTAL_METRIC_CATALOG } from "../../../../shared/analysis-contract/fundamental-metric-catalog.ts";
import type { FundamentalMetricKey } from "../../../../shared/analysis-contract/fundamentals.ts";
export { FUNDAMENTAL_METRIC_CATALOG };
export type * from "../../../../shared/analysis-contract/fundamentals.ts";

export function isFundamentalMetricKey(value: string): value is FundamentalMetricKey {
  return Object.hasOwn(FUNDAMENTAL_METRIC_CATALOG, value);
}
