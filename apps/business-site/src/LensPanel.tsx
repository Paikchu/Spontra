import { Button } from "@/packages/web/src/ui/button";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/packages/web/src/ui/table";
import { getLocale, labels, messages } from "@/packages/web/src/i18n";
import { SourceLanguage, langOf } from "@/packages/web/src/i18n/SourceLanguage";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { ExplainerSource } from "@/shared/analysis-contract/business-explainer";
import type { FindingMaterial, FindingRecordEntry, FindingRef } from "@/shared/analysis-contract/findings";
import type { LensBlock, LensDocument as LensDocumentShape } from "@/shared/analysis-contract/lens";
import { spanLabel, watchPeriod, watchVerdict, type FindingData, type ResolvedEvidence, type ResolvedValue } from "@/shared/analysis-runtime/findings";
import { formatResolved } from "@/shared/analysis-runtime/lens/format";
import { multiple, normalizeDisplayText, shortPeriod } from "@/shared/analysis-runtime/locale";
import { documentFromEvidence, lensDocumentOf } from "@/shared/analysis-runtime/lens/legacy";
import { tableKey, verifyLensDocument, type VerifiedLens } from "@/shared/analysis-runtime/lens/verify";
import { KIND_LABEL, VIEW_LABEL, type VerifiedFinding } from "./findings-model";
import { SeverityIcon } from "./SeverityIcon";
import { LensFrame } from "./LensFrame";
import { HtmlFrame } from "./HtmlFrame";
import { ArtifactFrame } from "./ArtifactFrame";
import { usePreview, usePublishedArtifact } from "./artifact-reads";

const m = messages({
  finding: (title: string) => `Finding: ${title}`, report: (period: string) => `${period} report`,
  focusThis: "Focus this", exitComparison: "Exit comparison", compare: (kind: string) => `Compare · ${kind}`,
  close: "Close finding", nextQuarter: "Next quarter", fullYear: "Full year",
  reported: (period: string) => `${period} reported`, pending: (period: string) => `Pending · ${period} report`, pp: " pp",
  metric: "Metric", current: "Current", compared: "Compared with", change: "Change", value: "Value", traded: (date: string) => `Traded ${date}`,
}, {
  finding: (title: string) => `要点：${title}`, report: (period: string) => `${period} 财报`,
  focusThis: "聚焦此条", exitComparison: "退出对比", compare: (kind: string) => `对比 · ${kind}`,
  close: "关闭要点", nextQuarter: "下季度", fullYear: "全年",
  reported: (period: string) => `${period} 已公布`, pending: (period: string) => `待公布 · ${period} 财报`, pp: "个百分点",
  metric: "指标", current: "本期", compared: "对比", change: "变化", value: "数值", traded: (date: string) => `交易日 ${date}`,
});
const RECORD_VERDICT = labels({ pass: "Pass", fail: "Fail" }, { pass: "达成", fail: "未达成" });

const percent = (v: number | null, digits = 1) => v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}%`;
const trend = (v: number | null) => v == null || v === 0 ? undefined : v > 0 ? "up" : "down";
/** The first sentence: English sentences end at . ! or ? followed by a capital (so "$55.7" never splits); CJK prose at 。 */
const firstSentence = (text: string) => text.split(/(?<=[.!?])\s+(?=[A-Z])|(?<=。)/)[0];
const signed = (v: number, digits: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}`;
/** A ratio's change: percentage points for a rate-like ratio (below 1.5), turns for a multiple. */
const ratioChange = (r: ResolvedEvidence) => r.delta == null ? "—" : Math.abs(r.compare?.value ?? 0) < 1.5 && Math.abs(r.current.value) < 1.5 ? `${signed(r.delta * 100, 1)}${m.pp}` : getLocale() === "en" ? `${signed(r.delta, 2)}x` : multiple(signed(r.delta, 2), getLocale());
export const formatValue = (v: ResolvedValue, ref?: FindingRef): string => formatResolved(v, ref, getLocale());
/** A passage the filing library serves by id; a filing's own words read for one analysis link to the filing itself. */
const LIBRARY_PASSAGE = /^p[0-9a-f]{14,32}$/;
const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 20 * 86_400_000;

/**
 * The finding in focus, holding the whole stage: the finding as verified against the data the stage draws (its
 * judgment, figures and what to watch), then the analyst's dossier artifact when one is published for this
 * publication. Without a dossier the finding's own document stands, laid out from its chart.
 */
export function LensPanel({ finding, data, sources, materials, record, ticker, nodeColor, pair, onPair, onClose, split = false, compact = false, onFocusThis, dossier }: {
  finding: VerifiedFinding;
  data: FindingData;
  sources: ExplainerSource[];
  /** The publication's quoted materials and its earlier watches. */
  materials?: FindingMaterial[];
  record?: FindingRecordEntry[];
  ticker: string;
  nodeColor: (id: string) => string;
  pair: VerifiedFinding | null;
  /** Opens or closes the side-by-side view with the paired finding. */
  onPair: () => void;
  onClose: () => void;
  split?: boolean;
  /** The second panel of a pair: the judgment folded to its first sentence. */
  compact?: boolean;
  onFocusThis?: () => void;
  /** The finding's dossier artifact: its published version (null when none) and the subject a preview draft carries. */
  dossier?: { version: number | null; subject: string | null };
}) {
  const preview = usePreview("dossier", dossier?.subject ?? null);
  // A draft opened for the visual review shows only what the published dossier will: nothing of the finding's older document.
  const [previewing] = useState(() => new URLSearchParams(location.search).has("artifact-preview"));
  const published = usePublishedArtifact(ticker, !compact && dossier?.version ? `dossier/${finding.id}` : null, dossier?.version);
  const artifact = compact ? null : preview ?? published;
  // With a dossier the finding shows only its verified core above the analysis; the analysis is the artifact.
  const core = useMemo<LensDocumentShape | null>(() => artifact || (!compact && (dossier?.version || previewing)) ? { rows: [{ cells: [[{ kind: "judgment" }, { kind: "figures" }, ...(finding.watch ? [{ kind: "watch" as const }] : []), ...(record?.length ? [{ kind: "record" as const }] : [])]] }] } : null, [artifact, compact, dossier?.version, previewing, finding.watch, record?.length]);
  return <section className="lens" data-kind={finding.kind} data-compact={compact || undefined} aria-label={m.finding(finding.title)} key={finding.id}>
    <header className="lens-head">
      <div className="lens-title">
        <b className="lens-kind" data-kind={finding.kind}>{KIND_LABEL[finding.kind]}<SeverityIcon severity={finding.severity} /></b>
        <h2 lang={langOf(finding.title)}>{normalizeDisplayText(finding.title)}</h2>
        <span className="lens-basis">{m.report(shortPeriod(finding.periodEnd))} · {VIEW_LABEL[finding.anchors.view]}<SourceLanguage of={[finding.title, finding.judgment.text]} /></span>
      </div>
      <div className="lens-nav">
        {compact ? <Button variant="unstyled" type="button" className="lens-pair" onClick={onFocusThis}>{m.focusThis}</Button> : <>
          {pair && <Button variant="unstyled" type="button" className="lens-pair" aria-pressed={split} onClick={onPair} title={pair.title}>{split ? m.exitComparison : m.compare(KIND_LABEL[pair.kind])}</Button>}
          <Button variant="unstyled" type="button" className="lens-close" aria-label={m.close} onClick={onClose}>✕</Button>
        </>}
      </div>
    </header>
    <LensBlocks finding={finding} data={data} sources={sources} materials={materials} record={record} ticker={ticker} nodeColor={nodeColor} compact={compact} {...core ? { layout: core } : {}}>
      {artifact && <ArtifactFrame artifact={artifact} />}
    </LensBlocks>
  </section>;
}

/**
 * A finding's lens document as rows of cells; a chart's hover lights the evidence rows of the same period. The finding
 * page and the stage both draw a finding through it. `layout` overrides the finding's own (a stage scene's layout).
 */
export function LensBlocks({ finding, data, sources, materials, record, ticker, nodeColor, compact, layout, children }: { finding: VerifiedFinding; data: FindingData; sources: ExplainerSource[]; materials?: FindingMaterial[]; record?: FindingRecordEntry[]; ticker: string; nodeColor: (id: string) => string; compact: boolean; layout?: LensDocumentShape; children?: ReactNode }) {
  const colorOf = useCallback((ref: FindingRef) => "nodeId" in ref ? nodeColor(ref.nodeId) : "ratio" in ref && "nodeId" in ref.ratio.numerator ? nodeColor(ref.ratio.numerator.nodeId) : null, [nodeColor]);
  // Earlier watches other than this finding's own, scored against the data as it stands; only those that can be read.
  const scored = useMemo(() => (record ?? []).filter(e => e.findingId !== finding.id || e.periodEnd !== finding.periodEnd).map(e => ({ entry: e, result: watchVerdict(data, e.watch, e.periodEnd) })), [record, data, finding]);
  const lens = useMemo<VerifiedLens | null>(() => {
    const options = { colorOf, locale: getLocale() }, context = { ticker, materials, record: scored };
    return verifyLensDocument(layout ?? lensDocumentOf(finding, data, finding.periodEnd, options.locale), finding, finding.resolved, data, finding.periodEnd, options, context)
      ?? verifyLensDocument(documentFromEvidence(finding), finding, finding.resolved, data, finding.periodEnd, options, context);
  }, [finding, data, colorOf, ticker, materials, scored, layout]);
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
  // The figures block lists every figure of the evidence: a document that places it twice draws it once.
  const figures = lens.document.rows.flatMap(r => r.cells.flat()).find(b => b.kind === "figures");
  // A figure with nothing to compare (a Form 4's trade) leaves the comparison columns out rather than filling them with dashes.
  const compared = finding.resolved.some(r => r.compare != null);
  const block = (b: LensBlock, key: number): ReactNode => {
    switch (b.kind) {
      case "judgment": return <p key={key} className="lens-judgment" lang={langOf(finding.judgment.text)}>{normalizeDisplayText(compact ? firstSentence(finding.judgment.text) : finding.judgment.text)}{cites(finding.judgment.sourceIds)}</p>;
      case "prose": return b.paragraphs.map((p, i) => <p key={`${key}-${i}`} className="lens-prose" lang={langOf(p.text)}>{normalizeDisplayText(p.text)}{cites(p.sourceIds)}</p>);
      case "chart": { const chart = lens.charts[b.chart.id]; return chart ? <LensFrame key={key} chart={chart} onHover={hoverOf(chart.id)} /> : null; }
      case "html": return <HtmlFrame key={key} picture={b.html} />;
      case "figures": return b !== figures ? null : <Table key={key} className="lens-table lens-evidence">
        <TableHeader><TableRow><TableHead>{m.metric}</TableHead><TableHead>{compared ? m.current : m.value}</TableHead>{compared && <><TableHead>{m.compared}</TableHead><TableHead>{m.change}</TableHead></>}</TableRow></TableHeader>
        <TableBody>{finding.resolved.map((r, i) => <Evidence key={i} r={r} compared={compared} lit={hover != null && near(r.current.periodEnd, hover)} />)}</TableBody>
      </Table>;
      case "watch": return watch ? <div key={key} className="lens-watch" data-settled={outcome ? "" : undefined}>
        <p><b>{watch.horizon === "next_quarter" ? m.nextQuarter : m.fullYear}</b><span lang={langOf(watch.condition)}>{normalizeDisplayText(watch.condition)}</span></p>
        {outcome ? <p className="lens-outcome"><b>{m.reported(shortPeriod(outcome.periodEnd))}</b><Outcome r={outcome.resolved} /></p>
          : <p className="lens-outcome lens-outcome--pending">{m.pending(shortPeriod(watchPeriod(finding.periodEnd, watch)))}</p>}
      </div> : null;
      case "sources": return cited.length > 0 ? <ol key={key} className="sources sources--numbered">{cited.map(s => <li key={s.id} data-kind={s.kind}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}<span aria-hidden="true"> ↗</span></a>{s.kind === "web" && s.publishedAt && <small>{s.publishedAt.slice(0, 10)}</small>}</li>)}</ol> : null;
      case "quote": {
        const q = lens.quotes[b.materialId];
        if (!q) return null;
        const p = q.passage;
        return <figure key={key} className="lens-quote">
          <blockquote lang="en">{b.text}</blockquote>
          <figcaption data-kind={p.form === "web" ? "web" : "sec"}>{b.said && <span className="lens-quote-said">{b.said.speaker}{b.said.role ? ` · ${b.said.role}` : ""}</span>}<a href={p.form === "web" || !LIBRARY_PASSAGE.test(p.passageId) ? p.url : `/api/business/v1/companies/${encodeURIComponent(ticker)}/passages/${encodeURIComponent(p.passageId)}`} target="_blank" rel="noopener noreferrer">{p.title} · {p.form === "web" ? p.path[0] ?? "web" : p.form} · {p.filedAt}</a>{p.form !== "web" && p.path.length > 0 && <small>{p.path.slice(1).join(" › ")}</small>}</figcaption>
        </figure>;
      }
      case "table": {
        const t = lens.tables[tableKey(b.table)];
        if (!t) return null;
        return <Table key={key} className="lens-table">
          {t.title && <TableCaption lang={langOf(t.title)}>{normalizeDisplayText(t.title)}</TableCaption>}
          <TableHeader><TableRow><TableHead />{t.columns.map(c => <TableHead key={c.key}>{c.label}{c.sub && <small>{normalizeDisplayText(c.sub)}</small>}</TableHead>)}</TableRow></TableHeader>
          <TableBody>{t.rows.map((r, i) => <TableRow key={i}><TableHead scope="row">{r.label}</TableHead>{r.cells.map((c, j) => <TableCell key={j}>{c ? <>{normalizeDisplayText(c.text)}{c.change && <em data-trend={c.change.startsWith("+") ? "up" : c.change.startsWith("−") ? "down" : undefined}>{c.change}</em>}</> : null}</TableCell>)}</TableRow>)}</TableBody>
        </Table>;
      }
      case "record": return scored.length ? <dl key={key} className="lens-record">{scored.map(({ entry, result }) => <div key={`${entry.periodEnd}:${entry.findingId}`} className="lens-record-row" data-verdict={result?.verdict}>
        <dt><span>{shortPeriod(entry.periodEnd)} · {KIND_LABEL[entry.kind]}</span><span lang={langOf(entry.title)}>{normalizeDisplayText(entry.title)}</span></dt>
        <dd>{result ? <><b>{RECORD_VERDICT[result.verdict]}</b><span>{result.outcome.resolved.label} {formatValue(result.outcome.resolved.current, result.outcome.resolved.evidence.ref)}</span></> : <b data-pending="">{shortPeriod(watchPeriod(entry.periodEnd, entry.watch))}</b>}</dd>
      </div>)}</dl> : null;
    }
  };
  // One centred column: a row's cells read one after another, in the order the agent wrote them.
  return <div className="lens-doc">
    {lens.document.rows.map((row, i) => <div key={i} className="lens-doc-row">
      {row.title && <h3 className="lens-row-title" lang={langOf(row.title)}>{row.title}</h3>}
      {row.cells.map((cell, j) => <div key={j} className="lens-doc-cell">{cell.map((b, k) => block(b, k))}</div>)}
    </div>)}
    {children}
  </div>;
}

/** The watched figure as it came in: value and comparison. */
function Outcome({ r }: { r: ResolvedEvidence }) {
  return <span className="lens-outcome-body">
    <span>{r.label} <b data-trend={r.current.value < 0 && r.current.unit === "USD" ? "down" : undefined}>{formatValue(r.current, r.evidence.ref)}</b></span>
    {r.compare ? <em data-trend={trend(r.delta)}>{r.compareLabel} {formatValue(r.compare, r.evidence.ref)} · {r.current.unit === "percent" ? `${percent(r.delta).replace("%", "")}${m.pp}` : r.current.unit === "ratio" ? ratioChange(r) : percent(r.delta)}</em> : null}
  </span>;
}

/**
 * One figure as a table row: the value for its period (a trade's own date for a Form 4 figure), what it is compared
 * with, and the change; `compared` false leaves those two cells out.
 */
function Evidence({ r, compared, lit }: { r: ResolvedEvidence; compared: boolean; lit: boolean }) {
  const change = r.compare ? <em data-trend={trend(r.delta)}>{r.current.unit === "percent" ? `${percent(r.delta).replace("%", "")}${m.pp}` : r.current.unit === "ratio" ? ratioChange(r) : percent(r.delta)}</em> : null;
  return <TableRow data-lit={lit || undefined}>
    <TableHead scope="row">{r.label}<small>{"event" in r.evidence.ref ? m.traded(r.current.periodEnd) : spanLabel(r.current, getLocale())}</small></TableHead>
    <TableCell><b data-trend={r.current.value < 0 && r.current.unit === "USD" ? "down" : undefined}>{formatValue(r.current, r.evidence.ref)}</b></TableCell>
    {compared && <>
      <TableCell>{r.compare ? <>{formatValue(r.compare, r.evidence.ref)}{r.compareLabel && <small>{r.compareLabel}</small>}</> : "—"}</TableCell>
      <TableCell>{change ?? "—"}</TableCell>
    </>}
  </TableRow>;
}
