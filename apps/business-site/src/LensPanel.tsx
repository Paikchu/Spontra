import { Button } from "@/packages/web/src/ui/button";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { ExplainerSource } from "@/shared/analysis-contract/business-explainer";
import type { FindingMaterial, FindingRecordEntry, FindingRef } from "@/shared/analysis-contract/findings";
import type { LensBlock } from "@/shared/analysis-contract/lens";
import { spanLabel, watchPeriod, watchVerdict, type FindingData, type ResolvedEvidence, type ResolvedValue } from "@/shared/analysis-runtime/findings";
import { formatResolved } from "@/shared/analysis-runtime/lens/format";
import { documentFromEvidence, lensDocumentOf } from "@/shared/analysis-runtime/lens/legacy";
import { tableKey, verifyLensDocument, type VerifiedLens } from "@/shared/analysis-runtime/lens/verify";
import { KIND_LABEL, VIEW_LABEL, type VerifiedFinding } from "./findings-model";
import { LensFrame } from "./LensFrame";

const shortPeriod = (end: string) => end.slice(0, 7).replace("-", ".");
const percent = (v: number | null, digits = 1) => v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}%`;
const trend = (v: number | null) => v == null || v === 0 ? undefined : v > 0 ? "up" : "down";
const VERDICT = { above: "Above guidance", within: "Within guidance", below: "Below guidance" } as const;
/** The first sentence: English sentences end at . ! or ? followed by a capital (so "$55.7" never splits); CJK prose at 。 */
const firstSentence = (text: string) => text.split(/(?<=[.!?])\s+(?=[A-Z])|(?<=。)/)[0];
const signed = (v: number, digits: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}`;
/** A ratio's change: percentage points for a rate-like ratio (below 1.5), turns for a multiple. */
const ratioChange = (r: ResolvedEvidence) => r.delta == null ? "—" : Math.abs(r.compare?.value ?? 0) < 1.5 && Math.abs(r.current.value) < 1.5 ? `${signed(r.delta * 100, 1)} pp` : `${signed(r.delta, 2)}x`;
export const formatValue = (v: ResolvedValue, ref?: FindingRef): string => formatResolved(v, ref);
const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 20 * 86_400_000;

/**
 * The finding in focus, holding the whole stage: its lens document (charts in frames, the judgment,
 * the figures, what to watch, the sources) as the agent laid it out, verified against the same data
 * the stage draws. Findings written before the agent are laid out the standard way from their chart.
 */
export function LensPanel({ finding, data, sources, materials, record, ticker, nodeColor, pair, story, index, count, onPair, onStep, onClose, split = false, compact = false, onFocusThis }: {
  finding: VerifiedFinding;
  data: FindingData;
  sources: ExplainerSource[];
  /** The publication's quoted materials and its earlier watches. */
  materials?: FindingMaterial[];
  record?: FindingRecordEntry[];
  ticker: string;
  nodeColor: (id: string) => string;
  pair: VerifiedFinding | null;
  story: boolean;
  index: number;
  count: number;
  /** Opens or closes the side-by-side view with the paired finding. */
  onPair: () => void;
  onStep: (delta: 1 | -1) => void;
  onClose: () => void;
  split?: boolean;
  /** The second panel of a pair: the judgment folded to its first sentence. */
  compact?: boolean;
  onFocusThis?: () => void;
}) {
  return <section className="lens" data-kind={finding.kind} data-compact={compact || undefined} aria-label={`Finding: ${finding.title}`} key={finding.id}>
    <header className="lens-head">
      <div className="lens-title">
        <b className="lens-kind" data-kind={finding.kind}>{KIND_LABEL[finding.kind]}<i aria-label={`Severity ${finding.severity}`}>{"●".repeat(finding.severity)}</i></b>
        <h2>{finding.title}</h2>
        <span className="lens-basis">{shortPeriod(finding.periodEnd)} report · {VIEW_LABEL[finding.anchors.view]}</span>
      </div>
      <div className="lens-nav">
        {compact ? <Button variant="unstyled" type="button" className="lens-pair" onClick={onFocusThis}>Focus this</Button> : <>
          {pair && <Button variant="unstyled" type="button" className="lens-pair" aria-pressed={split} onClick={onPair} title={pair.title}>{split ? "Exit comparison" : `Compare · ${KIND_LABEL[pair.kind]}`}</Button>}
          {story && <span className="lens-steps"><Button variant="unstyled" type="button" aria-label="Previous finding" disabled={index <= 0} onClick={() => onStep(-1)}>‹</Button><span>{index + 1} / {count}</span><Button variant="unstyled" type="button" aria-label="Next finding" disabled={index >= count - 1} onClick={() => onStep(1)}>›</Button></span>}
          <Button variant="unstyled" type="button" className="lens-close" aria-label="Close finding" onClick={onClose}>✕</Button>
        </>}
      </div>
    </header>
    <LensDocument finding={finding} data={data} sources={sources} materials={materials} record={record} ticker={ticker} nodeColor={nodeColor} compact={compact} />
  </section>;
}

/** The document as rows of cells; a chart's hover lights the evidence rows of the same period. */
function LensDocument({ finding, data, sources, materials, record, ticker, nodeColor, compact }: { finding: VerifiedFinding; data: FindingData; sources: ExplainerSource[]; materials?: FindingMaterial[]; record?: FindingRecordEntry[]; ticker: string; nodeColor: (id: string) => string; compact: boolean }) {
  const colorOf = useCallback((ref: FindingRef) => "nodeId" in ref ? nodeColor(ref.nodeId) : "ratio" in ref && "nodeId" in ref.ratio.numerator ? nodeColor(ref.ratio.numerator.nodeId) : null, [nodeColor]);
  // Earlier watches other than this finding's own, scored against the data as it stands; only those that can be read.
  const scored = useMemo(() => (record ?? []).filter(e => e.findingId !== finding.id || e.periodEnd !== finding.periodEnd).map(e => ({ entry: e, result: watchVerdict(data, e.watch, e.periodEnd) })), [record, data, finding]);
  const lens = useMemo<VerifiedLens | null>(() => {
    const options = { colorOf }, context = { ticker, materials, record: scored };
    return verifyLensDocument(lensDocumentOf(finding, data, finding.periodEnd), finding, finding.resolved, data, finding.periodEnd, options, context)
      ?? verifyLensDocument(documentFromEvidence(finding), finding, finding.resolved, data, finding.periodEnd, options, context);
  }, [finding, data, colorOf, ticker, materials, scored]);
  // Sources numbered in the order the document cites them, so every citation mark points at one list.
  const cited = useMemo(() => {
    const ids = [...finding.judgment.sourceIds, ...(lens?.document.rows ?? []).flatMap(r => r.cells.flat()).flatMap(b => b.kind === "prose" ? b.paragraphs.flatMap(p => p.sourceIds) : [])];
    return [...new Set(ids)].map(id => sources.find(s => s.id === id)).filter((s): s is ExplainerSource => s != null);
  }, [finding, lens, sources]);
  const cites = (ids: string[]) => <span className="cites">{ids.map(id => { const i = cited.findIndex(s => s.id === id); return i < 0 ? null : <a key={id} href={cited[i]!.url} target="_blank" rel="noopener noreferrer" title={cited[i]!.title}>{i + 1}</a>; })}</span>;
  const [hover, setHover] = useState<string | null>(null);
  const hoverOf = useCallback((chartId: string) => (period: number | null) => { const c = lens?.charts[chartId]; setHover(period != null && c ? c.periods[period]?.end ?? null : null); }, [lens]);
  if (!lens) return null;
  const watch = finding.watch, outcome = finding.watchOutcome;
  const block = (b: LensBlock, key: number): ReactNode => {
    switch (b.kind) {
      case "judgment": return <p key={key} className="lens-judgment">{compact ? firstSentence(finding.judgment.text) : finding.judgment.text}{cites(finding.judgment.sourceIds)}</p>;
      case "prose": return b.paragraphs.map((p, i) => <p key={`${key}-${i}`} className="lens-prose">{p.text}{cites(p.sourceIds)}</p>);
      case "chart": { const chart = lens.charts[b.chart.id]; return chart ? <LensFrame key={key} chart={chart} onHover={hoverOf(chart.id)} /> : null; }
      case "figures": return <dl key={key} className="lens-evidence">{finding.resolved.map((r, i) => <Evidence key={i} r={r} lit={hover != null && near(r.current.periodEnd, hover)} />)}</dl>;
      case "watch": return watch ? <div key={key} className="lens-watch" data-settled={outcome ? "" : undefined}>
        <p><b>{watch.horizon === "next_quarter" ? "Next quarter" : "Full year"}</b>{watch.condition}</p>
        {outcome ? <p className="lens-outcome"><b>{shortPeriod(outcome.periodEnd)} reported</b><Outcome r={outcome.resolved} /></p>
          : <p className="lens-outcome lens-outcome--pending">Pending · {shortPeriod(watchPeriod(finding.periodEnd, watch))} report</p>}
      </div> : null;
      case "sources": return cited.length > 0 ? <ol key={key} className="sources sources--numbered">{cited.map(s => <li key={s.id}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}<span aria-hidden="true"> ↗</span></a></li>)}</ol> : null;
      case "quote": {
        const q = lens.quotes[b.materialId];
        if (!q) return null;
        const p = q.passage;
        return <figure key={key} className="lens-quote">
          <blockquote>{b.text}</blockquote>
          <figcaption>{b.said && <span className="lens-quote-said">{b.said.speaker}{b.said.role ? ` · ${b.said.role}` : ""}</span>}<a href={`/api/business/v1/companies/${encodeURIComponent(ticker)}/passages/${encodeURIComponent(p.passageId)}`} target="_blank" rel="noopener noreferrer">{p.title} · {p.form} · {p.filedAt}</a>{p.path.length > 0 && <small>{p.path.slice(1).join(" › ")}</small>}</figcaption>
        </figure>;
      }
      case "table": {
        const t = lens.tables[tableKey(b.table)];
        if (!t) return null;
        return <table key={key} className="lens-table">
          {t.title && <caption>{t.title}</caption>}
          <thead><tr><th scope="col" />{t.columns.map(c => <th key={c.key} scope="col">{c.label}{c.sub && <small>{c.sub}</small>}</th>)}</tr></thead>
          <tbody>{t.rows.map((r, i) => <tr key={i}><th scope="row">{r.label}</th>{r.cells.map((c, j) => <td key={j}>{c ? <>{c.text}{c.change && <em data-trend={c.change.startsWith("+") ? "up" : c.change.startsWith("−") ? "down" : undefined}>{c.change}</em>}</> : null}</td>)}</tr>)}</tbody>
        </table>;
      }
      case "record": return scored.length ? <dl key={key} className="lens-record">{scored.map(({ entry, result }) => <div key={`${entry.periodEnd}:${entry.findingId}`} className="lens-record-row" data-verdict={result?.verdict}>
        <dt><span>{shortPeriod(entry.periodEnd)} · {KIND_LABEL[entry.kind]}</span>{entry.title}</dt>
        <dd>{result ? <><b>{result.verdict}</b><span>{result.outcome.resolved.label} {formatValue(result.outcome.resolved.current, result.outcome.resolved.evidence.ref)}</span></> : <b data-pending="">{shortPeriod(watchPeriod(entry.periodEnd, entry.watch))}</b>}</dd>
      </div>)}</dl> : null;
    }
  };
  return <div className="lens-doc">
    {lens.document.rows.map((row, i) => {
      const chartIn = (cell: LensBlock[]) => cell.some(b => b.kind === "chart");
      const lead = row.cells.length === 2 ? chartIn(row.cells[0]!) && !chartIn(row.cells[1]!) ? "first" : chartIn(row.cells[1]!) && !chartIn(row.cells[0]!) ? "second" : undefined : undefined;
      return <div key={i} className="lens-doc-row" data-cells={row.cells.length} data-lead={lead} data-titled={row.title ? "" : undefined}>
        {row.title && <h3 className="lens-row-title">{row.title}</h3>}
        {row.cells.map((cell, j) => <div key={j} className="lens-doc-cell">{cell.map((b, k) => block(b, k))}</div>)}
      </div>;
    })}
  </div>;
}

/** The watched figure as it came in: value, comparison and, against guidance, whether it landed inside. */
function Outcome({ r }: { r: ResolvedEvidence }) {
  return <span className="lens-outcome-body">
    <span>{r.label} <b data-trend={r.current.value < 0 && r.current.unit === "USD" ? "down" : undefined}>{formatValue(r.current, r.evidence.ref)}</b></span>
    {r.guidance ? <em data-verdict={r.guidance.verdict}>{r.guidance.unit === "percent" && r.current.unit !== "percent" ? `YoY ${percent(r.guidance.measured)} · ` : ""}{VERDICT[r.guidance.verdict]}{r.compare ? ` ${formatValue(r.compare, r.evidence.ref)}` : ""}</em>
      : r.compare ? <em data-trend={trend(r.delta)}>{r.compareLabel} {formatValue(r.compare, r.evidence.ref)} · {r.current.unit === "percent" ? `${percent(r.delta).replace("%", "")} pp` : r.current.unit === "ratio" ? ratioChange(r) : percent(r.delta)}</em> : null}
  </span>;
}

function Evidence({ r, lit }: { r: ResolvedEvidence; lit: boolean }) {
  const note = r.guidance ? <em data-verdict={r.guidance.verdict}>{VERDICT[r.guidance.verdict]}{r.compare ? ` ${formatValue(r.compare, r.evidence.ref)}` : ""}</em>
    : r.compare ? <em data-trend={trend(r.delta)}>{r.compareLabel} {formatValue(r.compare, r.evidence.ref)} · {r.current.unit === "percent" ? `${percent(r.delta).replace("%", "")} pp` : r.current.unit === "ratio" ? ratioChange(r) : percent(r.delta)}</em> : null;
  return <div className="lens-row" data-lit={lit || undefined}>
    <dt>{r.label}<small>{spanLabel(r.current)}</small></dt>
    <dd><b data-trend={r.current.value < 0 && r.current.unit === "USD" ? "down" : undefined}>{formatValue(r.current, r.evidence.ref)}</b>{note}</dd>
  </div>;
}
