import type { PublishedFindingArticle } from "@/shared/analysis-contract/findings";
import type { PublicFilingDigest } from "@/shared/analysis-contract/filings";

/** A quarter match alone is insufficient: the article must cite this exact original filing. */
export function belongsToFiling(article: PublishedFindingArticle, filing: Pick<PublicFilingDigest, "accessionNumber" | "periodEnd">): boolean {
  return article.periodEnd === filing.periodEnd && article.sourceAccessions.includes(filing.accessionNumber);
}
