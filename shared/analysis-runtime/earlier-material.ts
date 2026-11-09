import type { FindingMaterial } from "../analysis-contract/findings.ts";

const DAY = 86_400_000;
const EARLIER_DAYS = 45;

/** The report a material comes from is earlier when its filing reports a period well before the note's report. */
export function earlierMaterial(material: Pick<FindingMaterial, "title" | "publishedAt">, periodEnd: string): boolean {
  // Filing materials are titled "<ticker> <form> <report date>"; the filing date stands in when the title has none.
  const reported = /(\d{4}-\d{2}-\d{2})\s*$/.exec(material.title)?.[1] ?? material.publishedAt?.slice(0, 10) ?? null;
  return !!reported && Date.parse(periodEnd) - Date.parse(reported) > EARLIER_DAYS * DAY;
}
