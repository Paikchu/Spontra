/**
 * Reader locales and the number forms each one writes. Pure and worker-safe: nothing here reads a global,
 * so a caller states the locale on every call, and leaving it out keeps the English form Spontra Analysis
 * has always written.
 */
export type Locale = "en" | "zh-CN";
export const LOCALES: readonly Locale[] = ["en", "zh-CN"];
export const isLocale = (value: unknown): value is Locale => value === "en" || value === "zh-CN";

const SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", CNY: "¥", HKD: "HK$", TWD: "NT$" };
const ZH_CURRENCY: Record<string, string> = {
  USD: "美元", EUR: "欧元", GBP: "英镑", JPY: "日元", CNY: "人民币", HKD: "港元", TWD: "新台币", CAD: "加元",
  AUD: "澳元", CHF: "瑞士法郎", KRW: "韩元", INR: "印度卢比", SEK: "瑞典克朗", DKK: "丹麦克朗", NOK: "挪威克朗",
  BRL: "巴西雷亚尔", MXN: "墨西哥比索", SGD: "新加坡元", ILS: "以色列新谢克尔",
};

export const MINUS = "−";
const signOf = (value: number) => value < 0 ? MINUS : "";

const ZH_TIERS: ReadonlyArray<readonly [number, string]> = [[1, ""], [1e4, "万"], [1e8, "亿"], [1e12, "万亿"]];
const EN_TIERS: ReadonlyArray<readonly [number, string]> = [[1, ""], [1e3, "K"], [1e6, "M"], [1e9, "B"], [1e12, "T"]];

/**
 * A magnitude in the locale's counting units, without sign or currency: "75.7B" / "757亿".
 * English groups by thousands (K, M, B, T); Chinese by ten-thousands (万, 亿, 万亿) and keeps three significant digits.
 * A figure that rounds up to the next unit reads in that unit: 999.95M is "1.00B", never "1000M"; 9999.5万 is "1.00亿".
 */
export function compactNumber(abs: number, locale: Locale = "en"): string {
  const zh = locale === "zh-CN";
  const tiers = zh ? ZH_TIERS : EN_TIERS, step = zh ? 1e4 : 1e3;
  const digitsFor = (n: number, suffix: string) => zh ? (!suffix || n >= 100 ? 0 : n >= 10 ? 1 : 2) : (!suffix || n >= 100 ? 0 : 1);
  let tier = tiers.length - 1;
  while (tier > 0 && abs < tiers[tier]![0]) tier--;
  const [divisor, suffix] = tiers[tier]!;
  const n = abs / divisor, rounded = Number(n.toFixed(digitsFor(n, suffix)));
  if (rounded >= step && tier < tiers.length - 1) return (1).toFixed(2) + tiers[tier + 1]![1];
  // Rounding can carry a figure into the next band of digits (99.96M → 100M), which then takes that band's precision.
  return rounded.toFixed(digitsFor(rounded, suffix)) + suffix;
}

/** "$75.7B", "−$28.7B", "4.2B SEK" / "757亿美元", "−287亿美元", "42亿瑞典克朗". */
export function compactMoney(value: number, currency: string | null, locale: Locale = "en"): string {
  const text = compactNumber(Math.abs(value), locale);
  const code = currency ?? "USD";
  // A figure that rounds to zero carries no sign.
  const sign = /[1-9]/.test(text) ? signOf(value) : "";
  if (locale === "zh-CN") return sign + text + (ZH_CURRENCY[code] ?? ` ${code}`);
  const symbol = SYMBOL[code];
  return sign + (symbol ? symbol + text : `${text} ${code}`);
}

/** The currency's name as the locale writes it after an amount: "USD" / "美元". */
export const currencyName = (code: string, locale: Locale = "en") => locale === "zh-CN" ? ZH_CURRENCY[code] ?? code : code;

/** A per-share amount: "$1.24" / "1.24美元". */
export function perShare(value: number, currency: string | null = "USD", locale: Locale = "en"): string {
  const code = currency ?? "USD";
  const text = Math.abs(value).toFixed(2);
  if (locale === "zh-CN") return signOf(value) + text + (ZH_CURRENCY[code] ?? ` ${code}`);
  const symbol = SYMBOL[code];
  return signOf(value) + (symbol ? symbol + text : `${text} ${code}`);
}

/** A share count: "1.23M shares" / "123万股". */
export function compactShares(value: number, locale: Locale = "en"): string {
  const a = Math.abs(value);
  if (locale === "zh-CN") return signOf(value) + compactNumber(a, locale) + "股";
  if (a >= 1e9) return `${(value / 1e9).toFixed(2)}B shares`;
  if (a >= 1e6) return `${(value / 1e6).toFixed(2)}M shares`;
  if (a >= 1e4) return `${(value / 1e3).toFixed(1)}K shares`;
  return `${Math.round(value).toLocaleString("en-US")} shares`;
}

/** Percentage points: "+1.5 pp" / "+1.5个百分点". `fixed: false` trims a trailing ".0"; `signed: false` drops the plus sign. */
export function points(value: number, locale: Locale = "en", options: { signed?: boolean; fixed?: boolean } = {}): string {
  const { signed = true, fixed = true } = options;
  const abs = Math.abs(value);
  const body = fixed ? abs.toFixed(1) : String(Number(abs.toFixed(1)));
  const sign = signed ? value > 0 ? "+" : value < 0 ? MINUS : "" : value < 0 ? MINUS : "";
  return sign + body + (locale === "zh-CN" ? "个百分点" : " pp");
}

/** A multiple: "2.60×" / "2.60倍". */
export const multiple = (body: string, locale: Locale = "en") => body + (locale === "zh-CN" ? "倍" : "×");

/** "2026.08" for a quarter end. */
export const shortPeriod = (end: string) => end.slice(0, 7).replace("-", ".");
/** "FY to 2026.08" / "截至 2026.08 财年": a four-quarter span ending at `end`. */
export const fiscalYearTo = (end: string, locale: Locale = "en") => locale === "zh-CN" ? `截至 ${shortPeriod(end)} 财年` : `FY to ${shortPeriod(end)}`;

/** Change labels: "YoY" / "同比", "QoQ" / "环比". */
export const yoyLabel = (locale: Locale = "en") => locale === "zh-CN" ? "同比" : "YoY";
export const qoqLabel = (locale: Locale = "en") => locale === "zh-CN" ? "环比" : "QoQ";

/**
 * A range of two formatted figures. Chinese states the shared unit once: "76.0–78.0亿美元" rather than
 * "76.0亿美元–78.0亿美元"; English keeps both ends whole: "$7.6B–$7.8B".
 */
export function range(low: string, high: string, locale: Locale = "en"): string {
  if (locale === "zh-CN") {
    const tail = (s: string) => s.match(/[^\d.]*$/)![0];
    const unit = tail(low);
    if (unit && unit === tail(high) && /\d$/.test(low.slice(0, -unit.length))) return `${low.slice(0, -unit.length)}–${high}`;
  }
  return `${low}–${high}`;
}

/* ---------- Unified display forms (U23) ---------- */

/** The one money form: three significant digits with the mathematical minus. An alias for {@link compactMoney}. */
export const formatMoney = compactMoney;

/**
 * A percentage with one decimal and the mathematical minus: "−3.1%", or "+8.1%" when `signed`.
 * A value that rounds to zero (and "−0") is a plain "0%" without a sign; null/undefined is "—".
 */
export function formatPct(value: number | null | undefined, options: { signed?: boolean } = {}): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const rounded = Number(value.toFixed(1));
  if (rounded === 0) return "0%";
  const sign = rounded < 0 ? MINUS : options.signed ? "+" : "";
  return `${sign}${Math.abs(rounded).toFixed(1)}%`;
}

/** A multiple like "2.60×" / "2.60倍" with the mathematical minus for a negative value. */
export function formatMultiple(value: number, locale: Locale = "en", digits = 2): string {
  return signOf(value) + multiple(Math.abs(value).toFixed(digits), locale);
}

// A currency symbol, or a number followed by a magnitude/currency/unit: what marks a token as an amount or a percent,
// so an ISO date ("2026-09-30") or a form name ("10-K", "8-K", "Non-GAAP") is never rewritten. String.raw keeps the
// Chinese units out of the i18n literal check: these are patterns, not copy.
const CUR_SYMBOL = "(?:US\\$|NT\\$|CA\\$|HK\\$|[$€£¥])";
const AMOUNT_UNIT = String.raw`(?:(?:万亿|亿|万)?(?:美元|新台币|欧元|日元|英镑|加元|港元|元|股|个百分点|倍)|万亿|亿|万|%|(?:bn|mn)(?![A-Za-z])|[BMTK](?![A-Za-z]))`;
const NUM = "\\d+(?:[,，]\\d{3})*(?:\\.\\d+)?";
const AMOUNT = `(?:${CUR_SYMBOL}\\s*${NUM}\\s*${AMOUNT_UNIT}?|${NUM}\\s*${AMOUNT_UNIT})`;
const ZH_UNIT_AFTER_DIGIT = String.raw`(?:万亿|亿|万|倍|股|个百分点|美元|新台币|欧元|日元|英镑|加元|港元|元)`;
const NEGATIVE_WORD = new RegExp(String.raw`负\s*(${AMOUNT})`, "g");
const NEGATIVE_EN = new RegExp(String.raw`\b(?:[Nn]egative|NEGATIVE)\s+(${AMOUNT})`, "g");
const NEGATIVE_HYPHEN = new RegExp(`(?<![\\w\\-−])-\\s*(${AMOUNT})`, "g");
const DIGIT_UNIT_GAP = new RegExp(`(\\d) +(?=${ZH_UNIT_AFTER_DIGIT})`, "g");

/**
 * The deterministic display normalization (U23 Rule 5): applied at the rendering layer to model-written titles,
 * judgments, prose and headlines so a negative amount reads with the mathematical minus. It converts a leading
 * "负", English "negative" or ASCII hyphen before an amount/percent to "−" (collapsing any stray space), and removes a stray space
 * between a digit and a Chinese unit. ISO dates and form names are left untouched. No model tokens are spent.
 */
export function normalizeDisplayText(text: string): string {
  if (!text) return text;
  return text
    .replace(NEGATIVE_WORD, `${MINUS}$1`)
    .replace(NEGATIVE_EN, `${MINUS}$1`)
    .replace(NEGATIVE_HYPHEN, `${MINUS}$1`)
    .replace(DIGIT_UNIT_GAP, "$1");
}

/**
 * A chart axis tick: the magnitude without the currency, which the chart states once ("单位：美元" / "Unit: USD").
 * Zero is a bare "0"; English drops a trailing ".0" ("60B"); a negative tick takes the mathematical minus.
 */
export function axisNumber(value: number, locale: Locale = "en"): string {
  if (!Number.isFinite(value) || value === 0) return "0";
  const text = compactNumber(Math.abs(value), locale);
  const body = locale === "zh-CN" ? text : text.replace(/\.0(?=[A-Z]*$)/, "");
  return (/[1-9]/.test(body) ? signOf(value) : "") + body;
}

/** The unit line over a chart whose ticks leave the currency out: "单位：美元" / "Unit: USD". */
export const axisUnit = (currency: string | null, locale: Locale = "en") =>
  locale === "zh-CN" ? `单位：${currencyName(currency || "USD", locale)}` : `Unit: ${currency || "USD"}`;

/** Revenue adjustment lines filings name in English, as the Chinese page calls them. */
const ADJUSTMENT_ZH: Array<[RegExp, string]> = [
  [/^reconciling items?$/i, "调节项"],
  [/^(?:intersegment|inter-segment) (?:sales|revenues?|eliminations?)$|^eliminations?$/i, "分部间抵销"],
];

/** A revenue adjustment's name in the reader's language: the known reconciliation lines translate, any other name stays. */
export function adjustmentLabel(name: string, locale: Locale = "en"): string {
  if (locale !== "zh-CN") return name;
  const trimmed = name.trim();
  return ADJUSTMENT_ZH.find(([pattern]) => pattern.test(trimmed))?.[1] ?? name;
}
