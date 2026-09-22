import type { PublishedSecReport } from '@/shared/analysis-contract/report.ts';
import type { SecPresentation } from '@/shared/analysis-contract/sec-presentation.ts';
import { ReportBlockList } from './ReportBlocks.tsx';
import { SecTrendFigure, SecTrendSource } from './SecTrendFigure.tsx';

export function SecComposedSection({ section, report }: { section: SecPresentation['sections'][number]; report: PublishedSecReport }) {
  return <div className="sec-composed-content" data-layout={section.layout} data-density={report.presentation?.density}>
    {section.blocks.map((block) => block.type === 'sec_chart'
      ? <div className="report-content" key={block.id}><SecTrendFigure id={block.id} title={block.title} trend={block.trend} mark={block.mark} /><SecTrendSource title={block.title} trend={block.trend} /></div>
      : <ReportBlockList key={block.id} blocks={[block]} context={{ metrics: report.keyMetrics, fundamentals: null }} />)}
  </div>;
}
