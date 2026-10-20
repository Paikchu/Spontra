/**
 * Lights one period of a rendered chart: its column's bars, and the value labels of that column in
 * place of the focused periods'. Null restores the resting state. Shared by the frame and the page's
 * inline fallback, so both answer a pointer the same way.
 */
export function applyHover(svg: SVGElement, period: number | null): void {
  if (period == null) svg.removeAttribute("data-hover"); else svg.setAttribute("data-hover", String(period));
  for (const col of svg.querySelectorAll<SVGElement>(".col")) { if (period != null && col.dataset.col === String(period)) col.setAttribute("data-hot", ""); else col.removeAttribute("data-hot"); }
  // At rest the chart's focused columns carry their figures; a pointer moves them to its column.
  for (const val of svg.querySelectorAll<SVGElement>(".val")) { if (period == null ? val.hasAttribute("data-focus") : val.dataset.col === String(period)) val.setAttribute("data-show", ""); else val.removeAttribute("data-show"); }
}

/** Wires pointer movement over a chart's columns to `onHover`; returns the teardown. */
export function watchHover(svg: SVGElement, onHover: (period: number | null) => void): () => void {
  const move = (e: Event) => { const hit = (e.target as Element | null)?.closest<SVGElement>("[data-col]"); onHover(hit?.dataset.col != null ? Number(hit.dataset.col) : null); };
  const leave = () => onHover(null);
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerleave", leave);
  return () => { svg.removeEventListener("pointermove", move); svg.removeEventListener("pointerleave", leave); };
}
