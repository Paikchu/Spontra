import type { PublishedFindingArticle } from "@/shared/analysis-contract/findings";
import type { PublicFilingDigest } from "@/shared/analysis-contract/filings";

/** A quarter match alone is insufficient: the article must cite this exact original filing. */
export function belongsToFiling(article: PublishedFindingArticle, filing: Pick<PublicFilingDigest, "accessionNumber" | "periodEnd">): boolean {
  return article.status !== "incomplete" && article.periodEnd === filing.periodEnd && article.sourceAccessions.includes(filing.accessionNumber);
}

/** A cited event is a source relation, not evidence that its event date is a fiscal period. */
export function citesEventSource(article: PublishedFindingArticle, accession: string): boolean {
  return article.status !== "incomplete" && article.sourceAccessions.includes(accession);
}
