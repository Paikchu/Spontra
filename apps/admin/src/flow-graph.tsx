import { useEffect, useMemo, useState } from 'react';
import type { BusinessMapFlow, FlowNode } from '@/shared/analysis-contract/business-map-admin';
import { adminApi } from './admin-api';
import { runView } from './run-progress';
import { useOnReturn, usePageActive } from './admin-page';

/** The pipeline's names as the admin calls them; the model-written ones are marked. */
const NODE: Record<string, { label: string; model?: boolean }> = {
  'sec-discovery': { label: 'SEC 申报' }, admin: { label: '后台操作' }, maintenance: { label: '重新准备' },
  collect: { label: '采集财报' }, history: { label: '季度历史' }, 'map-derive': { label: '财务地图' }, library: { label: '文件库拆分' },
  events: { label: '事件' }, 'sec-report': { label: '财报摘要', model: true }, guidance: { label: '业绩指引', model: true },
  'company-analysis': { label: '公司综述', model: true }, findings: { label: '要点', model: true }, analyst: { label: '要点分析师', model: true },
  checkup: { label: '三表分析', model: true }, items: { label: '申报解读', model: true }, explainer: { label: '业务解读', model: true },
  tree: { label: '业务脑图', model: true },
};
const STATE: Record<FlowNode['state'], string> = { running: '运行中', queued: '排队', done: '完成', failed: '失败', idle: '未运行' };
const COL = 176, NODE_W = 140, NODE_H = 46, GAP = 14, PAD = 8;
const time = (value: string | null) => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '';

/** Columns by depth; inside a column, nodes sit near the nodes that feed them, so edges cross less. */
function layout(flow: BusinessMapFlow) {
  const columns: FlowNode[][] = [];
  for (const node of flow.nodes) (columns[node.depth] ??= []).push(node);
  const row = new Map<string, number>();
  columns.forEach(column => {
    const weight = (node: FlowNode) => {
      const from = flow.edges.filter(e => e.to === node.id && row.has(e.from)).map(e => row.get(e.from)!);
      return from.length ? from.reduce((a, b) => a + b, 0) / from.length : Number.MAX_SAFE_INTEGER;
    };
    column.sort((a, b) => weight(a) - weight(b) || a.id.localeCompare(b.id)).forEach((node, i) => row.set(node.id, i));
  });
  const rows = Math.max(...columns.map(c => c?.length ?? 0));
  const position = new Map(flow.nodes.map(node => [node.id, { x: PAD + node.depth * COL, y: PAD + row.get(node.id)! * (NODE_H + GAP) }]));
  return { position, width: PAD * 2 + (columns.length - 1) * COL + NODE_W, height: PAD * 2 + rows * (NODE_H + GAP) - GAP };
}

/** A node's second line: what it is doing, with the phase a model run is on. */
function status(node: FlowNode): string {
  if (node.source) return node.at ? `最近 ${time(node.at)}` : '无记录';
  if (node.state === 'running' && node.progress) { const view = runView(node.progress); return `${view.current + 1}/${view.phases.length} ${view.phases[view.current]}`; }
  return [STATE[node.state], time(node.at)].filter(Boolean).join(' · ');
}

/**
 * One company's analysis as the pipeline runs it: tasks in columns by how far down the event chain they sit, the events
 * between them as edges. Information moving now (into a task that runs or waits) flows along its edge; the edge that
 * started each task's last run stays marked.
 */
export function FlowGraph({ ticker }: { ticker: string }) {
  const [flow, setFlow] = useState<BusinessMapFlow | null>(null), [failed, setFailed] = useState(false), [tick, setTick] = useState(0);
  const moving = !!flow?.nodes.some(n => n.state === 'running' || n.state === 'queued');
  useEffect(() => {
    const controller = new AbortController();
    void adminApi<BusinessMapFlow>(`business-map/companies/${ticker}/flow`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) { setFlow(result); setFailed(false); } })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [ticker, tick]);
  const shown = usePageActive();
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden && shown.current) setTick(n => n + 1); }, moving ? 5000 : 30000);
    return () => clearInterval(timer);
  }, [moving, shown]);
  useOnReturn(() => setTick(n => n + 1));
  const placed = useMemo(() => flow && layout(flow), [flow]);
  if (!flow || !placed) return <p className="bm-empty">{failed ? '流程不可读' : '读取流程'}</p>;
  const byId = new Map(flow.nodes.map(n => [n.id, n]));
  return <figure className="bm-flow" aria-label={`${ticker} 分析流程`}>
    <div className="bm-flow-scroll">
      <svg width={placed.width} height={placed.height} viewBox={`0 0 ${placed.width} ${placed.height}`} role="img" aria-label="分析流程图">
        <defs><marker id="bm-flow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" /></marker></defs>
        {flow.edges.map(edge => {
          const from = placed.position.get(edge.from)!, to = placed.position.get(edge.to)!, target = byId.get(edge.to)!;
          const x1 = from.x + NODE_W, y1 = from.y + NODE_H / 2, x2 = to.x - 2, y2 = to.y + NODE_H / 2, bend = Math.max(36, (x2 - x1) / 2);
          const cause = target.via?.from === edge.from;
          const live = (target.state === 'running' || target.state === 'queued') && (cause || (!target.via && byId.get(edge.from)!.state === 'done'));
          return <path key={`${edge.from}>${edge.to}`} className="bm-flow-edge" data-live={live || undefined} data-cause={cause || undefined}
            d={`M${x1} ${y1}C${x1 + bend} ${y1},${x2 - bend} ${y2},${x2} ${y2}`} markerEnd="url(#bm-flow-arrow)"><title>{edge.events.join('、')}</title></path>;
        })}
        {flow.nodes.map(node => {
          const { x, y } = placed.position.get(node.id)!, meta = NODE[node.id] ?? { label: node.id }, view = node.progress ? runView(node.progress) : null;
          return <g key={node.id} className="bm-flow-node" data-state={node.state} data-model={meta.model || undefined} data-source={node.source || undefined} transform={`translate(${x} ${y})`}>
            <title>{[meta.label, STATE[node.state], node.via ? `由 ${NODE[node.via.from]?.label ?? node.via.from} 的 ${node.via.event} 触发` : '', view?.step ?? ''].filter(Boolean).join('\n')}</title>
            <rect width={NODE_W} height={NODE_H} rx={node.source ? NODE_H / 2 : 8} />
            {meta.model && <rect className="bm-flow-model" width={3} height={NODE_H - 16} x={0} y={8} rx={1.5} />}
            <text x={12} y={19} className="bm-flow-label">{meta.label}</text>
            <text x={12} y={35} className="bm-flow-state">{status(node)}</text>
            {view && view.phases.map((phase, i) => <rect key={phase} className="bm-flow-phase" data-state={i < view.current ? 'done' : i === view.current ? 'current' : undefined}
              x={12 + i * ((NODE_W - 24) / view.phases.length)} y={NODE_H - 6} width={(NODE_W - 24) / view.phases.length - 2} height={3} rx={1.5} />)}
          </g>;
        })}
      </svg>
    </div>
    <figcaption>
      <span><i data-legend="model" />模型分析</span><span><i data-legend="running" />运行中</span><span><i data-legend="queued" />排队</span>
      <span><i data-legend="done" />完成</span><span><i data-legend="failed" />失败</span><span><i data-legend="live" />信息正在流入</span>
    </figcaption>
  </figure>;
}
