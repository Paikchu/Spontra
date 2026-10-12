import { Button } from "@/packages/web/src/ui/button";
import type { CSSProperties, KeyboardEvent, MouseEvent, ReactNode } from "react";
import type { TreeClaim, TreeNode, TreeRevenueModel, TreeSource } from "@/shared/analysis-contract/business-tree";
import { REVENUE_LABEL } from "@/shared/analysis-runtime/business-tree";
import { mindEdgePath, mindType, type MindItem, type MindMapLayout } from "./mindmap-layout";

/** One business the map hangs a breakdown from: the Sankey node, its name, and what the tree says about it. */
export type MindBranch = { node: string; label: string; summary: TreeClaim | null; revenue: TreeRevenueModel[]; nodes: TreeNode[] };
export type MindMapInput = { branches: MindBranch[]; sources: TreeSource[] };

const r = (v: number) => Math.round(v * 10) / 10;
const KIND = { line: "Product line", product: "Product" } as const;
const describe = (item: MindItem) => item.kind === "revenue"
  ? `Revenue model ${item.revenue.label}`
  : [item.node.name, item.node.gloss, item.node.revenue.length ? `Revenue model ${item.node.revenue.map(m => m.label).join(", ")}` : null].filter(Boolean).join(", ");

/**
 * The breakdown drawn in the chart's coordinates, left of the Sankey: a trunk from the business's label,
 * branches to its product lines and products, and money pills where the material says how each earns.
 */
export function MindLayer({ mind, k, title, colorOf, picked, onPick, onTip, onLeave }: {
  mind: MindMapLayout; k: number; title: string; colorOf: (anchor: string) => string; picked: string | null;
  onPick: (id: string) => void; onTip: (event: MouseEvent, item: MindItem) => void; onLeave: () => void;
}) {
  const t = mindType(k);
  const key = (e: KeyboardEvent, id: string) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(id); } };
  return <g className="fc-mind" aria-label="Business breakdown">
    <text className="fc-mind-caption" x={mind.caption.x} y={mind.caption.y + t.title}>
      <tspan className="fc-mind-title" style={{ fontSize: t.title }}>{title} · Business breakdown</tspan>
    </text>
    {mind.trunks.map(trunk => <path key={trunk.anchor} className="fc-mind-trunk" d={`M${r(trunk.x0)},${r(trunk.y)}H${r(trunk.x1)}`} style={{ "--c": colorOf(trunk.anchor) } as CSSProperties} />)}
    {mind.edges.map(e => <path key={e.id} className="fc-mind-edge" data-revenue={e.revenue || undefined} d={mindEdgePath(e)} style={{ "--c": colorOf(e.anchor), "--depth": e.depth } as CSSProperties} />)}
    {mind.items.map(item => {
      const style = { "--c": colorOf(item.anchor), "--depth": item.depth } as CSSProperties;
      const common = { "data-mind": "", role: "button", tabIndex: 0, "aria-label": describe(item), "aria-pressed": picked === item.id, style,
        onClick: () => onPick(item.id), onKeyDown: (e: KeyboardEvent) => key(e, item.id), onMouseMove: (e: MouseEvent) => onTip(e, item), onMouseLeave: onLeave };
      if (item.kind === "revenue") return <g key={item.id} className="fc-mind-item fc-mind-pill" data-picked={picked === item.id || undefined} {...common}>
        <rect x={item.x} y={item.y} width={item.w} height={item.h} rx={item.h / 2} />
        <text x={item.x + t.padX} y={item.y + item.h / 2 + t.pill * 0.36} style={{ fontSize: t.pill }}><tspan className="fc-mind-coin">¥</tspan><tspan dx={t.pill * 0.35}>{item.revenue.label}</tspan></text>
      </g>;
      return <g key={item.id} className="fc-mind-item fc-mind-node" data-kind={item.node.kind} data-picked={picked === item.id || undefined} {...common}>
        <rect x={item.x} y={item.y} width={item.w} height={item.h} rx={7 * k} />
        {mind.stacked && item.gloss ? <text x={item.x + t.padX} y={item.y + t.name * 1.3}>
          <tspan className="fc-mind-name" style={{ fontSize: t.name }}>{item.name}</tspan>
          <tspan className="fc-mind-gloss" x={item.x + t.padX} dy={t.gloss * 1.45} style={{ fontSize: t.gloss }}>{item.gloss}</tspan>
        </text> : <text x={item.x + t.padX} y={item.y + item.h / 2 + t.name * 0.36}>
          <tspan className="fc-mind-name" style={{ fontSize: t.name }}>{item.name}</tspan>
          {item.gloss && <tspan className="fc-mind-gloss" dx={t.inner} style={{ fontSize: t.gloss }}>{item.gloss}</tspan>}
        </text>}
      </g>;
    })}
  </g>;
}

/**
 * The picked node below the chart, where findings and reports open: what it is, how it earns, and the
 * passage that puts it in its business, each numbered against the tree's sources.
 */
export function MindLens({ item, branch, sources, onClose }: { item: MindItem; branch: MindBranch | undefined; sources: TreeSource[]; onClose: () => void }) {
  const node = item.kind === "node" ? item.node : item.owner;
  const name = node?.name ?? branch?.label ?? "";
  const revenue = node ? node.revenue : branch?.revenue ?? [];
  const highlight = item.kind === "revenue" ? item.revenue : null;
  const summary = node ? node.summary : branch?.summary ?? null;
  const claims: TreeClaim[] = [...(summary ? [summary] : []), ...revenue, ...(node?.anchor ? [node.anchor] : [])];
  const cited = [...new Set(claims.flatMap(c => c.sourceIds))].map(id => sources.find(s => s.id === id)).filter(s => s != null);
  const cite = (claim: TreeClaim): ReactNode => <span className="cites">{claim.sourceIds.map(id => {
    const index = cited.findIndex(s => s.id === id);
    return index < 0 ? null : <a key={id} href={cited[index]!.url} target="_blank" rel="noopener noreferrer" title={cited[index]!.title}>{index + 1}</a>;
  })}</span>;
  // A pill's own path ends with its owner; the lens is about the owner, so it names what the owner hangs from.
  const path = (item.kind === "revenue" ? item.path.slice(0, -1) : item.path).join(" / ");
  return <section className="lens mind-lens" aria-label={`${name} details`} key={item.id}>
    <header className="lens-head">
      <div className="lens-title">
        <b className="mind-lens-kind">{node ? KIND[node.kind] : "Business"}</b>
        <h2>{name}</h2>
        {node?.gloss && <span className="lens-basis">{node.gloss}</span>}
        {path && node && <span className="lens-basis">{path}</span>}
        {highlight && <span className="lens-basis">Revenue model · {highlight.label}</span>}
      </div>
      <div className="lens-nav"><Button variant="unstyled" type="button" className="lens-close" aria-label="Close details" onClick={onClose}>✕</Button></div>
    </header>
    <div className="lens-body">
      <div className="lens-text">
        {summary ? <p className="mind-lens-summary">{summary.text}{cite(summary)}</p> : <p className="mind-lens-empty">No description</p>}
        {revenue.length > 0 ? <ul className="mind-lens-revenue">{revenue.map((m, i) => <li key={i} data-active={m === highlight || undefined}><b>{m.label}</b><small>{REVENUE_LABEL[m.type]}</small><span>{m.text}{cite(m)}</span></li>)}</ul>
          : !node?.children.length && <p className="mind-lens-empty">Revenue model not disclosed</p>}
      </div>
      <div className="lens-text">
        {node?.anchor && <blockquote className="mind-lens-anchor"><small>Basis for placement</small>{node.anchor.text}{cite(node.anchor)}</blockquote>}
        {cited.length > 0 && <ol className="sources sources--numbered">{cited.map(s => <li key={s.id}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}<span aria-hidden="true"> ↗</span></a></li>)}</ol>}
      </div>
    </div>
  </section>;
}
