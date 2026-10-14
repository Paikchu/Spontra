import type { CapitalSchedule, PublicCapitalStructure, ScheduleBucket, ScheduleKind } from "../analysis-contract/capital-structure.ts";
import type { Locale } from "./locale.ts";

/**
 * Payment schedules resolved for a finding: a debt maturity, lease or purchase-obligation figure read from the
 * capital projection at a period end. Pure and worker-safe, so the pipeline and the page resolve the same way.
 */

/** A resolved schedule figure: the amount, the instant it is stated at, and the filing it comes from. */
export type SchedulePoint = { value: number; periodEnd: string; currency: string; accessions: string[] };

const DAY = 86400000;
const distance = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b));

/** The schedule of this kind at the quarter nearest `periodEnd`, within 20 days of it (a fiscal quarter end is never exact). */
export function scheduleAt(capital: PublicCapitalStructure | null, kind: ScheduleKind, periodEnd: string): CapitalSchedule | null {
  const quarters = (capital?.quarters ?? []).filter(q => distance(q.periodEnd, periodEnd) <= 20 * DAY && q.schedules?.some(s => s.kind === kind))
    .sort((a, b) => distance(a.periodEnd, periodEnd) - distance(b.periodEnd, periodEnd) || b.periodEnd.localeCompare(a.periodEnd));
  return quarters[0]?.schedules?.find(s => s.kind === kind) ?? null;
}

const point = (schedule: CapitalSchedule, amount: string | null): SchedulePoint | null => {
  const value = amount === null ? NaN : Number(amount);
  return Number.isFinite(value) ? { value, periodEnd: schedule.asOf, currency: schedule.currency, accessions: [schedule.source.accession] } : null;
};

/**
 * One year of a schedule: `bucket` counts years after the period end (0 = within twelve months, 1 = months 13–24, …,
 * 5 = thereafter), so a bucket the issuer did not tag resolves to null rather than to its neighbour.
 */
export function scheduleBucketAt(capital: PublicCapitalStructure | null, kind: ScheduleKind, bucket: number, periodEnd: string): SchedulePoint | null {
  const schedule = scheduleAt(capital, kind, periodEnd);
  const found = schedule?.buckets.find(b => b.from === bucket * 12);
  return schedule && found ? point(schedule, found.amount) : null;
}

/** The schedule's total as the issuer tags it; null when the filing states only the buckets. */
export function scheduleTotalAt(capital: PublicCapitalStructure | null, kind: ScheduleKind, periodEnd: string): SchedulePoint | null {
  const schedule = scheduleAt(capital, kind, periodEnd);
  return schedule ? point(schedule, schedule.total) : null;
}

const SUBJECT: Record<Locale, Record<ScheduleKind, string>> = {
  en: { debtMaturities: "Debt due", leasePaymentsDue: "Lease payments due", purchaseObligations: "Purchase obligations due" },
  "zh-CN": { debtMaturities: "到期债务", leasePaymentsDue: "应付租赁款", purchaseObligations: "采购义务" },
};

/** "Debt due within 12 months" / "Debt due 13–24 months" / "Debt due after 60 months"; Chinese puts the window first. */
export function scheduleBucketLabel(kind: ScheduleKind, bucket: ScheduleBucket, locale: Locale = "en"): string {
  const subject = SUBJECT[locale][kind];
  if (locale === "zh-CN") {
    const range = bucket.to === null ? `${bucket.from} 个月后` : bucket.from === 0 ? `${bucket.to} 个月内` : `${bucket.from + 1}–${bucket.to} 个月`;
    return `${range}${subject}`;
  }
  const range = bucket.to === null ? `after ${bucket.from} months` : bucket.from === 0 ? `within ${bucket.to} months` : `${bucket.from + 1}–${bucket.to} months`;
  return `${subject} ${range}`;
}
