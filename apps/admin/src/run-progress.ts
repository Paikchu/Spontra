import type { FeatureRunProgress } from '../../../shared/analysis-contract/business-map-admin.ts';

/**
 * Where a run in flight stands, read from the step names its Workflow records (workers/analysis: workflow-core.ts for
 * the report job, ai-runs/tracking.ts for the model Workflows). Each kind's phases are in order; a step belongs to the
 * first rule it matches. Parallel work (the tree's businesses, the analyst's findings) shows the furthest phase reached.
 */
type Plan = { phases: string[]; rules: Array<[RegExp, number]>; step: Array<[RegExp, (m: RegExpExecArray) => string]> };

const turn = (verb: string | undefined) => ({ act: '思考', search: '网页搜索', read: '阅读', web: '读取网页', find: '检索资料库', similar: '查找相似业务', library: '读取年报业务章节' }[verb ?? ''] ?? '');
const nth = (value: string) => Number(value) + 1;
/** An agent turn's step: `…-t<turn>-act`, or a tool call in it, `…-t<turn>-<call>-<tool>` (`c<call>` in the agent loop). */
const TURN = /-t(\d+)(?:-c?\d+)?(?:-(\w+))?$/;
const turnLabel = (m: RegExpExecArray) => `第 ${m[1]} 轮${turn(m[2] ?? 'act')}`;

export const PLANS: Record<FeatureRunProgress['kind'], Plan> = {
  report: {
    phases: ['准备材料', '扫描披露', '规划', '分节分析', '综合成文', '编辑审校', '发布'],
    rules: [[/^(prepare|amendment-note|restore-analysis|context|brief)\b/, 0], [/^discovery(:|-finish|$)/, 1], [/^manager$/, 2],
      [/^(node|discovery-audit|discovery-repair|manager-review|repair-node)\b/, 3], [/^(synthesis|event-summary)\b/, 4], [/^editorial-/, 5], [/^(presentation|publish)/, 6]],
    step: [
      [/^discovery:(\d+)/, m => `扫描披露 · 第 ${nth(m[1]!)} 段`],
      [/^node:round:\d+:(\d+)/, m => `分节分析 · 第 ${nth(m[1]!)} 节`],
      [/^manager-review:round:(\d+)/, m => m[1] === '0' ? '主编审阅' : `主编审阅 · 第 ${m[1]} 轮补写后`],
      [/^repair-node:round:(\d+)/, m => `补写 · 第 ${m[1]} 轮`],
      [/^discovery-(audit|repair)/, () => '核对遗漏的披露'],
      [/^editorial-review:(\d+)/, m => `编辑审校 · 第 ${nth(m[1]!)} 轮`],
      [/^editorial-revision:(\d+)/, m => `按审校修订 · 第 ${m[1]} 轮`],
      [/^event-summary/, () => '撰写事件摘要'],
      [/^presentation/, () => '排版'],
    ],
  },
  guidance: {
    phases: ['收集材料', '提取指引', '发布'],
    rules: [[/^guidance-(extract|event-extracted|budget-wait)/, 1], [/^guidance-(publish|event-complete)/, 2], [/^guidance-/, 0]],
    step: [[/^guidance-budget-wait/, () => '等待模型额度'], [/^guidance-extract/, () => '从材料提取指引']],
  },
  findings: {
    phases: ['读取资料', '撰写要点', '绘制图表', '要点数字', '发布'],
    rules: [[/^findings-(time|input)$/, 0], [/^findings-(write|repair)$/, 1], [/^findings-lens-/, 2], [/^findings-highlights$/, 3], [/^findings-publish$/, 4]],
    step: [[/^findings-repair$/, () => '修正未通过项'], [/^findings-lens-.*draw-/, () => '渲染图表'], [/^findings-lens-/, m => { const t = TURN.exec(m.input); return t ? `图表 · ${turnLabel(t)}` : '绘制图表'; }]],
  },
  analyst: {
    phases: ['读取资料', '逐条研究', '发布'],
    rules: [[/^analyst-(time|input)$/, 0], [/^analyst-(trace|publish)$/, 2], [/^analyst-/, 1]],
    step: [[/^analyst-model-wait/, () => '等待模型恢复'], [/-review$/, () => '审校'], [TURN, turnLabel]],
  },
  checkup: {
    phases: ['读取资料', '逐项分析', '发布'],
    rules: [[/^checkup-(time|input)$/, 0], [/^checkup-(publish|empty)$/, 2], [/^checkup-/, 1]],
    step: [[TURN, turnLabel]],
  },
  explainer: {
    phases: ['读取业务', '检索资料', '撰写', '审校', '发布'],
    rules: [[/^explainer-(time|input)$/, 0], [/^explainer-(evidence|plan|follow-up)/, 1], [/^explainer-write/, 2], [/^explainer-review/, 3], [/^explainer-publish$/, 4]],
    step: [
      [/^explainer-evidence-filing$/, () => '读取财报原文'],
      [/^explainer-evidence-(\d+)$/, m => `检索资料 · 第 ${nth(m[1]!)} 组`],
      [/^explainer-plan-(\d+)$/, m => `规划补充检索 · 第 ${nth(m[1]!)} 组`],
      [/^explainer-follow-up-(\d+)$/, m => `补充检索 · 第 ${nth(m[1]!)} 组`],
      [/^explainer-write-(\d+)$/, m => `撰写 · 第 ${nth(m[1]!)} 组`],
      [/^explainer-review-(\d+)$/, m => `审校 · 第 ${nth(m[1]!)} 组`],
    ],
  },
  valuation: {
    phases: ['读取资料', '先验试算', '研究', '假设与计算', '反证', '成稿', '发布'],
    rules: [[/^valuation-(time|input|quote)$/, 0], [/^valuation-prior$/, 1], [/^valuation-research-/, 2], [/^valuation-assume-/, 3], [/^valuation-redteam/, 4], [/^valuation-compose-/, 5], [/^valuation-publish$/, 6]],
    step: [[/^valuation-quote$/, () => '冻结参考收盘价'], [/^valuation-prior$/, () => '按历史先验试算'], [/^valuation-(research|assume|compose)-/, m => { const t = TURN.exec(m.input); return t ? `${{ research: '研究', assume: '假设', compose: '成稿' }[m[1]!]} · ${turnLabel(t)}` : ''; }]],
  },
  tree: {
    phases: ['读取业务', '研究', '审校', '描述', '复核', '发布'],
    rules: [[/^tree-(time|input|filings)$/, 0], [/^tree-b\d+-describe-review/, 4], [/^tree-b\d+-describe/, 3], [/^tree-b\d+-review/, 2], [/^tree-b\d+-/, 1], [/^tree-publish$/, 5]],
    step: [
      [/^tree-filings$/, () => '列出财报与年报'],
      [/^tree-b(\d+)-library$/, m => `第 ${m[1]} 项业务 · 读取年报业务章节`],
      [/^tree-b(\d+)-t\d+/, m => `第 ${m[1]} 项业务 · ${turnLabel(TURN.exec(m.input)!)}`],
      [/^tree-b(\d+)-(describe-review|describe|review)/, m => `第 ${m[1]} 项业务 · ${{ review: '审校', describe: '描述', 'describe-review': '复核描述' }[m[2]!]}`],
    ],
  },
};

const phaseOf = (plan: Plan, stage: string) => plan.rules.find(([pattern]) => pattern.test(stage))?.[1] ?? -1;

export type RunView = { phases: string[]; current: number; step: string | null; steps: number };

/** The run's phases, the furthest one reached, and a line for the step it is on now. */
export function runView(run: FeatureRunProgress): RunView {
  const plan = PLANS[run.kind];
  const stages = [...run.steps.map(s => s.stage), ...run.stage ? [run.stage] : []];
  const current = Math.max(0, ...stages.map(stage => phaseOf(plan, stage)));
  let step: string | null = null;
  if (run.stage) for (const [pattern, label] of plan.step) { const m = pattern.exec(run.stage); if (m) { step = label(m); break; } }
  return { phases: plan.phases, current, step, steps: run.steps.length };
}

/** How long a run has been going, from its start to its last record. */
export function runElapsed(run: Pick<FeatureRunProgress, 'startedAt' | 'updatedAt'>, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((Math.max(now, Date.parse(run.updatedAt)) - Date.parse(run.startedAt)) / 1000));
  return seconds < 60 ? `${seconds} 秒` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分钟` : `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`;
}
