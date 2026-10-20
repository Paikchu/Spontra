import type { SecPresentation, SecPresentationBlock, SecTrend } from '../../../../shared/analysis-contract/sec-presentation.ts';
import type { PublishedSecReport, SecAnalysisBrief, SecHistorySeries } from './analysis.ts';
import type { SecNodeResult } from './sec.ts';

/** Freeze only comparable, validated observations available as of this filing. */
export function buildSecTrends(brief: SecAnalysisBrief, filingDate: string, reportDate: string): SecTrend[] {
  return brief.history.series.flatMap((series): SecTrend[] => {
    const trend = verifiedTrend(series, brief.periodScope, filingDate, reportDate);
    return trend ? [trend] : [];
  });
}

/** One comparable unit/currency/basis, newest observation per period, as filed by this filing date. */
export function verifiedTrend(series: SecHistorySeries, periodScope: SecAnalysisBrief['periodScope'], filingDate: string, reportDate: string): SecTrend | undefined {
  const candidates = (periodScope === 'annual' ? series.annual : series.quarters)
    .filter((p) => p.qualityStatus === 'validated_xbrl' && p.periodScope === periodScope
      && p.endDate <= reportDate && p.sourceFiledAt <= filingDate && p.value.trim() !== '' && Number.isFinite(Number(p.value)))
    .sort((a, b) => b.endDate.localeCompare(a.endDate) || b.sourceFiledAt.localeCompare(a.sourceFiledAt));
  const newest = candidates[0];
  if (!newest) return undefined;
  const seen = new Set<string>();
  const points = candidates.filter((p) => {
    if (p.unit !== newest.unit || p.currency !== newest.currency || p.basis !== newest.basis || seen.has(p.endDate)) return false;
    seen.add(p.endDate);
    return true;
  }).slice(0, 8).reverse().map((p) => ({ date: p.endDate, value: Number(p.value), accession: p.sourceAccession }));
  return points.length < 2 ? undefined : { metricKey: series.seriesId, unit: newest.currency || newest.unit, basis: newest.basis, periodScope, points };
}

const record = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const label = (v: unknown) => typeof v === 'string' ? v.trim().slice(0, 120) : '';

/** Resolve model references, never model-supplied facts. Any invalid composition uses the legacy report. */
export function composeSecPresentation(value: unknown, nodes: SecNodeResult[], metrics: PublishedSecReport['keyMetrics'], trends: SecTrend[]): SecPresentation | undefined {
  const root = record(value);
  if (!root || !Array.isArray(root.sections) || !root.sections.length || root.sections.length > 12) return undefined;
  const covered = new Set<string>();
  const sections: SecPresentation['sections'] = [];
  for (const [index, raw] of root.sections.entries()) {
    const section = record(raw);
    if (!section || !label(section.title) || !Array.isArray(section.blocks) || !section.blocks.length || section.blocks.length > 8) return undefined;
    const blocks: SecPresentationBlock[] = [];
    for (const [blockIndex, rawBlock] of section.blocks.entries()) {
      const block = record(rawBlock);
      if (!block) return undefined;
      const id = `sec-composed-${index + 1}-block-${blockIndex + 1}`;
      const title = label(block.title);
      if (block.type === 'metrics') {
        if (!Array.isArray(block.metricKeys) || !block.metricKeys.length || block.metricKeys.length > 6) return undefined;
        const keys = [...new Set(block.metricKeys.map(String))];
        if (keys.some((key) => !metrics.some((m) => m.metricKey === key && (m.status === 'verified' || m.status === 'derived')))) return undefined;
        blocks.push({ type: 'metrics', id, title, metricKeys: keys });
      } else if (block.type === 'chart') {
        const trend = trends.find((t) => t.metricKey === block.metricKey);
        const node = nodes.find((n) => n.id === block.nodeId && n.status === 'complete');
        const preceding = record(section.blocks[blockIndex - 1]);
        // Charts stay with the business explanation, never in an unrelated chart gallery.
        if (!trend || !node || preceding?.nodeId !== node.id
          || !['narrative', 'findings', 'callout'].includes(String(preceding?.type))) return undefined;
        blocks.push({ type: 'sec_chart', nodeId: node.id, id, title: title || trend.metricKey, mark: block.mark === 'bar' ? 'bar' : 'line', trend });
      } else {
        const node = nodes.find((n) => n.id === block.nodeId && n.status === 'complete');
        if (!node) return undefined;
        if (block.type === 'narrative' && node.narrative) blocks.push({ type: 'prose', id, title, text: node.narrative });
        else if (block.type === 'findings' && node.findings.length) blocks.push({ type: 'key_points', id, title, points: node.findings });
        else if (block.type === 'callout' && (node.narrative || node.findings.length)) blocks.push({ type: 'callout', id, title: title || node.title, text: node.narrative || node.findings[0].detail, tone: block.tone === 'positive' || block.tone === 'negative' || block.tone === 'caution' ? block.tone : 'neutral' });
        else if (block.type === 'evidence' && node.evidence.length) blocks.push({ type: 'evidence', id, title, items: node.evidence });
        else return undefined;
        if (block.type !== 'evidence') covered.add(node.id);
      }
    }
    sections.push({ id: `sec-composed-${index + 1}`, title: label(section.title), layout: section.layout === 'grid' ? 'grid' : 'flow', blocks });
  }
  if (nodes.some((node) => node.status === 'complete' && (node.narrative || node.findings.length) && !covered.has(node.id))) return undefined;
  return { version: 'sec-presentation.v1', density: root.density === 'compact' ? 'compact' : 'comfortable', sections };
}
