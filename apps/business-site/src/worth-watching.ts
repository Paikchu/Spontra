import type { HomeCompany, HomeFinding } from "../../../shared/analysis-contract/home.ts";

export type SignalTab = "all" | "risk" | "strength" | "shift";

export type WorthWatchingCard = {
  company: HomeCompany;
  finding: HomeFinding;
  /** Other findings for this company in the current filter, besides the one on this card. */
  extra: number;
};

/** Highest severity, then the newest filing, then a stable ticker and id. */
function byRank(a: { company: HomeCompany; finding: HomeFinding }, b: { company: HomeCompany; finding: HomeFinding }): number {
  return b.finding.severity - a.finding.severity
    || b.finding.periodEnd.localeCompare(a.finding.periodEnd)
    || a.company.ticker.localeCompare(b.company.ticker)
    || a.finding.id.localeCompare(b.finding.id);
}

function countFor(company: HomeCompany, tab: SignalTab): number {
  const counts = company.findingCounts;
  if (tab === "all") return counts.risk + counts.strength + counts.shift + counts.watch;
  return counts[tab];
}

/**
 * Homepage「值得关注」.
 * Each company contributes its strongest finding first. Those cards are ranked across companies and
 * capped at `limit`. A second card from the same company is used only when fewer than `limit`
 * companies have a finding in this filter, and those second cards sit after every company's first.
 * The digest carries at most two findings per company, so a third card is never invented.
 */
export function worthWatching(companies: readonly HomeCompany[], tab: SignalTab, limit = 6): WorthWatchingCard[] {
  const grouped = new Map<string, Array<{ company: HomeCompany; finding: HomeFinding }>>();
  for (const company of companies) {
    const findings = company.topFindings.filter(finding => tab === "all" || finding.kind === tab);
    if (!findings.length) continue;
    grouped.set(company.ticker, findings.map(finding => ({ company, finding })).sort(byRank));
  }
  const groups = [...grouped.values()].sort((a, b) => byRank(a[0]!, b[0]!));
  const picked = groups.map(group => group[0]!).slice(0, limit);
  if (picked.length < limit) {
    const seconds = groups.map(group => group[1]).filter((item): item is NonNullable<typeof item> => item != null).sort(byRank);
    picked.push(...seconds.slice(0, limit - picked.length));
  }
  return picked.map(item => ({ ...item, extra: Math.max(0, countFor(item.company, tab) - 1) }));
}
