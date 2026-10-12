import { useEffect, useRef, useState } from 'react';
import type { BusinessMapCharts } from '@/shared/analysis-contract/business-map-admin';
import { FLOW_METRICS, type BusinessFlowQuarter, type FlowAmount, type FlowMetric } from '@/shared/analysis-contract/business-flow';
import type { CapitalLine, CapitalQuarter } from '@/shared/analysis-contract/capital-structure';
import { adminApi, AdminApiError } from './admin-api';

type Chart = 'profit' | 'cash' | 'balance';
const CHARTS: Array<[Chart, string]> = [['profit', '利润'], ['cash', '现金流'], ['balance', '资产负债']];
const METRICS: Record<FlowMetric, string> = {
  revenue: '营业收入', cost: '营业成本', gross: '毛利', research: '研发费用', sales: '销售费用', administration: '管理费用',
  operatingExpenses: '营业费用合计', operating: '营业利润', other: '其他收支', pretax: '税前利润', tax: '所得税', net: '净利润',
};
const TOTALS = new Set<FlowMetric>(['revenue', 'gross', 'operating', 'pretax', 'net']);
const GROUPS: Record<string, string> = {
  cash: '现金及短期投资', receivables: '应收', inventory: '存货', productive: '固定资产', leaseAssets: '租赁资产', intangibles: '无形资产及商誉', investments: '投资',
  debt: '债务', leases: '租赁负债', customerAdvances: '合同负债', payables: '应付', deferredTax: '递延税项',
  paidIn: '实收资本', retained: '留存收益', otherEquity: '其他权益', noncontrolling: '少数股东权益', redeemable: '可赎回权益',
  netIncome: '净利润', nonCash: '非现金项目', workingCapital: '营运资本', capex: '资本开支', acquisitions: '收购',
  debtIssued: '发债', debtRepaid: '还债', equityIssued: '发股', buybacks: '回购', dividends: '分红', leasePrincipal: '租赁本金', other: '其他',
};

/** A statement row: values by period end, in base currency units; null where the quarter has no figure. */
type Row = { key: string; label: string; values: Map<string, number | null>; kind?: 'head' | 'total'; note?: string };
const amount = (a: FlowAmount | null | undefined, q: BusinessFlowQuarter) => a?.value == null ? null : Number(a.value) * q.scale;
const million = (v: number | null | undefined) => v == null ? '—' : (v / 1e6).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function profitRows(quarters: BusinessFlowQuarter[]): Row[] {
  const rows: Row[] = [];
  const add = (key: string, label: string, pick: (q: BusinessFlowQuarter) => number | null, kind?: Row['kind'], note?: string) => {
    const values = new Map(quarters.map(q => [q.periodEnd, pick(q)]));
    if ([...values.values()].some(v => v != null)) rows.push({ key, label, values, kind, note });
  };
  const union = <T extends { id: string; name: string }>(list: (q: BusinessFlowQuarter) => T[] | undefined) =>
    [...new Map(quarters.flatMap(q => list(q) ?? []).map(x => [x.id, x.name])).entries()];
  rows.push({ key: 'h-seg', label: '分部收入', values: new Map(), kind: 'head' });
  for (const [id, name] of union(q => q.segments)) add(`seg-${id}`, name, q => amount(q.segments.find(s => s.id === id)?.revenue, q));
  for (const [id, name] of union(q => q.revenueAdjustments)) add(`adj-${id}`, name, q => amount(q.revenueAdjustments?.find(a => a.id === id)?.amount, q), undefined, '抵销');
  rows.push({ key: 'h-is', label: '利润表', values: new Map(), kind: 'head' });
  for (const metric of FLOW_METRICS) add(`m-${metric}`, METRICS[metric], q => amount(q.figures[metric], q), TOTALS.has(metric) ? 'total' : undefined,
    quarters.some(q => q.figures[metric]?.basis === 'derived') ? '含推导' : undefined);
  const expenses = union(q => q.expenseComponents);
  if (expenses.length) {
    rows.push({ key: 'h-exp', label: '费用明细', values: new Map(), kind: 'head' });
    for (const [id, name] of expenses) add(`exp-${id}`, name, q => amount(q.expenseComponents?.find(e => e.id === id)?.amount, q));
  }
  return rows;
}

function lineRows<G extends string>(head: string, quarters: CapitalQuarter[], lines: (q: CapitalQuarter) => CapitalLine<G>[] | null | undefined, total?: [string, (q: CapitalQuarter) => string | null | undefined]): Row[] {
  const known = new Map<string, CapitalLine<G>>();
  for (const q of quarters) for (const l of lines(q) ?? []) if (!known.has(l.id)) known.set(l.id, l);
  const rows: Row[] = [{ key: `h-${head}`, label: head, values: new Map(), kind: 'head' }];
  for (const [id, line] of known) rows.push({ key: `${head}-${id}`, label: line.label, note: GROUPS[line.group] ?? line.group,
    values: new Map(quarters.map(q => { const l = lines(q)?.find(x => x.id === id); return [q.periodEnd, l ? Number(l.value) : null]; })) });
  if (total) rows.push({ key: `${head}-total`, label: total[0], kind: 'total', values: new Map(quarters.map(q => { const v = total[1](q); return [q.periodEnd, v == null ? null : Number(v)]; })) });
  return rows;
}

function cashRows(quarters: CapitalQuarter[]): Row[] {
  const cf = (q: CapitalQuarter) => q.cashFlow;
  return [
    ...lineRows('经营活动', quarters, q => cf(q)?.operating.lines, ['经营活动现金流', q => cf(q)?.operating.total]),
    ...lineRows('投资活动', quarters, q => cf(q)?.investing.lines, ['投资活动现金流', q => cf(q)?.investing.total]),
    ...lineRows('筹资活动', quarters, q => cf(q)?.financing.lines, ['筹资活动现金流', q => cf(q)?.financing.total]),
    { key: 'fx', label: '汇率影响', values: new Map(quarters.map(q => [q.periodEnd, cf(q)?.fxEffect == null ? null : Number(cf(q)!.fxEffect)])) },
    { key: 'net', label: '现金净变动', kind: 'total', values: new Map(quarters.map(q => [q.periodEnd, cf(q) ? Number(cf(q)!.netChange) : null])) },
  ];
}

function balanceRows(quarters: CapitalQuarter[]): Row[] {
  const bs = (q: CapitalQuarter) => q.balanceSheet;
  return [
    ...lineRows('资产', quarters, q => bs(q)?.assets, ['总资产', q => bs(q)?.totals.assets]),
    ...lineRows('负债', quarters, q => bs(q)?.liabilities, ['总负债', q => bs(q)?.totals.liabilities]),
    ...lineRows('权益', quarters, q => bs(q)?.equity, ['总权益', q => bs(q)?.totals.equity]),
  ];
}

function Statement({ periods, rows, currency }: { periods: string[]; rows: Row[]; currency: string }) {
  return <div className="bc-wrap"><table className="bc-table">
    <thead><tr><th>{`百万 ${currency}`}</th>{periods.map(p => <th key={p}>{p}</th>)}</tr></thead>
    <tbody>{rows.map(r => r.kind === 'head'
      ? <tr key={r.key} className="bc-head"><th colSpan={periods.length + 1}>{r.label}</th></tr>
      : <tr key={r.key} data-kind={r.kind}><th>{r.label}{r.note && <small>{r.note}</small>}</th>{periods.map(p => { const v = r.values.get(p); return <td key={p} data-negative={v != null && v < 0 || undefined}>{million(v)}</td>; })}</tr>)}</tbody>
  </table></div>;
}

/** The figures behind BusinessView's three charts — profit, cash flow and balance sheet — as quarterly statements. */
export function BusinessCharts({ ticker, onUnauthorized }: { ticker: string; onUnauthorized: () => void }) {
  const [data, setData] = useState<BusinessMapCharts | null>(null), [error, setError] = useState(''), [chart, setChart] = useState<Chart>('profit');
  const unauthorized = useRef(onUnauthorized);
  useEffect(() => { unauthorized.current = onUnauthorized; }, [onUnauthorized]);
  useEffect(() => {
    const c = new AbortController();
    void adminApi<BusinessMapCharts>(`business-map/companies/${encodeURIComponent(ticker)}/charts`, { signal: c.signal }).then(r => { setData(r); setError(''); })
      .catch(e => { if (c.signal.aborted) return; if (e instanceof AdminApiError && e.status === 401) unauthorized.current(); else setError((e as Error).message); });
    return () => c.abort();
  }, [ticker]);
  if (error) return <p className="ra-error">{error}</p>;
  if (!data || data.ticker !== ticker) return <p className="fl-empty">加载中</p>;
  const profit = data.profit?.quarters ?? [], capital = [...data.capital?.quarters ?? []].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
  const capitalCurrency = capital.find(q => q.balanceSheet)?.balanceSheet?.currency ?? capital.find(q => q.cashFlow)?.cashFlow?.currency ?? 'USD';
  const cash = capital.filter(q => q.cashFlow), balance = capital.filter(q => q.balanceSheet);
  const available: Record<Chart, number> = { profit: profit.length, cash: cash.length, balance: balance.length };
  return <div className="bc">
    <div className="bc-bar"><nav className="ra-segmented" aria-label="图表">{CHARTS.map(([k, label]) => <button key={k} aria-pressed={chart === k} onClick={() => setChart(k)}>{label}<small>{available[k]}</small></button>)}</nav>
      <span className="ra-badge" data-status={data.status === 'ready' ? 'reviewed' : 'idle'}>{data.status === 'ready' ? '地图已发布' : data.status === 'preparing' ? '准备中' : '未发布'}</span></div>
    {chart === 'profit' ? profit.length ? <Statement periods={profit.map(q => q.periodEnd)} rows={profitRows(profit)} currency={profit[0]!.currency} /> : <p className="fl-empty">无利润数据</p>
      : chart === 'cash' ? cash.length ? <Statement periods={cash.map(q => q.periodEnd)} rows={cashRows(cash)} currency={capitalCurrency} /> : <p className="fl-empty">无现金流数据</p>
      : balance.length ? <Statement periods={balance.map(q => q.periodEnd)} rows={balanceRows(balance)} currency={capitalCurrency} /> : <p className="fl-empty">无资产负债数据</p>}
  </div>;
}
