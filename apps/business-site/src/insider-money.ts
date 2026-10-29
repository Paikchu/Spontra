import { compactMoney, MINUS, type Locale } from "@/shared/analysis-runtime/locale";

export function insiderCompactMoney(value: number, locale: Locale = "en"): string {
  const amount = Math.abs(value);
  const sign = value < 0 ? MINUS : "";
  if (locale === "zh-CN" && amount >= 1e8 && amount < 1e12) {
    return `${sign}${(amount / 1e8).toFixed(1).replace(/\.0$/, "")}亿美元`;
  }
  if (locale === "en" && amount >= 1e8 && amount < 1e9) {
    return `${sign}$${Math.round(amount / 1e7) * 10}M`;
  }
  if (locale === "en" && amount >= 1e6 && amount < 1e8) {
    return `${sign}$${Number((amount / 1e6).toFixed(2))}M`;
  }
  const formatted = compactMoney(value, "USD", locale);
  return locale === "zh-CN" ? formatted.replace(/\.(\d*?)0+(?=[亿万])/g, (_, digits: string) => digits ? `.${digits}` : "") : formatted;
}

