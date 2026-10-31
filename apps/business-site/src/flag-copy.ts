import type { AssessedMetric, Flag, FlagLevel, MetricForm, StatementRuleDef } from "@/shared/analysis-contract/statement-analysis";
import { METRIC_DEFS, RULE_DEFS, formatMetric, ruleCriteria } from "@/shared/analysis-runtime/statement-analysis";
import type { Locale } from "@/shared/analysis-runtime/locale";

/**
 * A tripped checkup rule as the reader takes it in: one sentence with the figure, how it moved against a year ago and
 * what the rule found ("Operating margin 66.2%, 6.1 pp higher than a year ago, improving for 2 quarters"). The
 * thresholds themselves are kept for the metric's lens, written in words; the page shows no comparison signs.
 */

const zh = (locale: Locale) => locale === "zh-CN";

/** What each rule found, given how many quarters it has held for. */
const VERDICT: Record<string, (n: number, locale: Locale) => string> = {
  "revenue-decline": (n, l) => zh(l) ? `已连续 ${n} 季同比下滑` : `down year over year for ${n} quarters`,
  "growth-decelerating": (_n, l) => zh(l) ? "增速连续 3 季放缓" : "growth slowing for 3 quarters",
  "operating-leverage": (n, l) => zh(l) ? `利润增速快于营收，已连续 ${n} 季` : `profit outgrowing revenue for ${n} quarters`,
  "margin-compression": (n, l) => zh(l) ? `已连续 ${n} 季收窄` : `narrowing for ${n} quarters`,
  "gross-margin-compression": (n, l) => zh(l) ? `已连续 ${n} 季收窄` : `narrowing for ${n} quarters`,
  "margin-expansion": (n, l) => zh(l) ? `已连续 ${n} 季改善` : `improving for ${n} quarters`,
  "cash-below-profit": (_n, l) => zh(l) ? "现金流跟不上利润" : "cash trailing profit",
  "cash-above-profit": (_n, l) => zh(l) ? "现金流明显多于利润" : "cash well ahead of profit",
  "receivables-outrun": (n, l) => zh(l) ? `应收增速快于营收，已连续 ${n} 季` : `receivables outpacing revenue for ${n} quarters`,
  "inventory-outrun": (n, l) => zh(l) ? `存货增速快于营收，已连续 ${n} 季` : `inventory outpacing revenue for ${n} quarters`,
  "sbc-heavy": (_n, l) => zh(l) ? "股权激励占营收比重偏高" : "stock pay is a heavy share of revenue",
  "capex-cycle": (_n, l) => zh(l) ? "资本开支远超折旧，处于扩张期" : "capex running well ahead of depreciation",
  "capex-unmatched": (n, l) => zh(l) ? `投入加大而营收增长放缓，已连续 ${n} 季` : `capital rising while revenue growth slows, ${n} quarters`,
  "returns-below-cost": (_n, l) => zh(l) ? "回报低于资本成本，仍在加大投入" : "returns below the cost of capital while investing",
  "backlog-large": (_n, l) => zh(l) ? "在手订单超过一年营收" : "backlog exceeds a year of revenue",
  "returns-strong": (_n, l) => zh(l) ? "资本回报处于高位" : "returns on capital are high",
  "fcf-negative": (_n, l) => zh(l) ? "自由现金流为负" : "free cash flow is negative",
  "fcf-turned-positive": (_n, l) => zh(l) ? "较上年同期由负转正" : "turned positive from a year ago",
  "fcf-turned-negative": (_n, l) => zh(l) ? "较上年同期由正转负" : "turned negative from a year ago",
  "external-funding": (_n, l) => zh(l) ? "资本开支依赖外部融资" : "capex leaning on outside funding",
  "leverage-high": (_n, l) => zh(l) ? "杠杆偏高" : "leverage is high",
  "leverage-rising": (_n, l) => zh(l) ? "杠杆较上年同期上升" : "leverage up from a year ago",
  "liquidity-thin": (_n, l) => zh(l) ? "流动资产不足以覆盖流动负债" : "current assets short of current liabilities",
  "maturity-wall": (_n, l) => zh(l) ? "现金不足以覆盖一年内到期债务" : "cash short of debt due within a year",
  "runway-short": (_n, l) => zh(l) ? "现金跑道偏短" : "short cash runway",
  "interest-burden": (_n, l) => zh(l) ? "利息负担偏重" : "interest weighs on cash flow",
};

const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
/** Quarters a rule has held for, from the oldest quarter of its run to the report. */
export function runQuarters(since: string, periodEnd: string): number {
  return Math.max(1, Math.round((monthIndex(periodEnd) - monthIndex(since)) / 3) + 1);
}

/** The year-over-year move in words, in the metric's own terms; null when it rounds away or the metric is itself a change. */
function yearAgo(metric: Pick<AssessedMetric, "measure" | "form" | "yoy">, locale: Locale): string | null {
  if (metric.measure !== "value" || metric.yoy == null || !Number.isFinite(metric.yoy)) return null;
  const v = metric.yoy, abs = Math.abs(v), form: MetricForm = metric.form;
  const amount = form === "percent" || form === "points" ? (zh(locale) ? `${abs.toFixed(1)} 个百分点` : `${abs.toFixed(1)} pp`)
    : form === "multiple" ? (zh(locale) ? `${abs.toFixed(2)} 倍` : `${abs.toFixed(2)}×`)
    : form === "months" ? (zh(locale) ? `${abs.toFixed(1)} 个月` : `${abs.toFixed(1)} months`)
    : `${abs.toFixed(1)}%`;
  if (Number(abs.toFixed(form === "multiple" ? 2 : 1)) === 0) return null;
  const up = v > 0;
  if (form === "money" || form === "per_share") return zh(locale) ? `比去年同期${up ? "增长" : "减少"} ${amount}` : `${up ? "up" : "down"} ${amount} from a year ago`;
  return zh(locale) ? `比去年同期${up ? "高" : "低"} ${amount}` : `${amount} ${up ? "higher" : "lower"} than a year ago`;
}

export type FlagCopy = { name: string; value: string; sentence: string; verdict: string };

/** The pill's sentence for a tripped rule at the report on the stage. */
export function flagCopy(flag: Flag, metric: AssessedMetric | null | undefined, periodEnd: string, locale: Locale): FlagCopy {
  const def = METRIC_DEFS.get(flag.metricId);
  const name = def ? def.label[zh(locale) ? 1 : 0] : flag.metricId;
  const form = metric?.form ?? def?.form ?? "percent";
  const value = formatMetric(flag.value, form, locale, metric?.current.resolved.currency ?? "USD");
  const n = runQuarters(flag.since, periodEnd);
  const rule = RULE_DEFS.get(flag.ruleId);
  const base = VERDICT[flag.ruleId]?.(n, locale) ?? (zh(locale) ? "触发提醒" : "flagged");
  // A one-quarter rule that has held longer says so.
  const verdict = rule && rule.persist === 1 && n > 1 && !/\d/.test(base) ? `${base}${zh(locale) ? `，已持续 ${n} 季` : `, ${n} quarters running`}` : base;
  const moved = metric ? yearAgo(metric, locale) : null;
  const sep = zh(locale) ? "，" : ", ";
  return { name, value, verdict, sentence: `${name} ${value}${sep}${moved ? `${moved}${sep}` : ""}${verdict}` };
}

export type RuleStatus = { rule: StatementRuleDef; criteria: string; met: boolean; level: FlagLevel };

/** Every rule tested on a metric, in words, and whether it holds at the report: the lens's explanation of the pill. */
export function metricRules(metricId: string, flags: Flag[], locale: Locale): RuleStatus[] {
  const tripped = new Set(flags.map(f => f.ruleId));
  return [...RULE_DEFS.values()].filter(r => r.metric === metricId).map(rule => ({ rule, criteria: ruleCriteria(rule, locale), met: tripped.has(rule.id), level: rule.level }));
}
