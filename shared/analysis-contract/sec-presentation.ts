import type { ReportBlock } from './report-blocks.ts';

export type SecSourceMaterial = {
  type: string;
  filename: string;
  url: string;
  status: 'read' | 'unsupported';
};

export type SecTrend = {
  metricKey: string;
  unit: string;
  basis: string;
  periodScope: 'quarter' | 'annual';
  points: Array<{ date: string; value: number; accession: string }>;
};

export type SecPresentationBlock = Exclude<ReportBlock, { type: 'chart' }> | {
  type: 'sec_chart';
  /** Business analysis this chart supports. Optional only for older saved reports. */
  nodeId?: string;
  id: string;
  title: string;
  mark: 'bar' | 'line';
  trend: SecTrend;
};

export type SecPresentation = {
  version: 'sec-presentation.v1';
  density: 'comfortable' | 'compact';
  sections: Array<{
    id: string;
    title: string;
    layout: 'flow' | 'grid';
    blocks: SecPresentationBlock[];
  }>;
};

export const SEC_PRESENTATION_SCHEMA = {
  density: 'comfortable|compact',
  sections: '[{title, layout:flow|grid, blocks:[{type: narrative|findings|callout|evidence|metrics|chart, nodeId?, metricKeys?, metricKey?, title?, tone?, mark?:bar|line}]}]',
  rules: [
    'Design 1–12 sections, their order and titles around the company\'s business questions. Do not apply a fixed financial template. At most 8 blocks per section.',
    'narrative/findings/callout/evidence must reference a completed nodeId; that node fills in the text, conclusions and evidence. Do not restate facts.',
    'metrics may only reference metricKeys that this run actually output in keyMetrics and that can be verified; chart references a metricKey from availableCharts, with bar or line. The system fills in the values.',
    'Every chart must name a completed nodeId and directly follow a narrative/findings/callout for the same nodeId, in the same section. A chart answers that node\'s business question; do not collect charts into a separate section.',
    'Explain the business judgment first, then use the chart to check scale, trend or financial results, and say what the chart shows and what it cannot prove. The title should state the angle. Total revenue trends cannot stand in for customer retention, segment revenue or unit economics data, and cannot prove causation on their own.',
    'Draw a chart only when availableCharts has data that fits the business question. Do not add decorative charts or require a chart in every section; when business metrics are missing, state the data gap.',
    'Use flow for continuous analysis and grid for side-by-side comparison. callout tone may be neutral/positive/negative/caution.',
    'Every completed node appears at least once as narrative/findings/callout; the system keeps evidence, data quality and sources.',
    'The site design system provides all visual styling. Do not specify colors, fonts, corner radius, shadows or custom styles. Choose only the structures, density and chart types above.',
    'Do not output HTML, CSS, JavaScript or chart data points. Do not draw a chart without matching evidence or multi-period data.',
  ],
} as const;
