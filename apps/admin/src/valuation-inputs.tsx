import { useEffect, useState, type FormEvent } from 'react';
import type { ValuationCompanyInputs } from '@/shared/analysis-contract/valuation';
import { adminApi, AdminApiError } from './admin-api';

/** Tickers as the admin types them: separated by commas or spaces, upper-cased, a share class written with a dot. */
function parsePeerField(text: string): string[] | null {
  const tickers = [...new Set(text.split(/[\s,，]+/).map(t => t.trim().toUpperCase().replaceAll('-', '.')).filter(Boolean))];
  return tickers.length ? tickers : null;
}

/**
 * A company's valuation inputs (business-map/companies/<T>/valuation-inputs): the comparable set the cross-check tries
 * first, and management's cited targets as JSON. An empty field clears that input; the service validates both.
 */
export function ValuationInputs({ ticker, onUnauthorized }: { ticker: string; onUnauthorized: () => void }) {
  const [inputs, setInputs] = useState<ValuationCompanyInputs | null>(null);
  const [peers, setPeers] = useState(''), [targets, setTargets] = useState('');
  const [error, setError] = useState(''), [saving, setSaving] = useState(false), [saved, setSaved] = useState(false);
  const show = (value: ValuationCompanyInputs) => { setInputs(value); setPeers(value.peers?.join(', ') ?? ''); setTargets(value.targets ? JSON.stringify(value.targets, null, 2) : ''); };
  useEffect(() => {
    let live = true;
    adminApi<ValuationCompanyInputs>(`business-map/companies/${encodeURIComponent(ticker)}/valuation-inputs`)
      .then(value => { if (live) show(value); })
      .catch(e => { if (!live) return; if (e instanceof AdminApiError && e.status === 401) onUnauthorized(); else setError(e instanceof Error ? e.message : '读取失败'); });
    return () => { live = false; };
  }, [ticker, onUnauthorized]);
  async function save(event: FormEvent) {
    event.preventDefault();
    setError(''); setSaved(false);
    let parsed: unknown = null;
    if (targets.trim()) { try { parsed = JSON.parse(targets); } catch { setError('管理层目标不是有效的 JSON'); return; } }
    setSaving(true);
    try {
      show(await adminApi<ValuationCompanyInputs>(`business-map/companies/${encodeURIComponent(ticker)}/valuation-inputs`, { method: 'POST', body: JSON.stringify({ peers: parsePeerField(peers), targets: parsed }) }));
      setSaved(true);
    } catch (e) { if (e instanceof AdminApiError && e.status === 401) onUnauthorized(); else setError(e instanceof Error ? e.message : '保存失败'); }
    finally { setSaving(false); }
  }
  if (!inputs) return <section className="bm-valuation" aria-label={`${ticker} 估值输入`}><h4>估值输入</h4>{error ? <p role="alert" className="ra-error">{error}</p> : <p className="bm-empty">读取中</p>}</section>;
  return <form className="bm-valuation" aria-label={`${ticker} 估值输入`} onSubmit={save}>
    <h4>估值输入</h4>
    <label htmlFor={`bm-peers-${ticker}`}>可比公司</label>
    <input id={`bm-peers-${ticker}`} value={peers} onChange={e => { setPeers(e.target.value); setSaved(false); }} placeholder="留空则按业务标签选择" autoComplete="off" spellCheck={false} />
    <label htmlFor={`bm-targets-${ticker}`}>管理层目标</label>
    <textarea id={`bm-targets-${ticker}`} value={targets} onChange={e => { setTargets(e.target.value); setSaved(false); }} placeholder="留空则无管理层情景" rows={targets ? 14 : 3} spellCheck={false} />
    <p className="bm-valuation-meta">{inputs.fiscalYearEndMonth ? `财年结束：${inputs.fiscalYearEndMonth} 月` : '财报未给出财年结束月份，目标暂不使用'}{inputs.targets && ` · 截至 ${inputs.targets.asOf}`}{inputs.updatedAt && ` · 更新于 ${inputs.updatedAt.slice(0, 10)}`}</p>
    {error && <p role="alert" className="ra-error">{error}</p>}
    <div className="bm-valuation-actions"><button className="fm-button" disabled={saving}>{saving ? '保存中' : '保存'}</button>{saved && <span role="status">已保存</span>}</div>
  </form>;
}
