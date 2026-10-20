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

/**
 * A magnitude in the locale's counting units, without sign or currency: "75.7B" / "757亿".
 * English groups by thousands (K, M, B, T); Chinese by ten-thousands (万, 亿, 万亿) and keeps three significant digits.
 */
export function compactNumber(abs: number, locale: Locale = "en"): string {
  if (locale === "zh-CN") {
    const [divisor, suffix] = abs >= 1e12 ? [1e12, "万亿"] : abs >= 1e8 ? [1e8, "亿"] : abs >= 1e4 ? [1e4, "万"] : [1, ""];
    const n = abs / divisor;
    const digits = !suffix || n >= 100 ? 0 : n >= 10 ? 1 : 2;
    return Number(n.toFixed(digits)).toFixed(digits) + suffix;
  }
  const [divisor, suffix] = abs >= 1e12 ? [1e12, "T"] : abs >= 1e9 ? [1e9, "B"] : abs >= 1e6 ? [1e6, "M"] : abs >= 1e3 ? [1e3, "K"] : [1, ""];
  const digits = abs / divisor >= 100 || !suffix ? 0 : 1;
  return (abs / divisor).toFixed(digits) + suffix;
}

/** "$75.7B", "−$28.7B", "4.2B SEK" / "757亿美元", "−287亿美元", "42亿瑞典克朗". */
export function compactMoney(value: number, currency: string | null, locale: Locale = "en"): string {
  const text = compactNumber(Math.abs(value), locale);
  const code = currency ?? "USD";
  if (locale === "zh-CN") return signOf(value) + text + (ZH_CURRENCY[code] ?? ` ${code}`);
  const symbol = SYMBOL[code];
  return signOf(value) + (symbol ? symbol + text : `${text} ${code}`);
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

/** A plain count with grouping: "1,234" in both locales. */
export const groupedCount = (value: number) => Math.round(value).toLocaleString("en-US");
