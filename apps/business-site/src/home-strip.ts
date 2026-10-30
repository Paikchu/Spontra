import type { HomeStatement } from "../../../shared/analysis-contract/home.ts";

/**
 * The home row's small revenue-to-profit flow: one bar of revenue on the left, and on the right the quarter's cost of
 * revenue, its other expenses and its net income, each joined to the revenue bar by a band. A loss hangs under the
 * right stack as a hollow band, since expenses then exceed revenue. Geometry only; the page paints it.
 */

export type StripBand = { kind: "cost" | "other" | "net"; sy: number; sh: number; ty: number; th: number };
export type Strip = { width: number; height: number; bar: number; bands: StripBand[]; loss: { y: number; h: number } | null };

export function stripOf(statement: HomeStatement, width = 120, height = 36, bar = 5): Strip | null {
  const revenue = Number(statement.revenue), net = Number(statement.net);
  const cost = statement.cost == null ? null : Number(statement.cost);
  if (!(revenue > 0) || !Number.isFinite(net)) return null;
  const share = (v: number) => Math.max(0, Math.min(1, v / revenue)) * height;
  const costShare = cost != null && cost > 0 ? Math.min(cost, revenue) : 0;
  const profit = Math.max(0, net);
  // What is neither cost of revenue nor profit: operating expenses, other items and tax.
  const other = Math.max(0, revenue - costShare - profit);
  const parts: Array<[StripBand["kind"], number]> = [["cost", costShare], ["other", other], ["net", profit]];
  const bands: StripBand[] = [];
  let y = 0;
  for (const [kind, value] of parts) {
    const h = share(value);
    if (h < 0.5) continue;
    bands.push({ kind, sy: y, sh: h, ty: y, th: h });
    y += h;
  }
  const loss = net < 0 ? { y: height, h: Math.max(2, Math.min(height * 0.6, share(-net))) } : null;
  return { width, height, bar, bands, loss };
}

/** A band from the revenue bar's right edge to the right stack, as the statement's own bands curve. */
export function stripBandPath(band: StripBand, strip: Strip): string {
  const x0 = strip.bar, x1 = strip.width - strip.bar, mid = (x0 + x1) / 2;
  const top = `M${x0},${band.sy} C${mid},${band.sy} ${mid},${band.ty} ${x1},${band.ty}`;
  const bottom = `L${x1},${band.ty + band.th} C${mid},${band.ty + band.th} ${mid},${band.sy + band.sh} ${x0},${band.sy + band.sh} Z`;
  return `${top} ${bottom}`;
}
