import { useMemo, useState, type ReactNode } from "react";
import { Button } from "@/packages/web/src/ui/button";
import type { ExplainerClaim, ExplainerSource } from "@/shared/analysis-contract/business-explainer";
import { GRADE_LABEL, ROLE_LABEL, STAGE_LABEL, STATUS_LABEL, PARTY_ROLES, type BusinessNarrative, type CompanyNarrative, type NarrativeCheck, type NarrativeLink, type NarrativeStage, type NarrativeStatus } from "@/shared/analysis-contract/business-narrative";
import { spanLabel, type FindingData, type ResolvedEvidence } from "@/shared/analysis-runtime/findings";
import { DossierTabs } from "./DossierTabs";
import { formatValue } from "./LensPanel";
import { checkIndex, linkChecks, milestoneDate, resolveCheck, resolveTie } from "./narrative-model";

const percent = (v: number | null, digits = 1) => v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}%`;
const trend = (v: number | null) => v == null || v === 0 ? undefined : v > 0 ? "up" : "down";
const MILESTONE_LABEL = { done: "已完成", planned: "计划中", delayed: "已延后" } as const;
const VERDICT = { above: "高于指引", within: "落在指引内", below: "低于指引" } as const;
const signed = (v: number, digits: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}`;
/** A ratio's change reads in points when rate-like (below 1.5) and in turns when a multiple, as the lens does. */
const ratioChange = (r: ResolvedEvidence) => r.delta == null ? "—" : Math.abs(r.compare?.value ?? 0) < 1.5 && Math.abs(r.current.value) < 1.5 ? `${signed(r.delta * 100, 1)} 点` : `${signed(r.delta, 2)} 倍`;

/** Numbered links to the pages a claim was written from, in the order the document first cites them. */
function useCites(sources: ExplainerSource[], claims: Array<ExplainerClaim | null | undefined>) {
  return useMemo(() => {
    const cited = [...new Set(claims.flatMap(c => c?.sourceIds ?? []))].map(id => sources.find(s => s.id === id)).filter(s => s != null);
    const cite = (claim: ExplainerClaim | null | undefined) => claim ? <span className="cites">{claim.sourceIds.map(id => {
      const index = cited.findIndex(s => s.id === id);
      return index < 0 ? null : <a key={id} href={cited[index].url} target="_blank" rel="noopener noreferrer" title={cited[index].title}>{index + 1}</a>;
    })}</span> : null;
    return { cited, cite };
  }, [sources, claims]);
}

export function StagePill({ stage }: { stage: NarrativeStage }) {
  return <span className="stage-pill" data-stage={stage}>{STAGE_LABEL[stage]}</span>;
}
export function StatusDot({ status, title }: { status: NarrativeStatus; title?: string }) {
  return <i className="status-dot" data-status={status} title={title ?? STATUS_LABEL[status]} aria-label={STATUS_LABEL[status]} />;
}

/** A resolved figure beside its comparison, the same reading the lens gives a finding's evidence. */
function Figure({ r }: { r: ResolvedEvidence }) {
  return <span className="narrative-figure">
    <b data-trend={r.current.value < 0 && r.current.unit === "USD" ? "down" : undefined}>{formatValue(r.current)}</b>
    <small>{spanLabel(r.current)}</small>
    {r.guidance ? <em data-verdict={r.guidance.verdict}>{r.guidance.unit === "percent" && r.current.unit !== "percent" ? `同比 ${percent(r.guidance.measured)} · ` : ""}{VERDICT[r.guidance.verdict]}{r.compare ? `（指引 ${formatValue(r.compare)}）` : ""}</em>
      : r.compare ? <em data-trend={trend(r.delta)}>{r.compareLabel} {formatValue(r.compare)}{r.delta != null && <> · {r.current.unit === "percent" ? `${percent(r.delta)} 点` : r.current.unit === "ratio" ? ratioChange(r) : percent(r.delta)}</>}</em> : null}
  </span>;
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="narrative-empty">{children}</p>;
}

/** The checks a link or a business names, each with the figure it is bound to. */
function Checks({ checks, data, periods }: { checks: NarrativeCheck[]; data: FindingData; periods: string[] }) {
  if (!checks.length) return <Empty>这一环没有可用财报数字核验的条件；以披露进度为准。</Empty>;
  return <ul className="narrative-checks">{checks.map(c => { const r = resolveCheck(data, c, periods); return <li key={c.id} data-status={c.status}>
    <StatusDot status={c.status} />
    <span className="narrative-check-text"><span>{c.condition}</span>{r.resolved ? <Figure r={r.resolved} /> : c.ref ? <small className="narrative-pending">数字待披露</small> : null}</span>
    <span className="narrative-check-status">{STATUS_LABEL[c.status]}</span>
  </li>; })}</ul>;
}

/** The thesis as a chain: each link's premise, how far it is borne out, the evidence, what breaks it, and its checks. */
function Chain({ chain, index, data, periods, cite }: { chain: NarrativeLink[]; index: Map<string, NarrativeCheck>; data: FindingData; periods: string[]; cite: (c: ExplainerClaim) => ReactNode }) {
  if (!chain.length) return <Empty>材料未给出可核验的叙事链。</Empty>;
  return <ol className="narrative-chain">{chain.map((link, i) => <li key={link.id} data-status={link.status}>
    <header><StatusDot status={link.status} /><b>{i + 1}. {link.premise}</b><span className="narrative-link-status">{STATUS_LABEL[link.status]}</span></header>
    {link.evidence.length ? link.evidence.map((e, n) => <p key={n} className="dossier-prose">{e.text}{cite(e)}</p>) : <Empty>尚无已披露证据。</Empty>}
    <p className="narrative-failure"><b>失效条件</b>{link.failure}</p>
    {link.checkIds.length > 0 && <Checks checks={linkChecks(link, index)} data={data} periods={periods} />}
  </li>)}</ol>;
}

/**
 * The company's dossier when no business is picked: what it is, where it stands, its thesis as a
 * chain, where it sits in its industry, the checks, and each business with its stage. Every claim
 * carries its sources; every figure is resolved from the statements on stage.
 */
export function CompanyDossier({ narrative, data, periods, onPick }: { narrative: CompanyNarrative; data: FindingData; periods: string[]; onPick: (nodeId: string) => void }) {
  const claims = useMemo(() => [narrative.positioning, narrative.stageClaim, narrative.industry, ...(narrative.milestones ?? []).map(m => m.claim), ...(narrative.parties ?? []).map(p => p.claim), ...narrative.chain.flatMap(l => l.evidence)], [narrative]);
  const { cited, cite } = useCites(narrative.sources, claims);
  const index = useMemo(() => checkIndex(narrative), [narrative]);
  return <section className="dossier dossier--narrative" aria-label={`${narrative.companyName} 公司档案`}>
    <h3>{narrative.companyName}<StagePill stage={narrative.stage} /></h3>
    <p className="dossier-lede">{narrative.positioning.text}{cite(narrative.positioning)}</p>
    <p className="narrative-verdict"><b>判断</b>{narrative.verdict}</p>
    <DossierTabs label={narrative.companyName} sections={[
      ["叙事链", <Chain key="chain" chain={narrative.chain} index={index} data={data} periods={periods} cite={cite} />],
      ["行业位置", <div key="industry">
        <p className="dossier-prose">{narrative.industry.text}{cite(narrative.industry)}</p>
        <p className="dossier-prose"><b>所处阶段：</b>{narrative.stageClaim.text}{cite(narrative.stageClaim)}</p>
      </div>],
      ...(narrative.milestones?.length ? [["进度", <TimelineList key="ms" milestones={narrative.milestones} cite={cite} />] as [string, ReactNode]] : []),
      ...(narrative.parties?.length ? [["金主与合作方", <PartiesList key="parties" parties={narrative.parties} cite={cite} />] as [string, ReactNode]] : []),
      ["验证点", <Checks key="checks" checks={narrative.checks} data={data} periods={periods} />],
      ["各项业务", <ul key="businesses" className="narrative-businesses">{narrative.businesses.map(b => <li key={b.nodeId}><Button variant="unstyled" type="button" onClick={() => onPick(b.nodeId)}>
        <span className="narrative-business-name">{b.name}<StagePill stage={b.stage} /></span>
        <span className="narrative-business-verdict">{b.verdict}</span>
      </Button></li>)}</ul>],
    ]} />
    <ol className="sources sources--numbered">{cited.map(s => <li key={s.id}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}<span aria-hidden="true"> ↗</span></a></li>)}</ol>
  </section>;
}

/** The comparison as a grid: this business and each alternative graded on the same dimensions; a cell opens the material behind it. */
function Comparison({ comparison, name, cite }: { comparison: NonNullable<BusinessNarrative["comparison"]>; name: string; cite: (c: ExplainerClaim) => ReactNode }) {
  const [picked, setPicked] = useState<[number, number] | null>(null);
  const rows = [{ id: "self", name, cells: comparison.self, self: true }, ...comparison.alternatives.map(a => ({ ...a, self: false }))];
  const cell = picked ? rows[picked[0]]?.cells[picked[1]] : null;
  return <div className="narrative-compare">
    <p className="narrative-need"><b>同一需求</b>{comparison.need}</p>
    <div className="narrative-matrix-scroll"><table className="narrative-matrix">
      <thead><tr><th scope="col">方案</th>{comparison.dimensions.map(d => <th key={d} scope="col">{d}</th>)}</tr></thead>
      <tbody>{rows.map((row, r) => <tr key={row.id} data-self={row.self || undefined}>
        <th scope="row">{row.name}</th>
        {row.cells.map((c, d) => <td key={d}><Button variant="unstyled" type="button" className="narrative-cell" data-grade={c.grade} aria-pressed={picked?.[0] === r && picked[1] === d} title={c.claim.text} onClick={() => setPicked(picked?.[0] === r && picked[1] === d ? null : [r, d])}>{GRADE_LABEL[c.grade]}</Button></td>)}
      </tr>)}</tbody>
    </table></div>
    {cell ? <p className="dossier-prose narrative-cell-claim"><b>{rows[picked![0]].name} · {comparison.dimensions[picked![1]]}：</b>{cell.claim.text}{cite(cell.claim)}</p>
      : <p className="fine">评级只取自披露材料；「未比较」表示材料没有比较。点任一格查看依据。</p>}
  </div>;
}

function TimelineList({ milestones, cite }: { milestones: BusinessNarrative["milestones"]; cite: (c: ExplainerClaim) => ReactNode }) {
  if (!milestones.length) return <Empty>材料未披露里程碑。</Empty>;
  return <ol className="narrative-timeline">{[...milestones].sort((a, b) => a.date.localeCompare(b.date)).map(m => <li key={m.id} data-state={m.state}>
    <time dateTime={m.date}>{milestoneDate(m.date)}</time>
    <span className="narrative-milestone"><b>{m.label}</b><small>{MILESTONE_LABEL[m.state]}{m.state === "delayed" && m.originalDate ? ` · 原定 ${milestoneDate(m.originalDate)}` : ""}</small><span className="dossier-prose">{m.claim.text}{cite(m.claim)}</span></span>
  </li>)}</ol>;
}
function PartiesList({ parties, cite }: { parties: BusinessNarrative["parties"]; cite: (c: ExplainerClaim) => ReactNode }) {
  const roles = PARTY_ROLES.map(role => [role, parties.filter(p => p.role === role)] as const).filter(([, list]) => list.length);
  if (!roles.length) return <Empty>材料未披露出资方或客户。</Empty>;
  return <div className="narrative-parties">{roles.map(([role, list]) => <section key={role}><h4>{ROLE_LABEL[role]}</h4><ul className="dossier-products">{list.map((p, i) => <li key={i}><b>{p.name}</b>{p.claim.text}{cite(p.claim)}</li>)}</ul></section>)}</div>;
}

export type SectionKind = "timeline" | "parties" | "comparison" | "checks" | "chain";
const SECTION_TITLE: Record<SectionKind, string> = { timeline: "进度", parties: "金主与客户", comparison: "对照", checks: "验证点", chain: "叙事链" };

/**
 * One section of the dossier as a stage panel, where the composition put it: a business's
 * milestones, backers, comparison, checks or chain, or the company's chain and checks.
 */
export function SectionPanel({ kind, business, narrative, data, periods }: { kind: SectionKind; business: BusinessNarrative | null; narrative: CompanyNarrative; data: FindingData; periods: string[] }) {
  const claims = useMemo(() => business
    ? [...business.milestones.map(m => m.claim), ...business.parties.map(p => p.claim), ...(business.comparison ? [...business.comparison.self, ...business.comparison.alternatives.flatMap(a => a.cells)].map(c => c.claim) : []), ...business.chain.flatMap(l => l.evidence)]
    : [...(narrative.milestones ?? []).map(m => m.claim), ...(narrative.parties ?? []).map(p => p.claim), ...narrative.chain.flatMap(l => l.evidence)], [business, narrative]);
  const { cite } = useCites(narrative.sources, claims);
  const index = useMemo(() => checkIndex(narrative), [narrative]);
  const subject = business?.name ?? narrative.companyName;
  const body = kind === "timeline" ? <TimelineList milestones={business ? business.milestones : narrative.milestones ?? []} cite={cite} />
    : kind === "parties" ? <PartiesList parties={business ? business.parties : narrative.parties ?? []} cite={cite} />
    : kind === "comparison" ? (business?.comparison ? <Comparison comparison={business.comparison} name={business.name} cite={cite} /> : <Empty>材料没有把这项业务与替代方案作比较。</Empty>)
    : kind === "checks" ? <Checks checks={business ? [...new Map([...business.checks, ...business.chain.flatMap(l => linkChecks(l, index))].map(c => [c.id, c])).values()] : narrative.checks} data={data} periods={periods} />
    : <Chain chain={business ? business.chain : narrative.chain} index={index} data={data} periods={periods} cite={cite} />;
  return <figure className="figure figure--section"><figcaption><b>{subject} · {SECTION_TITLE[kind]}</b></figcaption>{body}</figure>;
}

/**
 * One business's dossier: stage and verdict up top, then the fixed reading order: what it can do,
 * how far it has got, who pays and who buys, how it compares, where it shows in the statements, and
 * what would prove or break it. A layer the material does not cover says so rather than disappearing.
 */
export function BusinessNarrativeDossier({ business, narrative, data, periods, parentName, extraSections = [] }: {
  business: BusinessNarrative; narrative: CompanyNarrative; data: FindingData; periods: string[]; parentName: string | null;
  /** The explainer's own sections for this business, appended after the narrative layers. */
  extraSections?: Array<[string, ReactNode]>;
}) {
  const claims = useMemo(() => [business.stageClaim, ...business.capabilities.map(c => c.claim), ...business.milestones.map(m => m.claim), ...business.parties.map(p => p.claim),
    ...(business.comparison ? [...business.comparison.self, ...business.comparison.alternatives.flatMap(a => a.cells)].map(c => c.claim) : []), ...business.chain.flatMap(l => l.evidence), ...business.checks.map(c => c.claim)], [business]);
  const { cited, cite } = useCites(narrative.sources, claims);
  const index = useMemo(() => checkIndex(narrative), [narrative]);
  const ties = useMemo(() => business.ties.map(t => ({ tie: t, resolved: resolveTie(data, t, periods) })), [business, data, periods]);
  const checks = useMemo(() => { const own = business.checks; const named = business.chain.flatMap(l => linkChecks(l, index)); return [...new Map([...own, ...named].map(c => [c.id, c])).values()]; }, [business, index]);
  return <section className="dossier dossier--narrative" aria-label={`${business.name} 业务档案`}>
    <h3>{parentName ? `${parentName} / ` : ""}{business.name}<StagePill stage={business.stage} /></h3>
    <p className="dossier-lede">{business.stageClaim.text}{cite(business.stageClaim)}</p>
    <p className="narrative-verdict"><b>判断</b>{business.verdict}</p>
    <DossierTabs label={business.name} sections={[
      ["能做什么", business.capabilities.length ? <ul key="caps" className="dossier-products">{business.capabilities.map((c, i) => <li key={i}>{c.label && <b>{c.label}</b>}{c.claim.text}{cite(c.claim)}</li>)}</ul> : <Empty key="caps">材料未说明产品能力。</Empty>],
      ["进度", <TimelineList key="ms" milestones={business.milestones} cite={cite} />],
      ["金主与客户", <PartiesList key="parties" parties={business.parties} cite={cite} />],
      ["对照", business.comparison ? <Comparison key="cmp" comparison={business.comparison} name={business.name} cite={cite} /> : <Empty key="cmp">材料没有把这项业务与替代方案作比较。</Empty>],
      ["财报体现", ties.length ? <ul key="ties" className="narrative-ties">{ties.map(({ tie, resolved }, i) => <li key={i}>
        {resolved ? <><span className="narrative-tie-label">{resolved.label}</span><Figure r={resolved} /></> : <span className="narrative-tie-label">{tie.label ?? "指标"}<small className="narrative-pending">数字待披露</small></span>}
        <span className="narrative-tie-meaning">{tie.meaning}</span>
      </li>)}</ul> : <Empty key="ties">这项业务的收入未单独披露，没有可直接对应的报表数字。</Empty>],
      ["验证点", <div key="verify">
        <Chain chain={business.chain} index={index} data={data} periods={periods} cite={cite} />
        {checks.length > 0 && business.chain.every(l => !l.checkIds.length) && <Checks checks={checks} data={data} periods={periods} />}
      </div>],
      ...extraSections,
    ]} />
    <ol className="sources sources--numbered">{cited.map(s => <li key={s.id}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}<span aria-hidden="true"> ↗</span></a></li>)}</ol>
  </section>;
}
