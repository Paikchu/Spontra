import type { SecFiling, SecFilingSummary } from "./sec.ts";

/** An amendment that adds an exhibit and says it leaves the original disclosures unchanged. */
export type CoverAmendment = { exhibit: string };

const flatText = (text: string) => text.replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/\s+/g, " ").trim();

/**
 * A periodic amendment whose own text says it does not change the original report and exists only to add an exhibit.
 * A restatement, or any amendment that does not say both of those things, is not one: it still goes through analysis.
 */
export function coverAmendmentNote(form: string, text: string): CoverAmendment | null {
  if (!/^(?:10-[KQ]|20-F|40-F)\/A$/.test(form)) return null;
  const flat = flatText(text);
  if (!/consists solely of the (?:preceding )?cover page/i.test(flat)) return null;
  if (!/does not (?:reflect events occurring after|modify or update)/i.test(flat)) return null;
  const exhibit = flat.match(/including Exhibit\s+(\d+(?:\.\d+)?)/i)?.[1];
  return exhibit ? { exhibit } : null;
}

/** The summary published for a cover amendment: the filing's own statement, not a model report. */
export function coverAmendmentSummary(filing: Pick<SecFiling, "ticker" | "form" | "filingDate" | "accessionNumber">, note: CoverAmendment, now = new Date()): SecFilingSummary {
  const exhibit = `Exhibit ${note.exhibit}`;
  return {
    ticker: filing.ticker,
    form: filing.form,
    filingDate: filing.filingDate,
    accessionNumber: filing.accessionNumber,
    headline: `${filing.form} adds ${exhibit} and does not change the financial statements`,
    bullets: [
      { label: "What this filing does", detail: `The amendment is filed solely to include ${exhibit}. It does not revise any financial statement or other disclosure in the original report.`, importance: "high" },
      { label: "What it does not do", detail: "There is no new quarter in this filing, and its figures are not compared with another period. Read it together with the original report.", importance: "medium" },
    ],
    analystView: `${exhibit} was added by amendment. No reported amount changed, so this filing is not a new period of results.`,
    report: `This ${filing.form} is an exhibit-only amendment. It includes ${exhibit} and states that it does not modify the disclosures in the original report. No income statement was filed with it, and no quarter was compared.`,
    source: "filing",
    generatedAt: now.toISOString(),
  };
}
