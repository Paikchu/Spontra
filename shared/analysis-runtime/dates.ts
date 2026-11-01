export const DAY_MS = 86_400_000;
/** Days from one ISO date (or instant) to another; negative when `end` comes first. */
export const daysBetween = (start: string, end: string): number => (Date.parse(end) - Date.parse(start)) / DAY_MS;

/** A fiscal close on days 1–7 belongs to the previous nominal month, including January's year rollover. */
export function nominalFiscalMonth(year: number, month: number, day: number): { year: number; month: number } {
  if (day > 7) return { year, month };
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}
