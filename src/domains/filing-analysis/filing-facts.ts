import type { FilingFactRow } from "./filing-content-contract.ts";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DATE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2}),?\s+((?:19|20)\d{2})\b/i;
const pad = (n: number) => String(n).padStart(2, "0");

/** The period a column heading names: its end date, and the months it covers when the heading says (0 for a date alone is not assumed). */
export function headingPeriod(heading: string): { end: string | null; months: number | null } {
  const date = DATE.exec(heading);
  const month = date ? MONTHS.findIndex(m => m.startsWith(date[1]!.toLowerCase().slice(0, 3))) : -1;
  const end = date && month >= 0 ? `${date[3]}-${pad(month + 1)}-${pad(Number(date[2]))}` : null;
  const months = /\b(?:three|3)\s+months|\bquarters?\s+ended|\b(?:13|thirteen)\s+weeks/i.test(heading) ? 3
    : /\b(?:six|6)\s+months|\b(?:26|twenty-six)\s+weeks/i.test(heading) ? 6
    : /\b(?:nine|9)\s+months|\b(?:39|thirty-nine)\s+weeks/i.test(heading) ? 9
    : /\b(?:twelve|12)\s+months|\b(?:fiscal\s+)?years?\s+ended|\b(?:52|53|fifty-two|fifty-three)\s+weeks/i.test(heading) ? 12
    : /\bas\s+of\b/i.test(heading) ? 0 : null;
  return { end, months };
}

const SCALES: Array<[number, string]> = [[1e9, "bn"], [1e6, "m"], [1e3, "k"]];
/** A fact's value as a reader would write it, for a table or a tool result. */
export function factText(row: Pick<FilingFactRow, "value" | "unit">): string {
  if (row.unit === "percent") return `${row.value}%`;
  if (row.unit === "ratio") return String(row.value);
  const abs = Math.abs(row.value);
  const scale = SCALES.find(([s]) => abs >= s);
  const number = scale ? `${(row.value / scale[0]).toFixed(abs / scale[0] >= 100 ? 1 : 2)}${scale[1]}` : String(row.value);
  return row.unit === "USD" ? `$${number}` : `${number} ${row.unit}`;
}
export const periodText = (row: Pick<FilingFactRow, "periodEnd" | "periodMonths">) => !row.periodEnd ? "period not stated"
  : row.periodMonths === 0 ? `at ${row.periodEnd}` : row.periodMonths === null ? `ending ${row.periodEnd}` : `${row.periodMonths} months to ${row.periodEnd}`;
