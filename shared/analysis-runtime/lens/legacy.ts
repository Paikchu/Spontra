import type { AnalysisFinding, FindingLens, FindingRef } from "../../analysis-contract/findings.ts";
import type { LensBlock, LensChart, LensDocument, LensRow } from "../../analysis-contract/lens.ts";
import { rpoBuckets, type FindingData } from "../findings.ts";

/**
 * Findings written before the lens document carry one of four chart names; each becomes a document
 * through the same grammar the agent writes in, so the page has one renderer. The layout is the one
 * the agent is asked for: the chart beside the judgment, the figures beside what to watch, sources last.
 */
const dedupe = (refs: FindingRef[]) => [...new Map(refs.map(r => [JSON.stringify(r), r])).values()];
const ids = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`);

function layout(finding: Pick<AnalysisFinding, "watch">, charts: LensChart[]): LensDocument {
  const [first, ...rest] = charts;
  const text: LensBlock[] = [{ kind: "judgment" }, { kind: "figures" }, ...(finding.watch ? [{ kind: "watch" } as const] : [])];
  // Beside a column of text the chart stands taller than a wide one would, so the two cells end near each other.
  const rows: LensRow[] = [{ cells: first ? [[{ kind: "chart", chart: { ...first, aspect: "square" } }], text] : [text] }];
  for (const chart of rest) rows.push({ cells: [[{ kind: "chart", chart }]] });
  rows.push({ cells: [[{ kind: "sources" }]] });
  return { rows };
}

/** The legacy chart names as grammar charts; `data` tells how many RPO rungs the ladder can draw. */
export function legacyCharts(lens: Exclude<FindingLens, { type: "document" }>, data: FindingData | null, periodEnd: string): LensChart[] {
  switch (lens.type) {
    case "trend": {
      const refs = dedupe(lens.refs), sid = ids("s", refs.length);
      const series = refs.map((ref, i) => ({ id: sid[i]!, ref }));
      const marks: LensChart["marks"] = [{ type: "bar", series: sid }];
      if (lens.rate) { series.push({ id: "rate", ref: refs[0]!, transform: lens.rate } as typeof series[number]); marks.push({ type: "line", series: ["rate"], axis: "right", color: "muted" }); }
      return [{ id: "trend", aspect: "wide", span: lens.span, periods: lens.span === "quarter" ? 8 : 4, series, marks, periodLabels: lens.span === "quarter" ? "sparse" : "all" }];
    }
    case "compare_bars": {
      const refs = dedupe(lens.refs), sid = ids("s", refs.length);
      return [{ id: "compare", aspect: "wide", span: lens.span, periods: lens.span === "quarter" ? 8 : 4, series: refs.map((ref, i) => ({ id: sid[i]!, ref })), marks: [{ type: "bar", series: sid }], periodLabels: lens.span === "quarter" ? "sparse" : "all" }];
    }
    case "share_area": {
      const sid = ids("n", lens.nodeIds.length);
      return [{ id: "shares", aspect: "wide", span: "quarter", periods: 12, series: lens.nodeIds.map((nodeId, i) => ({ id: sid[i]!, ref: { ratio: { numerator: { nodeId }, denominator: { metric: "revenue" } } } })), marks: [{ type: "stacked_area", series: sid }], periodLabels: "sparse" }];
    }
    case "ladder": {
      const balance: LensChart = { id: "rpo", aspect: "wide", span: "quarter", periods: 8, series: [{ id: "rpo", ref: { capital: "rpo" }, label: "RPO" }, { id: "rate", ref: { capital: "rpo" }, transform: "yoy", label: "RPO" }], marks: [{ type: "bar", series: ["rpo"] }, { type: "line", series: ["rate"], axis: "right", color: "muted" }], periodLabels: "sparse" };
      const rpo = data?.capital?.quarters.find(q => Math.abs(Date.parse(q.periodEnd) - Date.parse(periodEnd)) <= 20 * 86_400_000)?.rpo;
      const rungs = rpo ? rpoBuckets(rpo).filter(b => b.amount != null).length : 0;
      if (!rungs) return [balance];
      const sid = ids("rung", rungs);
      return [balance, { id: "schedule", title: "Expected recognition of the backlog", aspect: "wide", span: "quarter", periods: 8, series: sid.map((id, i) => ({ id, ref: { rpoBucket: i } })), marks: [{ type: "stacked_bar", series: sid }], periodLabels: "sparse" }];
    }
  }
}

/** A finding's lens as a document: its own when it has one, otherwise its legacy chart laid out the standard way. */
export function lensDocumentOf(finding: AnalysisFinding, data: FindingData | null, periodEnd: string): LensDocument {
  if (finding.lens.type === "document") return finding.lens.document;
  return layout(finding, legacyCharts(finding.lens, data, periodEnd));
}

/** The last resort when a stored document verifies nothing: bars of the evidence's own references. */
export function documentFromEvidence(finding: AnalysisFinding): LensDocument {
  const span = finding.evidence[0]?.span ?? "quarter";
  const refs = dedupe(finding.evidence.filter(e => e.span === span && !("guidanceId" in e.ref)).map(e => e.ref)).slice(0, 4);
  return layout(finding, refs.length ? legacyCharts({ type: "compare_bars", refs, span }, null, finding.evidence[0]!.periodEnd) : []);
}
